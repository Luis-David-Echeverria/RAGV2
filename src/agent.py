"""Gemini query agent: rewrite → LightRAG → compress."""
import asyncio
import json
from typing import Any

from google import genai
from google.genai import errors as genai_errors
from google.genai import types

from .config import Config
from .lightrag_client import LightRAGClient
from .token_tracker import TokenTracker

_GEMINI_RETRIES = 4
_DEFAULT_LANGUAGE = "Spanish"


async def _gemini_call(fn, *args, **kwargs):
    """Run a blocking Gemini call in a thread, retrying on 503 with backoff."""
    for attempt in range(_GEMINI_RETRIES):
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except genai_errors.ServerError as exc:
            if attempt == _GEMINI_RETRIES - 1:
                raise
            await asyncio.sleep(2 ** (attempt + 1))
    raise RuntimeError("Gemini call failed after retries")

_REWRITE_PROMPT = """\
You are a query router for a personal knowledge system backed by a knowledge graph.

Given the user query, decide:

1. Rewrite the query in clear, concise English (for internal processing).
2. Rewrite the query in the same language as the original query (for knowledge graph retrieval).
3. Choose retrieval mode:
   - "local"  → specific entities, facts, names, direct relationships
   - "global" → broad patterns, themes, summaries across the full graph
   - "hybrid" → mixed: entities + broader context
   - "naive"  → simple similarity search, no knowledge graph (use for very specific verbatim lookups)
   - "mix"    → knowledge graph + vector search combined (best for most questions)
4. Choose endpoint:
   - "data"   → pure structured retrieval, no LLM synthesis inside LightRAG. Use when:
                 the question asks for a list, a graph, relationships, citations, or structured output.
                 Cheaper and faster.
   - "synth"  → LightRAG synthesizes a narrative answer with its LLM. Use when:
                 the question needs a reasoned, narrative, or explanatory answer.
5. Detect the language of the original query.

Respond ONLY with valid JSON:
{{"query_en": "string", "query_orig": "string", "mode": "local|global|hybrid|naive|mix", "endpoint": "data|synth", "language": "string"}}

User query: {query}
"""

_SUMMARIZE_STRUCTURED_PROMPT = """\
You are a knowledge assistant. Below is structured data retrieved from a knowledge graph.
Write a clear, concise summary in {language} based on this data. Under 500 words.

Data:
{structured_data}

Respond ONLY with valid JSON:
{{"summary": "summary in {language} here"}}
"""

