"""rag — Stellium CLI."""
import asyncio
import json
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

console = Console()


def _cfg():
    from .config import load_config
    return load_config()


def _ent_hash(name: str) -> str:
    """Reproduce LightRAG's ent-{md5} ID — same formula as vault_sync._ent_hash."""
    import hashlib
    return "ent-" + hashlib.md5(name.encode("utf-8")).hexdigest()


def _write_stellium_highlight(cfg, stellium_data: dict) -> None:
    """Write visited nodes/edges to _meta/stellium_highlight.json for the Obsidian plugin.

    Lookup strategy (in order):
    1. Exact hash: _ent_hash(name) → kg_id in entity_file_map (preferred — same hash vault_sync uses).
    2. Lowercase entity_name → path (handles case variations).
    3. Lowercase + non-alnum stripped → path (handles whitespace/punctuation variations).
    """
    import datetime
    import re
    from .db import connect

    kg_to_path: dict[str, str] = {}      # kg_id → vault path
    lower_to_path: dict[str, str] = {}   # lowercase(entity_name) → vault path
    norm_to_path: dict[str, str] = {}    # alnum-only lowercase → vault path
    try:
        with connect(cfg.db_path) as conn:
            for row in conn.execute(
                "SELECT kg_id, entity_name, file_name FROM entity_file_map"
            ):
                path = f"entities/{row['file_name']}"
                if row["kg_id"]:
                    kg_to_path[row["kg_id"]] = path
                if row["entity_name"]:
                    lower_to_path[row["entity_name"].lower().strip()] = path
                    norm_to_path[re.sub(r"\W+", "", row["entity_name"]).lower()] = path
    except Exception:
        pass

    def _resolve(name: str) -> str | None:
        if not name:
            return None
        n = name.strip()
        return (
            kg_to_path.get(_ent_hash(n))
            or lower_to_path.get(n.lower())
            or norm_to_path.get(re.sub(r"\W+", "", n).lower())
        )

    raw_nodes = stellium_data.get("nodes", [])
    raw_edges = stellium_data.get("edges", [])

    nodes = list(dict.fromkeys(
        path for n in raw_nodes
        if n.get("id") and (path := _resolve(n["id"]))
    ))
    links = [
        [pa, pb]
        for e in raw_edges
        if (pa := _resolve(e.get("source", "")))
        and (pb := _resolve(e.get("target", "")))
    ]

    payload = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "nodes": nodes,
        "links": links,
    }
    dest = cfg.vault_path / "_meta" / "stellium_highlight.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    console.print(
        f"[dim]aurora: {len(nodes)}/{len(raw_nodes)} nodes resolved · "
        f"{len(links)}/{len(raw_edges)} edges resolved[/dim]"
    )
    if not raw_nodes and not raw_edges:
        keys = stellium_data.get("_raw_keys") or list(stellium_data.keys())
        console.print(f"[yellow]aurora: /query/data returned no entities/relationships. "
                      f"Top-level keys seen: {keys}[/yellow]")


@click.group()
def cli():
    """Stellium — personal knowledge system CLI."""


@cli.command()
@click.option("--source", "-s", type=click.Choice(["claude", "user"]), default=None,
              help="Ingest only from this source inbox.")
@click.option("--dry-run", is_flag=True, help="Preview without ingesting or moving files.")
def ingest(source, dry_run):
    """inbox → normalize → chunk → LightRAG → processed/"""
    from .ingest import run_ingest
    asyncio.run(run_ingest(_cfg(), source_filter=source, dry_run=dry_run))


@cli.command()
@click.option("--entities-only", is_flag=True)
@click.option("--sources-only", is_flag=True)
@click.option("--dry-run", is_flag=True)
@click.option("--clean", is_flag=True, help="Move orphaned notes to _meta/orphaned/.")
def sync(entities_only, sources_only, dry_run, clean):
    """LightRAG → Obsidian vault (.md files)."""
    from .vault_sync import run_sync
    run_sync(_cfg(), entities_only=entities_only, sources_only=sources_only,
             dry_run=dry_run, clean=clean)


@cli.command()
@click.argument("query_text")
@click.option("--mode", "-m",
              type=click.Choice(["auto", "local", "global", "hybrid", "naive", "mix"]),
              default="auto")
@click.option("--endpoint", "-e", type=click.Choice(["auto", "data", "synth"]), default="auto",
              help="data=structured/cheap, synth=LLM narrative. Default: agent decides.")
@click.option("--raw", is_flag=True, help="Print raw output as JSON.")
def query(query_text, mode, endpoint, raw):
    """Query the knowledge graph."""
    from .agent import GeminiAgent

    async def _run():
        agent = GeminiAgent(_cfg())
        try:
            result = await agent.query(query_text, mode=mode, endpoint=endpoint)
        finally:
            await agent.aclose()
        return result

    result = asyncio.run(_run())
    _write_stellium_highlight(_cfg(), result.get("stellium_data", {}))
    if raw:
        console.print_json(json.dumps(result))
    else:
        ep = result.get("endpoint", "?")
        console.print(f"\n[bold]Summary[/bold] (mode={result['mode']} endpoint={ep})\n")
        console.print(result["summary"])
        data = result.get("stellium_data", {})
        nodes = data.get("nodes", [])
        if nodes:
            console.print(f"\n[dim]{len(nodes)} nodes · {len(data.get('edges', []))} edges[/dim]")
        tok = result.get("tokens", {})
        if tok:
            from .token_tracker import TokenTracker
            tracker = TokenTracker()
            for op, u in tok.items():
                tracker.record(op, u["prompt"], u["completion"], model=u.get("model", ""))
            console.print()
            for line in tracker.summary_lines():
                console.print(f"[dim]{line}[/dim]")


