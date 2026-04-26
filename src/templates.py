"""Note templates for entity and source .md files."""
from datetime import date


_AUTO_COMMENT = "<!-- AUTO-GENERATED — DO NOT EDIT -->"

_KEEP = set(" ._-")


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c in _KEEP else "_" for c in name).strip()


def _wikilink(name: str) -> str:
    """[[safe_name|display]] when encoding differs, [[name]] otherwise."""
    safe = _safe(name)
    return f"[[{safe}|{name}]]" if safe != name else f"[[{name}]]"


def render_entity_note(entity: dict, relations: list[dict],
                       chunk_to_docname: dict | None = None) -> str:
    name = entity["name"]
    entity_type = entity.get("entity_type", "Unknown")
    description = entity.get("description", "").strip()
    today = date.today().isoformat()

    source_lines = _build_source_lines(entity.get("source_ids", []), chunk_to_docname or {})

    parts = [
        "---",
        "type: entity",
        f"entity_type: {entity_type}",
        f"last_synced: {today}",
        "---",
        _AUTO_COMMENT,
        "",
        f"# {name}",
        "",
        description or "_No description available._",
    ]

    outgoing, incoming = _build_related_split(entity["name"], relations)
    if outgoing:
        parts += ["", "## → Salientes", ""] + outgoing
    if incoming:
        parts += ["", "## ← Entrantes", ""] + incoming

    also_see = [f"- {_wikilink(n)}" for n in entity.get("also_see", []) if n]
    if also_see:
        parts += ["", "## También podría interesarte", ""] + also_see

    if source_lines:
        parts += ["", "## Fuentes", ""] + source_lines

    return "\n".join(parts) + "\n"


def render_source_note(doc_id: str, original_file: str, content: str,
                       entity_links: list[tuple[str, str]]) -> str:
    title = _title_from_doc_id(doc_id, original_file)
    today = date.today().isoformat()
    origin = "user" if "user_" in doc_id else "claude"

    entity_lines = [f"- {_wikilink(name)} — {rel}" for name, rel in entity_links] if entity_links else []

    parts = [
        "---",
        "type: source",
        f"origin: {origin}",
        f"last_synced: {today}",
        "---",
        _AUTO_COMMENT,
        "",
        f"# {title}",
    ]

    if entity_lines:
        parts += ["", "## Entidades", ""] + entity_lines

    if content.strip():
        parts += ["", "## Contenido original", "", content.strip()]

    return "\n".join(parts) + "\n"


def _build_related_split(entity_name: str, relations: list[dict]) -> tuple[list[str], list[str]]:
    outgoing, incoming = [], []
    for rel in relations:
        label = rel.get("keywords", rel.get("description", "relacionado"))[:60]
        if rel["source"] == entity_name:
            outgoing.append(f"- {_wikilink(rel['target'])} — {label}")
        elif rel["target"] == entity_name:
            incoming.append(f"- {_wikilink(rel['source'])} — {label}")
    return outgoing[:20], incoming[:20]


def _build_source_lines(source_ids: list[str], chunk_to_docname: dict) -> list[str]:
    seen: set[str] = set()
    lines = []
    for sid in source_ids:
        if not sid:
            continue
        name = chunk_to_docname.get(sid, sid)
        if name not in seen:
            seen.add(name)
            lines.append(f"- [[{name}]]")
        if len(lines) >= 10:
            break
    return lines


def _title_from_doc_id(doc_id: str, original_file: str) -> str:
    if original_file:
        stem = original_file.rsplit(".", 1)[0]
        return stem.replace("_", " ").replace("-", " ").strip()
    parts = doc_id.split("_")
    if parts and parts[0] in ("user", "claude"):
        parts = parts[1:]
    if parts and parts[-1].startswith("c") and parts[-1][1:].isdigit():
        parts = parts[:-1]
    if parts and len(parts[-1]) == 8 and all(c in "0123456789abcdef" for c in parts[-1]):
        parts = parts[:-1]
    return " ".join(parts).strip() or doc_id
