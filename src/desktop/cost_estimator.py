"""Pre-flight cost estimation for queries and ingest.

Estimates are heuristic. We don't call Gemini's count_tokens (which would
itself cost a network round-trip) — instead we approximate at 4 chars per
token, which is close to GPT/Gemini tokenizers for English/Spanish prose.
The output is a *range*, not a precise number: enough to catch runaway
operations, not enough to bill from.

Conventions in this module:
- "smart" model = `cfg.gemini_llm_smart` (used for routing rewrite + summary)
- "cheap" model = `cfg.gemini_llm_cheap` (used for the rewrite when "smart"
   already drives summary)
- "embed" model = `cfg.gemini_embedding_model`
- LightRAG-internal LLM calls (entity extraction, keyword extraction,
   reranker) are billed by the same model the server uses (LLM_MODEL /
   RERANK_MODEL) and we approximate them based on retrieved sizes.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from . import pricing


_CHARS_PER_TOKEN = 4  # heuristic — Gemini tokenizer is close to this for prose


def chars_to_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, len(text) // _CHARS_PER_TOKEN)


@dataclass
class CostLine:
    op: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    cost_usd: float


@dataclass
class CostEstimate:
    total_usd: float = 0.0
    low_usd: float = 0.0
    high_usd: float = 0.0
    lines: list[CostLine] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def add(self, line: CostLine) -> None:
        self.lines.append(line)
        self.total_usd += line.cost_usd

    def finalize(self, low_mult: float = 0.7, high_mult: float = 1.5) -> None:
        """Apply a generic low/high band around the central estimate."""
        self.low_usd = self.total_usd * low_mult
        self.high_usd = self.total_usd * high_mult

    def format_brief(self) -> str:
        return f"≈ ${self.total_usd:.4f} (range ${self.low_usd:.4f}–${self.high_usd:.4f})"

    def format_detailed(self) -> str:
        rows = [
            f"{l.op:<26} {l.model:<28} {l.prompt_tokens:>7}p / {l.completion_tokens:>6}c → ${l.cost_usd:.5f}"
            for l in self.lines
        ]
        rows.append("-" * 80)
        rows.append(f"Total ≈ ${self.total_usd:.4f}  (range ${self.low_usd:.4f} – ${self.high_usd:.4f})")
        if self.notes:
            rows.append("")
            rows.extend(f"• {n}" for n in self.notes)
        return "\n".join(rows)


# ── Query estimation ──────────────────────────────────────────────────────────

def estimate_query(query_text: str, cfg) -> CostEstimate:
    """Estimate the full pipeline: rewrite → LightRAG retrieve → summarize → translate."""
    est = CostEstimate()

    cheap = cfg.gemini_llm_cheap
    smart = cfg.gemini_llm_smart
    lr_model = os.environ.get("LLM_MODEL", smart)
    rerank_model = os.environ.get("RERANK_MODEL", "jina-reranker-v2-base-multilingual")
    rerank_enabled = bool(os.environ.get("RERANK_BINDING"))
    top_k = int(getattr(cfg, "retrieval_top_k", 15))

    q_tok = chars_to_tokens(query_text)

    # 1) Rewrite (cheap model). Static prompt ~280 tokens + query echo.
    rw_prompt = 280 + q_tok
    rw_completion = 100  # tight JSON
    line = CostLine("rewrite", cheap, rw_prompt, rw_completion,
                    pricing.cost_for(cheap, rw_prompt, rw_completion))
    est.add(line)

    # 2) LightRAG /query/data internal LLM calls. The server runs at least
    #    one LLM call to extract keywords/entities and traverse the graph.
    #    Cost grows roughly with top_k.
    lr_prompt = 500 + 60 * top_k
    lr_completion = 200 + 20 * top_k
    line = CostLine("lightrag-internal", lr_model, lr_prompt, lr_completion,
                    pricing.cost_for(lr_model, lr_prompt, lr_completion))
    est.add(line)

    # 3) Reranker (if active). Jina charges by total tokens. The candidate
    #    pool is roughly top_k chunks * ~chunk_size.
    if rerank_enabled:
        rr_tokens = 350 * top_k
        line = CostLine("rerank", rerank_model, rr_tokens, 0,
                        pricing.cost_for(rerank_model, rr_tokens, 0))
        est.add(line)

    # 4) Summarize structured data (smart model). Input scales with top_k.
    sum_prompt = 600 + 200 * top_k  # entities + relationships + chunks list
    sum_completion = 600  # under 500 words ≈ ~600 tokens
    line = CostLine("summary", smart, sum_prompt, sum_completion,
                    pricing.cost_for(smart, sum_prompt, sum_completion))
    est.add(line)

    # 5) Translation back to original language (cheap model). Skipped if
    #    detected language was already English; we conservatively include it.
    tr_prompt = 80 + sum_completion
    tr_completion = sum_completion
    line = CostLine("translate", cheap, tr_prompt, tr_completion,
                    pricing.cost_for(cheap, tr_prompt, tr_completion))
    est.add(line)

    if not rerank_enabled:
        est.notes.append("Reranker is OFF in .env — quality slightly lower, ~30% cheaper.")
    est.notes.append(
        f"Retrieval top_k = {top_k}. Lower top_k via Settings to drop summary cost linearly."
    )

    est.finalize()
    return est


# ── Ingest estimation ────────────────────────────────────────────────────────

_INGESTABLE_EXTENSIONS = {
    ".md", ".txt", ".py", ".js", ".ts", ".json", ".yaml", ".yml",
    ".csv", ".pdf", ".docx",
}


def _walk_inbox(vault_path: Path, source_filter: str | None) -> Iterable[Path]:
    sources = ("claude", "user") if source_filter is None else (source_filter,)
    for src in sources:
        d = vault_path / "inbox" / src
        if not d.exists():
            continue
        for f in d.iterdir():
            if f.is_file() and f.suffix.lower() in _INGESTABLE_EXTENSIONS:
                yield f


def estimate_ingest(cfg, source_filter: str | None = None) -> CostEstimate:
    """Estimate cost of running `rag ingest` on the current inbox.

    For each pending file we approximate:
    - Total input tokens = file bytes / 4 (rough chars→tokens)
    - n_chunks = ceil(total_tokens / chunk_max_tokens)
    - Per chunk: entity extraction (LightRAG smart model) → ~chunk + 30%
                 embedding (cheap, embedding model) → chunk tokens, no completion
    """
    est = CostEstimate()
    chunk_max = int(getattr(cfg, "chunk_max_tokens", 4000))
    embed_model = cfg.gemini_embedding_model
    lr_model = os.environ.get("LLM_MODEL", cfg.gemini_llm_smart)

    files = list(_walk_inbox(cfg.vault_path, source_filter))
    if not files:
        est.notes.append("No pending files in inbox/. Nothing to ingest.")
        est.finalize()
        return est

    total_input_tokens = 0
    total_chunks = 0
    for f in files:
        try:
            size = f.stat().st_size
        except OSError:
            continue
        # Binary-ish formats (pdf, docx) compress text — bytes overstate tokens.
        # Use a smaller divisor so the estimate isn't wildly conservative.
        divisor = 4 if f.suffix.lower() not in {".pdf", ".docx"} else 8
        toks = max(1, size // divisor)
        total_input_tokens += toks
        n_chunks = max(1, (toks + chunk_max - 1) // chunk_max)
        total_chunks += n_chunks

    extract_prompt = total_input_tokens
    extract_completion = int(total_input_tokens * 0.35)
    line = CostLine(
        "entity-extract", lr_model, extract_prompt, extract_completion,
        pricing.cost_for(lr_model, extract_prompt, extract_completion),
    )
    est.add(line)

    embed_tokens = total_input_tokens
    line = CostLine(
        "embed", embed_model, embed_tokens, 0,
        pricing.cost_for(embed_model, embed_tokens, 0),
    )
    est.add(line)

    est.notes.append(
        f"{len(files)} file(s) · ~{total_chunks} chunk(s) at chunk_max={chunk_max} tokens."
    )
    est.notes.append(
        "PDF/DOCX token counts are underestimated — extracted text is shorter than file size."
    )

    est.finalize(low_mult=0.6, high_mult=1.7)
    return est