@cli.command()
@click.argument("eval_file", type=click.Path(exists=True, path_type=Path))
@click.option("--mode", "-m",
              type=click.Choice(["auto", "local", "global", "hybrid", "naive", "mix"]),
              default="auto")
@click.option("--random", "random_pick", is_flag=True,
              help="Elegir una pregunta al azar del eval set.")
def eval(eval_file, mode, random_pick):
    """Evaluate retrieval quality against a YAML test set.

    EVAL_FILE: path to a YAML file with `cases: [{question, expected}]` entries.
    """
    from .eval import run_eval
    asyncio.run(run_eval(_cfg(), eval_file, mode=mode, random_pick=random_pick))


@cli.command()
@click.option("--dry-run", is_flag=True, help="Preview proposed merges without applying.")
def dedup(dry_run):
    """Optional fuzzy entity dedup (run monthly or when you notice duplicates)."""
    from .dedup import run_dedup
    asyncio.run(run_dedup(_cfg(), dry_run=dry_run))


@cli.command()
def stats():
    """Show ingestion + sync counts."""
    from .db import connect
    cfg = _cfg()
    if not cfg.db_path.exists():
        console.print("[yellow]sync_state.db not found. Run 'rag ingest' first.[/yellow]")
        return
    with connect(cfg.db_path) as conn:
        files = conn.execute("SELECT COUNT(*) FROM ingested_files").fetchone()[0]
        entities = conn.execute("SELECT COUNT(*) FROM entity_file_map").fetchone()[0]
        sources = conn.execute("SELECT COUNT(*) FROM source_file_map").fetchone()[0]
        origins = conn.execute(
            "SELECT origin, COUNT(*) as n FROM ingested_files GROUP BY origin"
        ).fetchall()
        strategies = conn.execute(
            "SELECT chunking_strategy, COUNT(*) as n FROM ingested_files GROUP BY chunking_strategy"
        ).fetchall()

    t = Table(title="Stellium Stats")
    t.add_column("Metric")
    t.add_column("Count", justify="right")
    t.add_row("Ingested files", str(files))
    t.add_row("Entities synced", str(entities))
    t.add_row("Sources synced", str(sources))
    for row in origins:
        t.add_row(f"  origin: {row['origin']}", str(row['n']))
    for row in strategies:
        t.add_row(f"  strategy: {row['chunking_strategy']}", str(row['n']))
    console.print(t)


@cli.command()
def status():
    """LightRAG server health + pending inbox counts."""
    from .lightrag_client import LightRAGClient
    cfg = _cfg()
    client = LightRAGClient(cfg.lightrag_host, cfg.lightrag_storage_dir)

    async def _check():
        ok = await client.health_check()
        await client.aclose()
        return ok

    healthy = asyncio.run(_check())
    server_status = "[green]online[/green]" if healthy else "[red]offline[/red]"
    console.print(f"LightRAG server ({cfg.lightrag_host}): {server_status}")

    _ensure_vault_structure(cfg.vault_path)

    for origin in ("claude", "user"):
        inbox = cfg.vault_path / "inbox" / origin
        count = sum(1 for f in inbox.iterdir() if f.is_file())
        console.print(f"inbox/{origin}: {count} pending file(s)")


@cli.command()
def tray():
    """Launch the Stellium system-tray app (PySide6)."""
    from .desktop.tray import main as tray_main
    raise SystemExit(tray_main())


@cli.command()
@click.option("--hard", is_flag=True, help="También borra LightRAG storage (re-indexa todo desde cero).")
def reset(hard):
    """Mueve processed/ de vuelta a inbox/ y limpia sync_state.db."""
    import shutil
    cfg = _cfg()

    moved = 0
    for origin in ("claude", "user"):
        src_dir = cfg.vault_path / "processed" / origin
        dst_dir = cfg.vault_path / "inbox" / origin
        dst_dir.mkdir(parents=True, exist_ok=True)
        if src_dir.exists():
            for f in src_dir.iterdir():
                if f.is_file():
                    shutil.move(str(f), dst_dir / f.name)
                    moved += 1

    if cfg.db_path.exists():
        cfg.db_path.unlink()
        console.print("[dim]sync_state.db eliminado[/dim]")

    if hard and cfg.lightrag_storage_dir.exists():
        shutil.rmtree(cfg.lightrag_storage_dir)
        console.print("[dim]LightRAG storage eliminado[/dim]")

    console.print(f"[green]Reset completo.[/green] {moved} archivo(s) devuelto(s) a inbox/")


def _ensure_vault_structure(vault_path) -> None:
    from pathlib import Path
    dirs = [
        "entities", "sources",
        "inbox/claude", "inbox/user",
        "processed/claude", "processed/user",
        "_meta/orphaned",
    ]
    for d in dirs:
        Path(vault_path / d).mkdir(parents=True, exist_ok=True)


if __name__ == "__main__":
    cli()
