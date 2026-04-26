"""Optional fuzzy entity dedup — run infrequently (monthly)."""
import asyncio
import json

import numpy as np
from google import genai
from google.genai import types
from rich.console import Console
from rich.table import Table

from .config import Config
from .lightrag_client import LightRAGClient

console = Console()

_SIMILARITY_THRESHOLD = 0.92

_MERGE_PROMPT = """\
Are these two knowledge graph entities likely the same real-world entity?
Entity A: "{a}" — {desc_a}
Entity B: "{b}" — {desc_b}

Reply ONLY with JSON: {{"merge": true/false, "canonical": "preferred name"}}
"""


async def run_dedup(cfg: Config, dry_run: bool = False) -> None:
    client = LightRAGClient(cfg.lightrag_host, cfg.lightrag_storage_dir)
    genai_client = genai.Client(api_key=cfg.google_api_key)
    entities = client.read_entities()

    if len(entities) < 2:
        console.print("[yellow]Not enough entities to dedup.[/yellow]")
        return

    console.print(f"Embedding [bold]{len(entities)}[/bold] entities...")
    names = [e["name"] for e in entities]
    descs = [e.get("description", "") for e in entities]

    embeddings = await _embed_batch(genai_client, cfg.gemini_embedding_model, names)
    if not embeddings:
        return

    candidates = _find_candidates(names, embeddings, _SIMILARITY_THRESHOLD)
    console.print(f"Found [bold]{len(candidates)}[/bold] candidate pairs above {_SIMILARITY_THRESHOLD:.0%} similarity.")

    if not candidates:
        return

    merge_table = Table(title="Dedup candidates")
    merge_table.add_column("Entity A")
    merge_table.add_column("Entity B")
    merge_table.add_column("Similarity")
    merge_table.add_column("Merge?")

    confirmed_merges = []
    for i, (idx_a, idx_b, sim) in enumerate(candidates):
        a, b = names[idx_a], names[idx_b]
        decision = await _confirm_merge(genai_client, cfg.gemini_llm_cheap,
                                        a, descs[idx_a], b, descs[idx_b])
        merge_table.add_row(a, b, f"{sim:.3f}", "yes" if decision["merge"] else "no")
        if decision["merge"]:
            confirmed_merges.append((a, b, decision["canonical"]))

    console.print(merge_table)

    if dry_run:
        console.print(f"[dim]dry-run: {len(confirmed_merges)} merges proposed.[/dim]")
        return

    if confirmed_merges:
        console.print(f"\n[yellow]{len(confirmed_merges)} merges confirmed. "
                      "Manual LightRAG merge needed — see logs.[/yellow]")
        for a, b, canonical in confirmed_merges:
            console.print(f"  Merge [[{a}]] + [[{b}]] → [[{canonical}]]")

    await client.aclose()


async def _embed_batch(client, model: str, texts: list[str]) -> list[list[float]] | None:
    try:
        response = await asyncio.to_thread(
            client.models.embed_content,
            model=model,
            contents=texts,
        )
        return [e.values for e in response.embeddings]
    except Exception as exc:
        console.print(f"[red]Embedding failed: {exc}[/red]")
        return None


def _find_candidates(names: list[str], embeddings: list[list[float]],
                     threshold: float) -> list[tuple[int, int, float]]:
    mat = np.array(embeddings)
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    normalized = mat / np.where(norms == 0, 1, norms)
    sim_matrix = normalized @ normalized.T

    candidates = []
    n = len(names)
    for i in range(n):
        for j in range(i + 1, n):
            if sim_matrix[i, j] >= threshold and names[i].lower() != names[j].lower():
                candidates.append((i, j, float(sim_matrix[i, j])))

    candidates.sort(key=lambda x: x[2], reverse=True)
    return candidates[:50]  # cap at 50 pairs per run


async def _confirm_merge(client, model: str, a: str, desc_a: str,
                         b: str, desc_b: str) -> dict:
    prompt = _MERGE_PROMPT.format(a=a, desc_a=desc_a[:200], b=b, desc_b=desc_b[:200])
    try:
        response = await asyncio.to_thread(
            client.models.generate_content,
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                max_output_tokens=100,
            ),
        )
        return json.loads(response.text)
    except Exception:
        return {"merge": False, "canonical": a}
