import re
from pathlib import Path
import yaml


def load_aliases(aliases_path: Path) -> dict[str, str]:
    with open(aliases_path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return {str(k): str(v) for k, v in raw.items()}


def _build_pattern(aliases: dict[str, str]):
    # Longest aliases first to avoid partial replacements
    keys = sorted(aliases.keys(), key=len, reverse=True)
    escaped = [re.escape(k) for k in keys]
    return re.compile(r"\b(" + "|".join(escaped) + r")\b")


def normalize_text(text: str, aliases: dict[str, str]) -> str:
    if not aliases:
        return text
    pattern = _build_pattern(aliases)
    return pattern.sub(lambda m: aliases[m.group(0)], text)
