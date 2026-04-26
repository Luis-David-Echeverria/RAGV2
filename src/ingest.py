"""inbox → normalize → chunk → LightRAG → processed/"""
import asyncio
import hashlib
import shutil
from datetime import datetime, timezone
from pathlib import Path

from rich.console import Console
from rich.progress import track

from .chunkers import chunk_file
from .config import Config
from .db import init_db, is_ingested, record_ingested
from .lightrag_client import LightRAGClient
from .normalizer import load_aliases, normalize_text

console = Console()

SUPPORTED_EXTENSIONS = {
    ".md", ".txt", ".py", ".js", ".ts", ".jsx", ".tsx",
    ".json", ".yaml", ".yml", ".csv", ".tsv", ".pdf", ".docx",
}


async def run_ingest(cfg: Config, source_filter: str | None = None, dry_run: bool = False) -> None:
    init_db(cfg.db_path)
    aliases = load_aliases(cfg.aliases_path)
    client = LightRAGClient(cfg.lightrag_host, cfg.lightrag_storage_dir)

    if not await client.health_check():
        console.print("[red]LightRAG server not reachable. Start with: lightrag-server[/red]")
        return

    origins = _resolve_origins(source_filter)
    files = _collect_files(cfg.vault_path, origins)

    if not files:
        console.print("[yellow]No files to ingest.[/yellow]")
        return

    console.print(f"Found [bold]{len(files)}[/bold] file(s) to process.")

    ingested = skipped = failed = 0
    for file_path, origin in track(files, description="Ingesting..."):
        try:
            result = await _process_file(file_path, origin, cfg, aliases, client, dry_run)
            if result == "ingested":
                ingested += 1
            elif result == "skipped":
                skipped += 1
        except Exception as exc:
            console.print(f"[red]Error: {file_path.name}: {exc}[/red]")
            failed += 1

    await client.aclose()
    console.print(
        f"\n[green]Done.[/green] ingested={ingested} skipped={skipped} failed={failed}"
        + (" [dim](dry run)[/dim]" if dry_run else "")
    )


def _resolve_origins(source_filter: str | None) -> list[str]:
    if source_filter == "claude":
        return ["claude"]
    if source_filter == "user":
        return ["user"]
    return ["claude", "user"]


def _collect_files(vault_path: Path, origins: list[str]) -> list[tuple[Path, str]]:
    files = []
    for origin in origins:
        inbox = vault_path / "inbox" / origin
        if not inbox.exists():
            continue
        for f in inbox.iterdir():
            if f.is_file() and f.suffix.lower() in SUPPORTED_EXTENSIONS:
                files.append((f, origin))
    return files


async def _process_file(
    file_path: Path, origin: str, cfg: Config,
    aliases: dict, client: LightRAGClient, dry_run: bool,
) -> str:
    content_hash = _hash_file(file_path)

    if is_ingested(cfg.db_path, file_path.name, content_hash):
        return "skipped"

    # Read raw bytes for binary files, text for others
    if file_path.suffix.lower() in (".pdf", ".docx"):
        raw_text = None  # chunker reads the file directly
    else:
        raw_text = file_path.read_text(encoding="utf-8", errors="replace")

    # Chunk
    chunks, strategy = chunk_file(file_path)

    # Normalize each chunk (text replacement only, zero LLM calls)
    chunks = [normalize_text(c, aliases) for c in chunks]

    base_doc_id = f"{origin}_{file_path.stem}_{content_hash[:8]}"

    if dry_run:
        console.print(
            f"[dim]dry-run[/dim] {file_path.name}: {len(chunks)} chunks, strategy={strategy}"
        )
        return "ingested"

    # Insert to LightRAG + wait for processing (with retry on 503)
    status = await client.insert_chunks_and_wait(chunks, base_doc_id)

    if status != "processed":
        console.print(f"[red]Failed after retries: {file_path.name} (status={status})[/red]")
        return "failed"

    # Move to processed/ only when LightRAG confirmed success
    processed_dir = cfg.vault_path / "processed" / origin
    processed_dir.mkdir(parents=True, exist_ok=True)
    dest = processed_dir / file_path.name
    if dest.exists():
        dest = processed_dir / f"{file_path.stem}_{content_hash[:6]}{file_path.suffix}"
    shutil.move(str(file_path), dest)

    # Track in DB
    record_ingested(
        cfg.db_path,
        file_name=file_path.name,
        original_path=str(file_path),
        origin=origin,
        file_type=file_path.suffix,
        content_hash=content_hash,
        chunk_count=len(chunks),
        token_count=sum(len(c.split()) for c in chunks),
        lightrag_doc_id=base_doc_id,
        ingested_at=datetime.now(timezone.utc).isoformat(),
        chunking_strategy=strategy,
    )

    return "ingested"


def _hash_file(path: Path) -> str:
    h = hashlib.md5()
    h.update(path.read_bytes())
    return h.hexdigest()
