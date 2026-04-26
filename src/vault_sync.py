"""LightRAG storage → Obsidian vault .md files."""
import hashlib
import shutil
from datetime import date
from pathlib import Path

from rich.console import Console
from rich.progress import track

from .config import Config
from .db import init_db, get_all_entity_names, get_all_source_ids, upsert_entity, upsert_source
from .lightrag_client import LightRAGClient
from .templates import render_entity_note, render_source_note

console = Console()


def run_sync(
    cfg: Config,
    entities_only: bool = False,
    sources_only: bool = False,
    dry_run: bool = False,
    clean: bool = False,
) -> None:
    init_db(cfg.db_path)
    client = LightRAGClient(cfg.lightrag_host, cfg.lightrag_storage_dir)

    entities_dir = cfg.vault_path / "entities"
    sources_dir = cfg.vault_path / "sources"
    entities_dir.mkdir(parents=True, exist_ok=True)
    sources_dir.mkdir(parents=True, exist_ok=True)

    if not sources_only:
        _sync_entities(cfg, client, entities_dir, dry_run, clean)

    if not entities_only:
        _sync_sources(cfg, client, sources_dir, dry_run, clean)

    if dry_run:
        console.print("[dim](dry run — no files written)[/dim]")


def _build_adjacency(relations: list[dict]) -> dict[str, set[str]]:
    from collections import defaultdict
    adj: dict[str, set[str]] = defaultdict(set)
    for rel in relations:
        s, t = rel.get("source", ""), rel.get("target", "")
        if s and t:
            adj[s].add(t)
            adj[t].add(s)
    return dict(adj)


def _second_degree(name: str, adj: dict[str, set[str]]) -> list[str]:
    direct = adj.get(name, set())
    second: set[str] = set()
    for neighbor in direct:
        for hop in adj.get(neighbor, set()):
            if hop != name and hop not in direct:
                second.add(hop)
    return sorted(second)[:8]


def _sync_entities(cfg: Config, client: LightRAGClient, out_dir: Path,
                   dry_run: bool, clean: bool) -> None:
    entities = client.read_entities()
    relations = client.read_relations()

    if not entities:
        console.print("[yellow]No entities found in LightRAG storage.[/yellow]")
        return

    console.print(f"Syncing [bold]{len(entities)}[/bold] entities...")
    synced_names: set[str] = set()
    today = date.today().isoformat()
    adj = _build_adjacency(relations)

    chunks = client.read_chunks()
    chunk_to_docname = _build_chunk_to_docname(chunks)

    for entity in track(entities, description="Entities"):
        name = entity["name"]
        if not name:
            continue
        entity["also_see"] = _second_degree(name, adj)
        safe_name = _safe_filename(name)
        file_path = out_dir / f"{safe_name}.md"
        content = render_entity_note(entity, relations, chunk_to_docname)
        desc_hash = hashlib.md5(content.encode()).hexdigest()

        existing_hash = _read_description_hash(cfg.db_path, name)
        if not dry_run and existing_hash != desc_hash:
            file_path.write_text(content, encoding="utf-8")

        upsert_entity(
            cfg.db_path,
            entity_name=name,
            file_name=file_path.name,
            kg_id=_ent_hash(name),
            last_synced=today,
            description_hash=desc_hash,
        )
        synced_names.add(name)

    if clean:
        _orphan_removed_entities(cfg, out_dir, synced_names, dry_run)

    console.print(f"[green]Entities synced: {len(synced_names)}[/green]")


def _sync_sources(cfg: Config, client: LightRAGClient, out_dir: Path,
                  dry_run: bool, clean: bool) -> None:
    documents = client.read_documents()

    if not documents:
        console.print("[yellow]No source documents found in LightRAG storage.[/yellow]")
        return

    console.print(f"Syncing [bold]{len(documents)}[/bold] source documents...")
    synced_ids: set[str] = set()
    today = date.today().isoformat()
    entities = client.read_entities()
    relations = client.read_relations()

    for doc_id, content in track(documents.items(), description="Sources"):
        # Find entities linked to this document
        entity_links = _find_entity_links(doc_id, entities, relations)
        original_file = _guess_original_file(doc_id)

        file_name = _safe_filename(_title_from_doc_id(doc_id, original_file)) + ".md"
        file_path = out_dir / file_name
        note = render_source_note(doc_id, original_file, content, entity_links)

        if not dry_run:
            file_path.write_text(note, encoding="utf-8")

        upsert_source(
            cfg.db_path,
            lightrag_doc_id=doc_id,
            file_name=file_name,
            original_file=original_file,
            last_synced=today,
        )
        synced_ids.add(doc_id)

    if clean:
        _orphan_removed_sources(cfg, out_dir, synced_ids, dry_run)

    console.print(f"[green]Sources synced: {len(synced_ids)}[/green]")


