"""rag eval — query-quality evaluation against a YAML test set."""
from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path
from typing import Any

import yaml
from rich.console import Console
from rich.table import Table

from .agent import GeminiAgent
from .config import Config
from .token_tracker import TokenTracker

console = Console()

# ── Metrics ──────────────────────────────────────────────────────────────────

def _tokenize(text: str) -> set[str]:
    return set(re.findall(r"\b\w+\b", text.lower()))


def _f1(predicted: str, expected: str) -> float:
    pred_toks = _tokenize(predicted)
    exp_toks = _tokenize(expected)
    if not exp_toks:
        return 0.0
    overlap = pred_toks & exp_toks
    precision = len(overlap) / len(pred_toks) if pred_toks else 0.0
    recall = len(overlap) / len(exp_toks)
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def _entity_coverage(predicted: str, stellium_data: dict) -> float:
    """Fraction of returned graph nodes whose name appears in the summary."""
    nodes = stellium_data.get("nodes", [])
    if not nodes:
        return 0.0
    pred_lower = predicted.lower()
    covered = sum(1 for n in nodes if n.get("id", "").lower() in pred_lower)
    return covered / len(nodes)


# ── Runner ────────────────────────────────────────────────────────────────────

async def run_eval(cfg: Config, eval_file: Path, mode: str = "auto", random_pick: bool = False) -> None:
    if not eval_file.exists():
        console.print(f"[red]Eval file not found: {eval_file}[/red]")
        return

    with eval_file.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh)

    cases: list[dict] = data.get("cases", [])
    if not cases:
        console.print("[yellow]No test cases found in eval file (expected 'cases' list).[/yellow]")
        return

    if random_pick:
        import random
        cases = [random.choice(cases)]
        console.print(f"[dim]--random: seleccionado 1 caso de {len(data.get('cases', []))}[/dim]\n")

    console.print(f"Running [bold]{len(cases)}[/bold] eval cases (mode={mode})...\n")

    agent = GeminiAgent(cfg)
    results: list[dict[str, Any]] = []

    try:
        for i, case in enumerate(cases, 1):
            question = case.get("question", "")
            expected = case.get("expected", "")
            if not question:
                continue

            console.print(f"[dim][{i}/{len(cases)}][/dim] {question[:80]}")
            t0 = time.perf_counter()
            try:
                result = await agent.query(question, mode=mode)
            except Exception as exc:
                elapsed = time.perf_counter() - t0
                console.print(f"  [red]error: {exc}[/red]")
                results.append({
                    "question": question,
                    "expected": expected,
                    "summary": f"[ERROR: {exc}]",
                    "f1": None,
                    "entity_coverage": 0.0,
                    "nodes": 0,
                    "edges": 0,
                    "tokens_total": 0,
                    "tokens_raw": {},
                    "latency_s": round(elapsed, 1),
                    "endpoint": "error",
                    "mode": "—",
                })
                continue
            elapsed = time.perf_counter() - t0

            summary = result.get("summary", "")
            stellium_data = result.get("stellium_data", {})
            tokens = result.get("tokens", {})
            total_tokens = sum(v.get("total", 0) for v in tokens.values())

            f1 = _f1(summary, expected) if expected else None
            ecov = _entity_coverage(summary, stellium_data)

            results.append({
                "question": question,
                "expected": expected,
                "summary": summary,
                "f1": f1,
                "entity_coverage": ecov,
                "nodes": len(stellium_data.get("nodes", [])),
                "edges": len(stellium_data.get("edges", [])),
                "tokens_total": total_tokens,
                "tokens_raw": tokens,
                "latency_s": round(elapsed, 1),
                "endpoint": result.get("endpoint", "?"),
                "mode": result.get("mode", "?"),
            })
    finally:
        await agent.aclose()

    _print_results(results)


def _print_results(results: list[dict]) -> None:
    # ── Per-case detail ───────────────────────────────────────────────────────
    for i, r in enumerate(results, 1):
        f1_str = f"F1={r['f1']:.2f}" if r["f1"] is not None else "F1=—"
        ecov_str = f"cov={r['entity_coverage']:.2f}"
        meta = f"[dim]{f1_str}  {ecov_str}  {r['latency_s']}s  {r['endpoint']}[/dim]"

        console.print(f"\n[bold cyan]#{i}[/bold cyan] {r['question']}")
        console.print(meta)

        tok = r.get("tokens_raw", {})
        if tok:
            tracker = TokenTracker()
            for op, u in tok.items():
                tracker.record(op, u["prompt"], u["completion"], model=u.get("model", ""))
            for line in tracker.summary_lines():
                console.print(f"[dim]{line}[/dim]")

        if r["expected"]:
            console.print(f"[green]✓ Esperado:[/green] [dim]{r['expected'].strip()}[/dim]")

        console.print(f"[yellow]→ Respuesta:[/yellow] {r['summary'].strip()}")

    # ── Summary table ─────────────────────────────────────────────────────────
    console.print()
    t = Table(title="Resumen de métricas", show_lines=True)
    t.add_column("#", width=3)
    t.add_column("Pregunta", max_width=38)
    t.add_column("F1", justify="right", width=6)
    t.add_column("Cov", justify="right", width=6)
    t.add_column("Nodes", justify="right", width=6)
    t.add_column("Tokens", justify="right", width=7)
    t.add_column("Lat(s)", justify="right", width=7)
    t.add_column("EP", width=6)

    ok = [r for r in results if r["endpoint"] != "error"]
    err = [r for r in results if r["endpoint"] == "error"]

    f1_values = [r["f1"] for r in ok if r["f1"] is not None]
    ecov_values = [r["entity_coverage"] for r in ok]

    for i, r in enumerate(results, 1):
        f1_str = f"{r['f1']:.2f}" if r["f1"] is not None else "[dim]—[/dim]"
        row_style = "red" if r["endpoint"] == "error" else ""
        t.add_row(
            str(i),
            r["question"][:38],
            f1_str,
            f"{r['entity_coverage']:.2f}",
            str(r["nodes"]),
            str(r["tokens_total"]),
            str(r["latency_s"]),
            r["endpoint"],
            style=row_style,
        )

    console.print(t)

    completed = len(ok)
    console.print(f"\nCompletados: [bold]{completed}/{len(results)}[/bold]" +
                  (f"  [red]{len(err)} errores[/red]" if err else ""))

    if f1_values:
        avg_f1 = sum(f1_values) / len(f1_values)
        console.print(f"Avg F1 (lexical overlap): [bold]{avg_f1:.3f}[/bold]  [dim](solo casos OK)[/dim]")
    avg_ecov = sum(ecov_values) / len(ecov_values) if ecov_values else 0.0
    console.print(f"Avg entity coverage:       [bold]{avg_ecov:.3f}[/bold]  [dim](solo casos OK)[/dim]")

    avg_lat = sum(r["latency_s"] for r in ok) / len(ok) if ok else 0
    total_tok = sum(r["tokens_total"] for r in ok)
    console.print(f"Avg latency:               [bold]{avg_lat:.1f}s[/bold]  [dim](solo casos OK)[/dim]")
    console.print(f"Total tokens used:         [bold]{total_tok}[/bold]")
