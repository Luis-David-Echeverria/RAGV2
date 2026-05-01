"""Line-preserving .env file editor.

Keeps comments, blank lines and ordering intact. Supports activating /
deactivating a key by toggling its leading `# ` so LightRAG (which only
reads what is uncommented at startup) can be reconfigured without losing
the previous values."""
from __future__ import annotations

import re
from pathlib import Path

_KEY_RE = re.compile(r"^\s*([A-Z_][A-Z0-9_]*)\s*=")
_COMMENTED_RE = re.compile(r"^\s*#\s*([A-Z_][A-Z0-9_]*)\s*=")


class EnvFile:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lines: list[str] = []
        self._key_to_line: dict[str, int] = {}
        self._commented_to_line: dict[str, int] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        text = self.path.read_text(encoding="utf-8")
        self._lines = text.splitlines()
        for i, line in enumerate(self._lines):
            m_active = _KEY_RE.match(line)
            if m_active:
                self._key_to_line[m_active.group(1)] = i
                continue
            m_commented = _COMMENTED_RE.match(line)
            if m_commented:
                # Only register the *first* commented occurrence for each key
                self._commented_to_line.setdefault(m_commented.group(1), i)

    # ── reads ─────────────────────────────────────────────────────────────────

    def get(self, key: str, default: str = "") -> str:
        i = self._key_to_line.get(key)
        if i is None:
            return default
        line = self._lines[i]
        eq = line.index("=")
        return line[eq + 1 :].strip()

    def is_active(self, key: str) -> bool:
        return key in self._key_to_line

    # ── writes ────────────────────────────────────────────────────────────────

    def set(self, key: str, value: str) -> None:
        """Set `KEY=value`. If a commented version exists it gets uncommented
        and overwritten; otherwise we append at the end."""
        new_line = f"{key}={value}"
        i = self._key_to_line.get(key)
        if i is not None:
            self._lines[i] = new_line
            return
        i = self._commented_to_line.pop(key, None)
        if i is not None:
            self._lines[i] = new_line
            self._key_to_line[key] = i
            return
        self._lines.append(new_line)
        self._key_to_line[key] = len(self._lines) - 1

    def comment(self, key: str) -> None:
        """Comment out an active key (LightRAG ignores commented lines)."""
        i = self._key_to_line.pop(key, None)
        if i is None:
            return
        self._lines[i] = f"# {self._lines[i]}"
        self._commented_to_line[key] = i

    def uncomment(self, key: str) -> None:
        """Uncomment a previously-commented key, preserving its value."""
        i = self._commented_to_line.pop(key, None)
        if i is None:
            return
        line = self._lines[i]
        # Strip the leading "#" plus optional whitespace once
        self._lines[i] = re.sub(r"^\s*#\s?", "", line, count=1)
        self._key_to_line[key] = i

    def save(self) -> None:
        text = "\n".join(self._lines)
        if self._lines and not text.endswith("\n"):
            text += "\n"
        self.path.write_text(text, encoding="utf-8")
