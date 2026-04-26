"""save_memory() and search_memory() — Claude's interface to the knowledge system."""
import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

from .config import Config, load_config


def save_memory(
    topic: str,
    summary: str,
    key_decisions: list[str] | None = None,
    entities_mentioned: list[str] | None = None,
    open_items: list[str] | None = None,
    context: str = "",
    previous_session_id: str | None = None,
    cfg: Config | None = None,
) -> str:
    """Write a session memory file to inbox/claude/. Returns the file path."""
    if cfg is None:
        cfg = load_config()

    now = datetime.now(timezone.utc)
    session_id = f"conv_{now.strftime('%Y-%m-%d_%H-%M')}"
    timestamp = now.isoformat()
    slug = topic.lower().replace(" ", "-")[:40]
    file_name = f"{now.strftime('%Y-%m-%d_%H-%M')}_{slug}.md"

    inbox = cfg.vault_path / "inbox" / "claude"
    inbox.mkdir(parents=True, exist_ok=True)
    file_path = inbox / file_name

    frontmatter_entities = "\n".join(f"  - {e}" for e in (entities_mentioned or []))
    frontmatter = f"""\
---
source: claude
session_id: {session_id}
timestamp: {timestamp}
topic: {topic}
entities_mentioned:
{frontmatter_entities or "  []"}
previous_session_id: {previous_session_id or "null"}
---
"""

    sections = [f"# Session: {topic}", "", f"## Summary", "", summary]

    if key_decisions:
        sections += ["", "## Key Decisions", ""]
        sections += [f"- {d}" for d in key_decisions]

    if context:
        sections += ["", "## Context", "", context]

    if open_items:
        sections += ["", "## Open Items", ""]
        sections += [f"- {item}" for item in open_items]

    body = "\n".join(sections) + "\n"
    file_path.write_text(frontmatter + "\n" + body, encoding="utf-8")
    return str(file_path)


def search_memory(query: str, mode: str = "auto", cfg: Config | None = None) -> dict:
    """Query the knowledge graph. Returns compact JSON with summary + stellium_data."""
    if cfg is None:
        cfg = load_config()

    from .agent import GeminiAgent

    async def _run():
        agent = GeminiAgent(cfg)
        try:
            return await agent.query(query, mode=mode)
        finally:
            await agent.aclose()

    return asyncio.run(_run())
