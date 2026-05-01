"""Stellium settings dialog — edits the .env file with field-level granularity.

Two categories of changes:
- App-side (read by `Config.load_config()`): take effect immediately after save.
- LightRAG-side (read by the LightRAG server at startup): require a server
  restart. The dialog flags those keys and the result tells the caller which
  category was touched.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from .env_io import EnvFile

# Keys that LightRAG-server reads at startup → require restart to take effect.
_LIGHTRAG_KEYS = {
    "LIGHTRAG_HOST",
    "LLM_BINDING",
    "LLM_MODEL",
    "EMBEDDING_BINDING",
    "EMBEDDING_MODEL",
    "RERANK_BINDING",
}


@dataclass
class SettingsResult:
    saved: bool = False
    changed_keys: set[str] = field(default_factory=set)

    @property
    def needs_lightrag_restart(self) -> bool:
        return any(k in _LIGHTRAG_KEYS for k in self.changed_keys)

    @property
    def needs_app_reload(self) -> bool:
        return bool(self.changed_keys - _LIGHTRAG_KEYS)


class SettingsDialog(QDialog):
    def __init__(self, env_path: Path, parent: QWidget | None = None):
        super().__init__(parent)
        self.setWindowTitle("Stellium Settings")
        self.setMinimumWidth(520)
        self.env = EnvFile(env_path)
        self.result_data = SettingsResult()
        self._initial: dict[str, str] = {}
        self._initial_rerank_enabled = self.env.is_active("RERANK_BINDING")
        self._build()

    # ── UI ────────────────────────────────────────────────────────────────────

    def _build(self) -> None:
        outer = QVBoxLayout(self)

        form = QFormLayout()
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(8)

        # Vault path with browse
        self.vault_edit = QLineEdit(self.env.get("VAULT_PATH"))
        browse = QPushButton("Browse…")
        browse.clicked.connect(self._on_browse_vault)
        vault_row = QHBoxLayout()
        vault_row.addWidget(self.vault_edit, 1)
        vault_row.addWidget(browse)
        vault_w = QWidget()
        vault_w.setLayout(vault_row)
        form.addRow("Vault path:", vault_w)
        self._initial["VAULT_PATH"] = self.vault_edit.text()

        # LightRAG host
        self.host_edit = QLineEdit(self.env.get("LIGHTRAG_HOST", "http://localhost:9621"))
        form.addRow("LightRAG host:", self.host_edit)
        self._initial["LIGHTRAG_HOST"] = self.host_edit.text()

        # Models — app-side (cheap = router/rewrite, smart = summary)
        self.cheap_edit = QLineEdit(self.env.get("GEMINI_LLM_CHEAP", "gemini-2.5-flash-lite"))
        form.addRow("LLM cheap (router):", self.cheap_edit)
        self._initial["GEMINI_LLM_CHEAP"] = self.cheap_edit.text()

        self.smart_edit = QLineEdit(self.env.get("GEMINI_LLM_SMART", "gemini-2.5-flash"))
        form.addRow("LLM smart (summary):", self.smart_edit)
        self._initial["GEMINI_LLM_SMART"] = self.smart_edit.text()

        # Models — LightRAG-side (require restart)
        self.lr_llm_edit = QLineEdit(self.env.get("LLM_MODEL", "gemini-2.5-flash"))
        form.addRow("LightRAG LLM model:", self.lr_llm_edit)
        self._initial["LLM_MODEL"] = self.lr_llm_edit.text()

        self.lr_embed_edit = QLineEdit(self.env.get("EMBEDDING_MODEL", "gemini-embedding-001"))
        form.addRow("Embedding model:", self.lr_embed_edit)
        self._initial["EMBEDDING_MODEL"] = self.lr_embed_edit.text()

        # Top K
        self.topk_spin = QSpinBox()
        self.topk_spin.setRange(1, 200)
        try:
            self.topk_spin.setValue(int(self.env.get("RETRIEVAL_TOP_K", "15")))
        except ValueError:
            self.topk_spin.setValue(15)
        form.addRow("Retrieval top K:", self.topk_spin)
        self._initial["RETRIEVAL_TOP_K"] = str(self.topk_spin.value())

        # Reranker toggle
        self.rerank_check = QCheckBox("Enable Jina reranker")
        self.rerank_check.setChecked(self._initial_rerank_enabled)
        form.addRow("Reranker:", self.rerank_check)

        outer.addLayout(form)

        # Banner — populated when user changes LightRAG-side fields
        self._banner = QLabel("")
        self._banner.setWordWrap(True)
        self._banner.setStyleSheet("color: #d97706; padding: 4px 0;")
        self._banner.setAlignment(Qt.AlignmentFlag.AlignLeft)
        outer.addWidget(self._banner)

        for w in (
            self.host_edit,
            self.lr_llm_edit,
            self.lr_embed_edit,
        ):
            w.textChanged.connect(self._refresh_banner)
        self.rerank_check.toggled.connect(self._refresh_banner)
        self._refresh_banner()

        # Buttons
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        open_env_btn = QPushButton("Open .env in editor")
        open_env_btn.clicked.connect(self._on_open_env)
        buttons.addButton(open_env_btn, QDialogButtonBox.ButtonRole.ActionRole)
        buttons.accepted.connect(self._on_save)
        buttons.rejected.connect(self.reject)
        outer.addWidget(buttons)

    # ── handlers ──────────────────────────────────────────────────────────────

    def _on_browse_vault(self) -> None:
        path = QFileDialog.getExistingDirectory(self, "Choose vault folder", self.vault_edit.text() or "")
        if path:
            self.vault_edit.setText(path)

    def _on_open_env(self) -> None:
        from .notifier import open_path
        open_path(self.env.path)

    def _refresh_banner(self) -> None:
        changes = self._collect_changes()
        lr_changed = changes & _LIGHTRAG_KEYS
        if lr_changed:
            self._banner.setText(
                "⚠ These changes affect LightRAG-server: "
                + ", ".join(sorted(lr_changed))
                + ". Restart the server from the tray menu after saving."
            )
        else:
            self._banner.setText("")

    def _collect_changes(self) -> set[str]:
        changes: set[str] = set()
        current = {
            "VAULT_PATH": self.vault_edit.text().strip(),
            "LIGHTRAG_HOST": self.host_edit.text().strip(),
            "GEMINI_LLM_CHEAP": self.cheap_edit.text().strip(),
            "GEMINI_LLM_SMART": self.smart_edit.text().strip(),
            "LLM_MODEL": self.lr_llm_edit.text().strip(),
            "EMBEDDING_MODEL": self.lr_embed_edit.text().strip(),
            "RETRIEVAL_TOP_K": str(self.topk_spin.value()),
        }
        for key, val in current.items():
            if val != self._initial.get(key, ""):
                changes.add(key)
        if self.rerank_check.isChecked() != self._initial_rerank_enabled:
            changes.add("RERANK_BINDING")
        return changes

    def _on_save(self) -> None:
        changes = self._collect_changes()
        if not changes:
            self.result_data = SettingsResult(saved=False, changed_keys=set())
            self.accept()
            return

        if "VAULT_PATH" in changes:
            self.env.set("VAULT_PATH", self.vault_edit.text().strip())
        if "LIGHTRAG_HOST" in changes:
            self.env.set("LIGHTRAG_HOST", self.host_edit.text().strip())
        if "GEMINI_LLM_CHEAP" in changes:
            self.env.set("GEMINI_LLM_CHEAP", self.cheap_edit.text().strip())
        if "GEMINI_LLM_SMART" in changes:
            self.env.set("GEMINI_LLM_SMART", self.smart_edit.text().strip())
        if "LLM_MODEL" in changes:
            self.env.set("LLM_MODEL", self.lr_llm_edit.text().strip())
        if "EMBEDDING_MODEL" in changes:
            self.env.set("EMBEDDING_MODEL", self.lr_embed_edit.text().strip())
        if "RETRIEVAL_TOP_K" in changes:
            self.env.set("RETRIEVAL_TOP_K", str(self.topk_spin.value()))
        if "RERANK_BINDING" in changes:
            if self.rerank_check.isChecked():
                self.env.uncomment("RERANK_BINDING")
                # If RERANK_BINDING never existed at all, default to jina so the
                # toggle has a meaning. The companion RERANK_MODEL stays whatever
                # the user had (or empty).
                if not self.env.is_active("RERANK_BINDING"):
                    self.env.set("RERANK_BINDING", "jina")
            else:
                self.env.comment("RERANK_BINDING")

        self.env.save()
        self.result_data = SettingsResult(saved=True, changed_keys=changes)
        self.accept()