class GeminiAgent:
    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._genai_client = genai.Client(api_key=cfg.google_api_key)
        self._lightrag = LightRAGClient(cfg.lightrag_host, cfg.lightrag_storage_dir)
        self.tokens = TokenTracker()

    async def query(self, query_text: str, mode: str = "auto", endpoint: str = "auto") -> dict[str, Any]:
        """Full pipeline. Returns {summary, stellium_data, mode, endpoint, query_en, tokens}."""
        self.tokens.reset()
        rewrite = await self._rewrite_query(query_text)
        rewrite["_original"] = query_text  # preserve for retrieval — original language matches index
        effective_mode = rewrite["mode"] if mode == "auto" else mode
        effective_endpoint = endpoint if endpoint != "auto" else rewrite.get("endpoint", "synth")

        if effective_endpoint == "data":
            return await self._run_data_path(rewrite, effective_mode)
        return await self._run_synth_path(rewrite, effective_mode)

    # ── Data path (cheap) ─────────────────────────────────────────────────────

    async def _run_data_path(self, rewrite: dict, mode: str) -> dict[str, Any]:
        """query/data → structured retrieval → Gemini summary only.
        Falls back to synth if data endpoint fails or returns no content."""
        try:
            raw = await self._lightrag.query_data(_retrieval_query(rewrite), mode=mode, top_k=self._cfg.retrieval_top_k)
        except Exception:
            return await self._run_synth_path(rewrite, mode)

        has_content = bool(
            raw.get("entities") or raw.get("chunks") or raw.get("relationships")
        )
        if not has_content:
            return await self._run_synth_path(rewrite, mode)

        stellium_data = _structured_to_stellium(raw)
        summary = await self._summarize_structured(raw, rewrite["language"])

        return {
            "summary": summary,
            "stellium_data": stellium_data,
            "mode": mode,
            "endpoint": "data",
            "query_en": rewrite["query_en"],
            "tokens": self.tokens.report(),
        }

    async def _summarize_structured(self, data: dict, language: str) -> str:
        compact = {
            "entities": [e.get("entity_name", e.get("id", "")) for e in data.get("entities", [])[:20]],
            "relationships": [
                f"{r.get('src_id', '')} → {r.get('tgt_id', '')} ({r.get('description', '')[:60]})"
                for r in data.get("relationships", [])[:15]
            ],
            "chunks": [c.get("content", "")[:200] for c in data.get("chunks", [])[:5]],
        }
        prompt = _SUMMARIZE_STRUCTURED_PROMPT.format(
            structured_data=json.dumps(compact, ensure_ascii=False),
            language=language,
        )
        response = await _gemini_call(
            self._genai_client.models.generate_content,
            model=self._cfg.gemini_llm_cheap,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                max_output_tokens=800,
            ),
        )
        self.tokens.record_response("summarize_structured", response, model=self._cfg.gemini_llm_cheap)
        try:
            return json.loads(response.text)["summary"]
        except Exception:
            return response.text[:1000]

    # ── Synth path (full) ─────────────────────────────────────────────────────

    async def _run_synth_path(self, rewrite: dict, mode: str) -> dict[str, Any]:
        """LightRAG /query (narrative) + /query/data (structured) in parallel.

        stellium_data comes DIRECTLY from /query/data — the same entity names
        and relationships LightRAG traversed during the query. Gemini is only
        used to translate the narrative answer; it never touches the graph data.
        """
        q = _retrieval_query(rewrite)
        synth_coro = self._lightrag.query(q, mode=mode, top_k=self._cfg.retrieval_top_k)
        data_coro  = self._lightrag.query_data(q, mode=mode, top_k=self._cfg.retrieval_top_k)

        raw_response, raw_data = await asyncio.gather(
            synth_coro, data_coro, return_exceptions=True
        )
        if isinstance(raw_response, Exception):
            raw_response = ""

        if isinstance(raw_data, Exception) or not isinstance(raw_data, dict):
            stellium_data: dict[str, Any] = {"nodes": [], "edges": [], "sources": []}
        else:
            stellium_data = _structured_to_stellium(raw_data)

        summary = await self._translate_summary(raw_response, rewrite["language"])

        return {
            "summary": summary,
            "stellium_data": stellium_data,
            "mode": mode,
            "endpoint": "synth",
            "query_en": rewrite["query_en"],
            "tokens": self.tokens.report(),
        }

    async def _translate_summary(self, raw_response: str, language: str) -> str:
        """Translate/compress LightRAG's narrative answer to the target language.
        Plain text — no JSON, no entity extraction (LightRAG already gave us those)."""
        if not raw_response:
            return ""
        prompt = (
            f"Translate and compress the following answer to {language}. "
            f"Keep it under 500 words. Be clear, factual, and faithful to the source. "
            f"Return ONLY the translated text — no preamble, no JSON, no markdown wrappers.\n\n"
            f"Answer:\n{raw_response}"
        )
        response = await _gemini_call(
            self._genai_client.models.generate_content,
            model=self._cfg.gemini_llm_cheap,
            contents=prompt,
            config=types.GenerateContentConfig(max_output_tokens=1500),
        )
        self.tokens.record_response("translate_summary", response, model=self._cfg.gemini_llm_cheap)
        return (response.text or "").strip() or raw_response[:2000]

    # ── Shared ────────────────────────────────────────────────────────────────

    async def _rewrite_query(self, query_text: str) -> dict:
        prompt = _REWRITE_PROMPT.format(query=query_text)
        response = await _gemini_call(
            self._genai_client.models.generate_content,
            model=self._cfg.gemini_llm_cheap,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                max_output_tokens=300,
            ),
        )
        self.tokens.record_response("rewrite_query", response, model=self._cfg.gemini_llm_cheap)
        try:
            return json.loads(response.text)
        except Exception:
            return {"query_en": query_text, "query_orig": query_text, "mode": "mix", "endpoint": "synth", "language": _DEFAULT_LANGUAGE}

    async def aclose(self):
        await self._lightrag.aclose()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _retrieval_query(rewrite: dict) -> str:
    """Use the original user text for LightRAG retrieval — it matches the indexed language."""
    return rewrite.get("_original") or rewrite["query_en"]


def _structured_to_stellium(data: dict) -> dict:
    """Convert /query/data response to stellium_data format.

    Defensive about both wrapper shape AND field names because different
    LightRAG versions vary:
      - wrapper: {entities,...} | {data:{...}} | {result:{...}} | {context:{...}}
      - entity:  entity_name | name | id
      - edge:    src_id/tgt_id | source/target | src/tgt
    Stores the human-readable entity name as id; the writer hashes it via
    _ent_hash to find the matching kg_id in entity_file_map.
    """
    # TODO: verify which wrapper/field shape the pinned LightRAG version actually
    # returns and prune unused branches — see docs/03_improvement_opportunities.md (B1).
    # Unwrap common wrappers — find the dict that actually contains entities.
    for key in ("data", "result", "context", "response"):
        if not data.get("entities") and not data.get("relationships"):
            nested = data.get(key)
            if isinstance(nested, dict) and (nested.get("entities") or nested.get("relationships")):
                data = nested
                break

    def _ent_name(e: dict) -> str:
        return (e.get("entity_name") or e.get("name") or e.get("id") or "").strip()

    def _src(r: dict) -> str:
        return (
            r.get("src_id") or r.get("source") or r.get("src")
            or r.get("entity1") or r.get("from") or ""
        ).strip()

    def _tgt(r: dict) -> str:
        return (
            r.get("tgt_id") or r.get("target") or r.get("tgt")
            or r.get("entity2") or r.get("to") or ""
        ).strip()

    nodes = [
        {
            "id": name,
            "type": e.get("entity_type") or e.get("type", "Unknown"),
            "description": e.get("description", ""),
        }
        for e in data.get("entities", [])
        if (name := _ent_name(e))
    ]
    edges = [
        {"source": s, "target": t, "label": (r.get("keywords") or r.get("description") or "")[:60]}
        for r in data.get("relationships", [])
        if (s := _src(r)) and (t := _tgt(r))
    ]
    sources = [
        {
            "id": c.get("id", ""),
            "title": c.get("file_path", c.get("id", "")),
            "excerpt": c.get("content", "")[:150],
        }
        for c in data.get("chunks", [])
    ]
    return {"nodes": nodes, "edges": edges, "sources": sources, "_raw_keys": list(data.keys())}
