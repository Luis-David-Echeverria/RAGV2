"""HTTP client for LightRAG REST API + storage file reader."""
import asyncio
import json
import time
from pathlib import Path

import httpx

_POLL_INTERVAL = 5   # seconds between status checks
_MAX_RETRIES   = 4   # retries on failure before giving up


class LightRAGClient:
    def __init__(self, host: str, storage_dir: Path):
        self.host = host.rstrip("/")
        self.storage_dir = Path(storage_dir)
        self._client = httpx.AsyncClient(timeout=120.0)

    async def health_check(self) -> bool:
        try:
            r = await self._client.get(f"{self.host}/health")
            return r.status_code == 200
        except Exception:
            return False

    async def insert(self, text: str, doc_id: str) -> str:
        """Insert a single document/chunk. Returns doc_id on success."""
        payload = {"text": text, "id": doc_id}
        await self._post("/documents/text", payload)
        return doc_id

    async def insert_chunks(self, chunks: list[str], base_doc_id: str) -> list[str]:
        """Insert pre-chunked content. Uses batch endpoint if available, falls back to serial."""
        ids = [f"{base_doc_id}_c{i:04d}" for i in range(len(chunks))]
        payload = {
            "texts": chunks,
            "file_sources": ids,
        }
        await self._post("/documents/texts", payload)
        return ids

    async def query(self, query_text: str, mode: str = "hybrid", top_k: int = 60) -> str:
        """Query with LLM synthesis. Returns synthesized text response."""
        payload = {"query": query_text, "mode": mode, "top_k": top_k}
        r = await self._post_raw("/query", payload)
        data = r.json()
        if isinstance(data, dict):
            return data.get("response", data.get("data", str(data)))
        return str(data)

    async def query_data(self, query_text: str, mode: str = "hybrid", top_k: int = 60) -> dict:
        """Pure data retrieval — no LLM call inside LightRAG.
        Returns structured {entities, relationships, chunks, references, metadata}."""
        payload = {"query": query_text, "mode": mode, "top_k": top_k}
        r = await self._post_raw("/query/data", payload)
        return r.json()

    async def delete_document(self, doc_id: str) -> None:
        await self._client.delete(f"{self.host}/documents/{doc_id}")

    async def insert_chunks_and_wait(self, chunks: list[str], base_doc_id: str) -> str:
        """Insert chunks, poll until processed, retry on failure. Returns final status."""
        for attempt in range(_MAX_RETRIES):
            ids = await self.insert_chunks(chunks, base_doc_id)
            status = await self._poll_until_done(base_doc_id)
            if status == "processed":
                return "processed"
            if status in ("failed", "timeout"):
                wait = 2 ** (attempt + 1)
                await asyncio.sleep(wait)
                # Clean up failed doc before retrying
                try:
                    statuses = await self._get_document_statuses()
                    for doc in statuses.get("failed", []):
                        if doc.get("file_path", "").startswith(base_doc_id):
                            await self.delete_document(doc["id"])
                except Exception:
                    pass
        return "failed"

    async def _get_document_statuses(self) -> dict[str, list[dict]]:
        try:
            r = await self._client.get(f"{self.host}/documents")
            return r.json().get("statuses", {})
        except Exception:
            return {}

    async def _poll_until_done(self, base_doc_id: str, timeout: int = 180) -> str:
        deadline = time.time() + timeout
        while time.time() < deadline:
            statuses = await self._get_document_statuses()
            for status_key, docs in statuses.items():
                for doc in docs:
                    if doc.get("file_path", "").startswith(base_doc_id):
                        return status_key  # "processed" | "failed" | ...
            await asyncio.sleep(_POLL_INTERVAL)
        return "timeout"

    # ── Storage file readers ─────────────────────────────────────────────────

    def read_entities(self) -> list[dict]:
        """Read entities from LightRAG JSON storage. Returns list of entity dicts."""
        # Try networkx graphml first (most complete)
        graphml = self.storage_dir / "graph_chunk_entity_relation.graphml"
        if graphml.exists():
            return self._entities_from_graphml(graphml)
        # Fallback: scan vdb_entities.json
        vdb = self.storage_dir / "vdb_entities.json"
        if vdb.exists():
            return self._entities_from_vdb(vdb)
        return []

    def read_relations(self) -> list[dict]:
        graphml = self.storage_dir / "graph_chunk_entity_relation.graphml"
        if graphml.exists():
            return self._relations_from_graphml(graphml)
        return []

    def read_documents(self) -> dict[str, str]:
        """Returns {doc_id: content_text}."""
        kv = self.storage_dir / "kv_store_full_docs.json"
        if not kv.exists():
            return {}
        data = json.loads(kv.read_text(encoding="utf-8"))
        result = {}
        for doc_id, value in data.items():
            if isinstance(value, dict):
                result[doc_id] = value.get("content", "")
            else:
                result[doc_id] = str(value)
        return result

    def read_chunks(self) -> dict[str, dict]:
        """Returns {chunk_id: {content, file_path, full_doc_id}}."""
        kv = self.storage_dir / "kv_store_text_chunks.json"
        if not kv.exists():
            return {}
        data = json.loads(kv.read_text(encoding="utf-8"))
        return {
            k: {
                "content": v.get("content", ""),
                "file_path": v.get("file_path", ""),
                "full_doc_id": v.get("full_doc_id", ""),
            }
            for k, v in data.items() if isinstance(v, dict)
        }

    def _entities_from_graphml(self, path: Path) -> list[dict]:
        import networkx as nx
        G = nx.read_graphml(str(path))
        entities = []
        for node_id, attrs in G.nodes(data=True):
            entities.append({
                "id": node_id,
                "name": attrs.get("entity_name", node_id),
                "entity_type": attrs.get("entity_type", "Unknown"),
                "description": attrs.get("description", ""),
                "source_ids": attrs.get("source_id", "").split("<SEP>") if attrs.get("source_id") else [],
            })
        return entities

    def _relations_from_graphml(self, path: Path) -> list[dict]:
        import networkx as nx
        G = nx.read_graphml(str(path))
        relations = []
        for u, v, attrs in G.edges(data=True):
            relations.append({
                "source": u,
                "target": v,
                "description": attrs.get("description", ""),
                "keywords": attrs.get("keywords", ""),
            })
        return relations

    def _entities_from_vdb(self, path: Path) -> list[dict]:
        data = json.loads(path.read_text(encoding="utf-8"))
        entities = []
        for entry in data.get("data", []):
            meta = entry.get("__meta__", entry)
            entities.append({
                "id": meta.get("entity_name", ""),
                "name": meta.get("entity_name", ""),
                "entity_type": meta.get("entity_type", "Unknown"),
                "description": meta.get("description", ""),
                "source_ids": [],
            })
        return entities

    # ── Internal ──────────────────────────────────────────────────────────────

    async def _post(self, path: str, payload: dict) -> None:
        await self._post_raw(path, payload)

    async def _post_raw(self, path: str, payload: dict) -> httpx.Response:
        last_exc = None
        for attempt in range(5):
            try:
                r = await self._client.post(f"{self.host}{path}", json=payload)
                r.raise_for_status()
                return r
            except httpx.HTTPStatusError as exc:
                # 5xx = server error, no point retrying immediately
                if exc.response.status_code >= 500:
                    raise
                last_exc = exc
                await asyncio.sleep(2 ** attempt)
            except httpx.RequestError as exc:
                last_exc = exc
                await asyncio.sleep(2 ** attempt)
        raise RuntimeError(f"LightRAG request failed after 5 retries: {last_exc}") from last_exc

    async def aclose(self):
        await self._client.aclose()