def _orphan_removed_entities(cfg: Config, out_dir: Path, current: set[str],
                              dry_run: bool) -> None:
    known = get_all_entity_names(cfg.db_path)
    removed = known - current
    if not removed:
        return
    orphan_dir = cfg.vault_path / "_meta" / "orphaned"
    orphan_dir.mkdir(parents=True, exist_ok=True)
    for name in removed:
        safe = _safe_filename(name)
        src = out_dir / f"{safe}.md"
        if src.exists() and not dry_run:
            shutil.move(str(src), orphan_dir / src.name)
            console.print(f"[dim]Orphaned: {src.name}[/dim]")


def _orphan_removed_sources(cfg: Config, out_dir: Path, current: set[str],
                             dry_run: bool) -> None:
    known = get_all_source_ids(cfg.db_path)
    removed = known - current
    if not removed:
        return
    orphan_dir = cfg.vault_path / "_meta" / "orphaned"
    orphan_dir.mkdir(parents=True, exist_ok=True)
    for doc_id in removed:
        safe = _safe_filename(_title_from_doc_id(doc_id, ""))
        src = out_dir / f"{safe}.md"
        if src.exists() and not dry_run:
            shutil.move(str(src), orphan_dir / src.name)
            console.print(f"[dim]Orphaned: {src.name}[/dim]")


def _docname_from_file_path(file_path: str) -> str:
    """'user_RAG Test_95cff54e_c0000' → 'RAG Test'"""
    parts = file_path.split("_")
    if parts and parts[0] in ("user", "claude"):
        parts = parts[1:]
    if parts and parts[-1].startswith("c") and parts[-1][1:].isdigit():
        parts = parts[:-1]
    if parts and len(parts[-1]) == 8 and all(c in "0123456789abcdef" for c in parts[-1]):
        parts = parts[:-1]
    return " ".join(parts).strip()


def _build_chunk_to_docname(chunks: dict[str, dict]) -> dict[str, str]:
    """Maps chunk_id → friendly document name."""
    return {
        chunk_id: _docname_from_file_path(info.get("file_path", "")) or chunk_id
        for chunk_id, info in chunks.items()
    }


def _build_doc_to_docname(chunks: dict[str, dict]) -> dict[str, str]:
    """Maps full_doc_id → friendly document name (same source as chunk_to_docname)."""
    result = {}
    for info in chunks.values():
        full_doc_id = info.get("full_doc_id", "")
        fp = info.get("file_path", "")
        if full_doc_id and fp:
            result[full_doc_id] = _docname_from_file_path(fp) or full_doc_id
    return result


def _find_entity_links(doc_id: str, entities: list[dict],
                       relations: list[dict]) -> list[tuple[str, str]]:
    links = []
    for entity in entities:
        if doc_id in entity.get("source_ids", []):
            links.append((entity["name"], entity.get("entity_type", "mentioned")))
    return links[:15]


def _read_description_hash(db_path: Path, entity_name: str) -> str | None:
    from .db import connect
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT description_hash FROM entity_file_map WHERE entity_name = ?",
            (entity_name,),
        ).fetchone()
    return row["description_hash"] if row else None


def _safe_filename(name: str) -> str:
    keepchars = (" ", ".", "_", "-")
    return "".join(c if c.isalnum() or c in keepchars else "_" for c in name).strip()


def _ent_hash(entity_name: str) -> str:
    """Reproduce LightRAG's internal ent-{md5} ID from an entity name."""
    return "ent-" + hashlib.md5(entity_name.encode("utf-8")).hexdigest()


def _title_from_doc_id(doc_id: str, original_file: str) -> str:
    if original_file:
        return original_file.rsplit(".", 1)[0].replace("_", " ").replace("-", " ").strip()
    parts = doc_id.split("_")
    if parts and parts[0] in ("user", "claude"):
        parts = parts[1:]
    if parts and parts[-1].startswith("c") and parts[-1][1:].isdigit():
        parts = parts[:-1]
    if parts and len(parts[-1]) == 8 and all(c in "0123456789abcdef" for c in parts[-1]):
        parts = parts[:-1]
    return " ".join(parts).strip() or doc_id


def _guess_original_file(doc_id: str) -> str:
    # doc_id format: "{origin}_{stem}_{hash8}_c{idx}"
    parts = doc_id.split("_")
    if len(parts) >= 3 and parts[0] in ("user", "claude"):
        # Remove origin, hash, chunk index
        core = parts[1:-2] if len(parts) >= 4 else parts[1:-1]
        return "_".join(core)
    return ""
