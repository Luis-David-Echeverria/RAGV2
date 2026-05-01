"""Stellium tray app — Windows system-tray icon over the RAGV2 CLI surface.

Run as: `rag tray` (preferred) or `python -m src.desktop.tray`.

Architecture:
- PySide6 `QSystemTrayIcon` + `QMenu` for the right-click menu.
- `qasync` bridges Qt's event loop with asyncio so we can schedule the existing
  async ops (`run_ingest`, `GeminiAgent.query`, `run_dedup`) on the same loop.
- Sync ops (`run_sync`) run on a `QThread` worker; results return via signals.
- A `watchdog` Observer watches `inbox/` and updates the status header.
- A `QTimer` polls LightRAG health every 30 s and toggles the icon variant.

The tray imports the existing modules directly — no subprocesses — so it
shares config and stays in lock-step with the CLI.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import qasync
from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QApplication,
    QDialog,
    QDialogButtonBox,
    QInputDialog,
    QLabel,
    QMenu,
    QMessageBox,
    QPlainTextEdit,
    QSystemTrayIcon,
    QVBoxLayout,
)
from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from . import pricing, usage_log
from .cost_estimator import CostEstimate, estimate_ingest, estimate_query
from .icons import error_icon, idle_icon, working_icon
from .lightrag_proc import LightRAGProcess
from .notifier import Notification, Notifier, open_path
from .settings_dialog import SettingsDialog
from .workers import SyncWorker, run_async


HEALTH_INTERVAL_MS = 30_000
WORKING_ANIM_MS = 240


def _confirm_cost(title: str, header: str, est: CostEstimate, today_cost: float) -> bool:
    """Modal dialog showing the cost breakdown. Returns True if the user
    confirmed the operation."""
    dlg = QDialog()
    dlg.setWindowTitle(title)
    dlg.setMinimumWidth(640)
    layout = QVBoxLayout(dlg)
    layout.addWidget(QLabel(header))
    layout.addWidget(QLabel(f"Spent today so far: ${today_cost:.4f}"))
    box = QPlainTextEdit()
    box.setReadOnly(True)
    box.setPlainText(est.format_detailed())
    box.setStyleSheet("font-family: Consolas, monospace; font-size: 11px;")
    layout.addWidget(box)
    layout.addWidget(QLabel(f"Projected after this op: ${today_cost + est.total_usd:.4f}"))
    buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
    buttons.button(QDialogButtonBox.StandardButton.Ok).setText("Run")
    buttons.accepted.connect(dlg.accept)
    buttons.rejected.connect(dlg.reject)
    layout.addWidget(buttons)
    return dlg.exec() == QDialog.DialogCode.Accepted


class _InboxWatcher(FileSystemEventHandler, QObject):
    """Bridges watchdog file events to a Qt signal so the GUI thread mutates
    widgets, never the watchdog thread."""

    changed = Signal()

    def __init__(self) -> None:
        FileSystemEventHandler.__init__(self)
        QObject.__init__(self)

    def on_any_event(self, _event) -> None:
        self.changed.emit()


class StelliumTray(QObject):
    def __init__(self, app: QApplication):
        super().__init__()
        self.app = app
        from ..config import load_config
        self.cfg = load_config()
        self._active_ops = 0
        self._lightrag_healthy: bool | None = None
        self._working_phase = 0.0
        self._project_root = Path(__file__).resolve().parent.parent.parent
        self._env_path = self._project_root / ".env"
        self._lightrag = LightRAGProcess(
            log_path=self._project_root / "lightrag.log",
            cwd=self._project_root,
        )

        self.tray = QSystemTrayIcon(idle_icon())
        self.tray.setToolTip("Stellium")
        self.notifier = Notifier(self.tray)

        self._build_menu()
        self.tray.show()

        self._setup_watchers()
        self._setup_health_timer()
        self._setup_working_animator()
        self._refresh_status_header()
        self._refresh_lightrag_actions()
        # Kick a health check immediately so the icon reflects reality on launch
        run_async(self._health_check())

    # ── menu ──────────────────────────────────────────────────────────────────

    def _build_menu(self) -> None:
        menu = QMenu()

        self.status_action = QAction("Stellium — initializing…", menu)
        self.status_action.setEnabled(False)
        menu.addAction(self.status_action)
        menu.addSeparator()

        act_query = menu.addAction("Run query…")
        act_query.triggered.connect(self._on_query)

        act_ingest = menu.addAction("Ingest now")
        act_ingest.triggered.connect(lambda: self._on_ingest(None))
        act_ingest_claude = menu.addAction("  Ingest (Claude only)")
        act_ingest_claude.triggered.connect(lambda: self._on_ingest("claude"))
        act_ingest_user = menu.addAction("  Ingest (User only)")
        act_ingest_user.triggered.connect(lambda: self._on_ingest("user"))

        act_sync = menu.addAction("Sync vault")
        act_sync.triggered.connect(self._on_sync)

        act_dedup = menu.addAction("Dedup entities")
        act_dedup.triggered.connect(self._on_dedup)

        menu.addSeparator()

        act_open_vault = menu.addAction("Open Stellium vault")
        act_open_vault.triggered.connect(lambda: open_path(self.cfg.vault_path))

        act_open_logs = menu.addAction("Open log file")
        act_open_logs.triggered.connect(self._on_open_logs)

        # Dashboards — neither Gemini nor Jina expose a balance API, so we
        # link directly to where the user can see their actual remaining credits.
        dashboards = menu.addMenu("Open balance dashboard")
        act_dash_jina = dashboards.addAction("Jina (api-dashboard)")
        act_dash_jina.triggered.connect(lambda: open_path(pricing.JINA_DASHBOARD))
        act_dash_gemini = dashboards.addAction("Gemini (AI Studio usage)")
        act_dash_gemini.triggered.connect(lambda: open_path(pricing.GEMINI_DASHBOARD))
        act_dash_gcp = dashboards.addAction("Google Cloud Billing")
        act_dash_gcp.triggered.connect(lambda: open_path(pricing.GCP_BILLING))

        menu.addSeparator()

        self.act_start_lightrag = menu.addAction("Start LightRAG")
        self.act_start_lightrag.triggered.connect(self._on_start_lightrag)

        self.act_stop_lightrag = menu.addAction("Stop LightRAG")
        self.act_stop_lightrag.triggered.connect(self._on_stop_lightrag)

        act_settings = menu.addAction("Settings…")
        act_settings.triggered.connect(self._on_settings)

        menu.addSeparator()

        act_quit = menu.addAction("Quit")
        act_quit.triggered.connect(self._on_quit)

        self.tray.setContextMenu(menu)

    # ── status header ─────────────────────────────────────────────────────────

    def _refresh_status_header(self) -> None:
        inbox_root = self.cfg.vault_path / "inbox"
        n_pending = 0
        for origin in ("claude", "user"):
            d = inbox_root / origin
            if d.exists():
                n_pending += sum(1 for f in d.iterdir() if f.is_file())
        if self._lightrag_healthy is None:
            health = "checking…"
        elif self._lightrag_healthy:
            health = "✔ online"
        else:
            health = "✗ offline"
        try:
            today = usage_log.today_usage(self.cfg.vault_path).cost_usd
        except Exception:
            today = 0.0
        self.status_action.setText(
            f"LightRAG: {health}  ·  inbox: {n_pending}  ·  today: ${today:.4f}"
        )

    # ── watchers ──────────────────────────────────────────────────────────────

    def _setup_watchers(self) -> None:
        self._inbox_handler = _InboxWatcher()
        self._inbox_handler.changed.connect(self._refresh_status_header)
        self._observer = Observer()
        inbox_root = self.cfg.vault_path / "inbox"
        inbox_root.mkdir(parents=True, exist_ok=True)
        self._observer.schedule(self._inbox_handler, str(inbox_root), recursive=True)
        self._observer.start()

    # ── health check timer ────────────────────────────────────────────────────

    def _setup_health_timer(self) -> None:
        self._health_timer = QTimer(self)
        self._health_timer.setInterval(HEALTH_INTERVAL_MS)
        self._health_timer.timeout.connect(lambda: run_async(self._health_check()))
        self._health_timer.start()

    async def _health_check(self) -> None:
        from ..lightrag_client import LightRAGClient
        client = LightRAGClient(self.cfg.lightrag_host, self.cfg.lightrag_storage_dir)
        try:
            healthy = await client.health_check()
        except Exception:
            healthy = False
        finally:
            try:
                await client._client.aclose()  # underlying httpx; lightrag has no aclose
            except Exception:
                pass
        prev = self._lightrag_healthy
        self._lightrag_healthy = healthy
        self._refresh_status_header()
        self._refresh_icon()
        self._refresh_lightrag_actions()
        if prev is True and healthy is False:
            self.notifier.notify(Notification(
                "LightRAG offline",
                "Restart `lightrag-server` in your terminal.",
            ))
        elif prev is False and healthy is True:
            self.notifier.notify(Notification(
                "LightRAG online",
                "Server is back. Stellium ops re-enabled.",
            ))

    # ── working-icon animation ────────────────────────────────────────────────

    def _setup_working_animator(self) -> None:
        self._working_timer = QTimer(self)
        self._working_timer.setInterval(WORKING_ANIM_MS)
        self._working_timer.timeout.connect(self._on_working_tick)

    def _on_working_tick(self) -> None:
        self._working_phase = (self._working_phase + 0.18) % 1.0
        self.tray.setIcon(working_icon(self._working_phase))

    def _refresh_icon(self) -> None:
        if self._active_ops > 0:
            if not self._working_timer.isActive():
                self._working_timer.start()
            return
        self._working_timer.stop()
        # If our LightRAG is starting up but health hasn't turned green yet,
        # keep idle instead of flashing red.
        if self._lightrag_healthy is False and not self._lightrag.is_owned_running():
            self.tray.setIcon(error_icon())
        else:
            self.tray.setIcon(idle_icon())

    def _begin_op(self) -> None:
        self._active_ops += 1
        self._refresh_icon()

    def _end_op(self) -> None:
        if self._active_ops > 0:
            self._active_ops -= 1
        self._refresh_icon()

    # ── actions ───────────────────────────────────────────────────────────────

    def _on_ingest(self, source_filter: str | None) -> None:
        from ..ingest import run_ingest
        label = source_filter or "all sources"

        # Pre-flight cost preview. If inbox is empty the dialog still fires
        # so the user knows there's nothing to do.
        try:
            est = estimate_ingest(self.cfg, source_filter=source_filter)
            today_cost = usage_log.today_usage(self.cfg.vault_path).cost_usd
        except Exception as exc:
            est = None
            today_cost = 0.0
            print(f"cost preview failed: {exc}")
        if est is not None:
            header = f"Ingest source: {label}"
            if not est.lines:
                # Empty inbox — show notes only, no Run button needed
                QMessageBox.information(None, "Stellium ingest", "\n".join(est.notes) or "Nothing to ingest.")
                return
            if not _confirm_cost("Confirm ingest cost", header, est, today_cost):
                return

        self.notifier.notify(Notification("Ingest started", f"Source: {label}"))
        self._begin_op()

        def _done(_res):
            self._end_op()
            # LightRAG-internal token counts aren't observable from outside,
            # so we persist the central estimate as the actual cost. Off
            # by a smallish factor, but keeps the daily total honest.
            if est is not None:
                try:
                    for line in est.lines:
                        usage_log.record(
                            self.cfg.vault_path,
                            op=f"ingest.{line.op}",
                            model=line.model,
                            prompt_tokens=line.prompt_tokens,
                            completion_tokens=line.completion_tokens,
                            kind="estimate",
                            cost_usd=line.cost_usd,
                        )
                except Exception as exc:
                    print(f"usage_log persist failed: {exc}")
            self._refresh_status_header()
            self.notifier.notify(Notification(
                "Ingest complete",
                f"Source: {label}. Check the vault for processed/.",
            ))

        def _err(exc):
            self._end_op()
            self.notifier.notify(Notification("Ingest failed", str(exc)))

        run_async(run_ingest(self.cfg, source_filter=source_filter), _done, _err)

    def _on_sync(self) -> None:
        from ..vault_sync import run_sync
        self.notifier.notify(Notification("Sync started", "Vault sync running…"))
        self._begin_op()
        worker = SyncWorker(lambda: run_sync(self.cfg))
        worker.finished.connect(lambda _r: self._on_sync_done())
        worker.error.connect(lambda exc: self._on_sync_error(exc))
        worker.start()
        # Keep ref so the worker isn't GC'd
        self._last_sync_worker = worker

    def _on_sync_done(self) -> None:
        self._end_op()
        self.notifier.notify(Notification("Sync complete", "Vault is up-to-date."))

    def _on_sync_error(self, exc) -> None:
        self._end_op()
        self.notifier.notify(Notification("Sync failed", str(exc)))

    def _on_dedup(self) -> None:
        from ..dedup import run_dedup
        self.notifier.notify(Notification("Dedup started", "Scanning entities…"))
        self._begin_op()

        def _done(_res):
            self._end_op()
            self.notifier.notify(Notification("Dedup complete", "See terminal for details."))

        def _err(exc):
            self._end_op()
            self.notifier.notify(Notification("Dedup failed", str(exc)))

        run_async(run_dedup(self.cfg), _done, _err)

    def _on_query(self) -> None:
        text, ok = QInputDialog.getText(None, "Stellium query", "Query:")
        if not ok or not text.strip():
            return

        # Pre-flight cost preview (modal). Skips the run if the user cancels.
        try:
            est = estimate_query(text, self.cfg)
            today_cost = usage_log.today_usage(self.cfg.vault_path).cost_usd
        except Exception as exc:
            est = None
            today_cost = 0.0
            print(f"cost preview failed: {exc}")
        if est is not None:
            if not _confirm_cost(
                "Confirm query cost",
                f"Query: {text[:120]}",
                est,
                today_cost,
            ):
                return

        from ..agent import GeminiAgent
        from ..cli import _write_stellium_highlight

        self.notifier.notify(Notification("Querying", text[:80]))
        self._begin_op()

        async def _run():
            agent = GeminiAgent(self.cfg)
            try:
                return await agent.query(text)
            finally:
                await agent.aclose()

        def _done(result):
            self._end_op()
            try:
                _write_stellium_highlight(self.cfg, result.get("stellium_data", {}))
            except Exception:
                pass
            # Persist actual usage so the tray's "today" total catches up.
            try:
                usage_log.record_tracker_report(
                    self.cfg.vault_path, result.get("tokens", {}) or {}, op_prefix="query"
                )
            except Exception as exc:
                print(f"usage_log persist failed: {exc}")
            self._refresh_status_header()
            summary = (result.get("summary") or "").strip()
            preview = summary[:140] + ("…" if len(summary) > 140 else "")
            vault = self.cfg.vault_path
            self.notifier.notify(Notification(
                "Query result",
                preview or "(no summary)",
                on_click=lambda: open_path(vault),
            ))

        def _err(exc):
            self._end_op()
            self.notifier.notify(Notification("Query failed", str(exc)))

        run_async(_run(), _done, _err)

    def _on_open_logs(self) -> None:
        # The lightrag.log lives at the project root next to pyproject.toml
        candidates = [
            Path.cwd() / "lightrag.log",
            self.cfg.vault_path.parent / "lightrag.log",
        ]
        for p in candidates:
            if p.exists():
                open_path(p)
                return
        QMessageBox.information(None, "Stellium", "lightrag.log not found yet — start the server first.")

    def _on_settings(self) -> None:
        if not self._env_path.exists():
            QMessageBox.warning(None, "Stellium", f".env not found at {self._env_path}")
            return
        dlg = SettingsDialog(self._env_path)
        dlg.exec()
        result = dlg.result_data
        if not result.saved:
            return
        # Reload os.environ so subsequent `load_config()` calls see the new values.
        try:
            from dotenv import load_dotenv
            load_dotenv(self._env_path, override=True)
        except Exception:
            pass
        if result.needs_app_reload:
            try:
                from ..config import load_config
                old_vault = self.cfg.vault_path
                self.cfg = load_config()
                if self.cfg.vault_path != old_vault:
                    self._rebuild_inbox_watcher()
                self._refresh_status_header()
            except Exception as exc:
                QMessageBox.warning(None, "Stellium", f"Could not reload config: {exc}")
                return
        if result.needs_lightrag_restart:
            self.notifier.notify(Notification(
                "Settings saved",
                "LightRAG-side keys changed — restart the server from the tray menu to apply.",
            ))
        else:
            self.notifier.notify(Notification("Settings saved", "Changes applied."))

    # ── LightRAG process control ──────────────────────────────────────────────

    def _on_start_lightrag(self) -> None:
        if self._lightrag_healthy:
            self.notifier.notify(Notification("LightRAG already online", "Health check is green."))
            return
        ok, msg = self._lightrag.start()
        self.notifier.notify(Notification(
            "LightRAG starting" if ok else "LightRAG start failed",
            msg,
        ))
        self._refresh_lightrag_actions()
        # Force a health check soon so the icon updates as it comes up
        QTimer.singleShot(2000, lambda: run_async(self._health_check()))
        QTimer.singleShot(6000, lambda: run_async(self._health_check()))

    def _on_stop_lightrag(self) -> None:
        ok, msg = self._lightrag.stop()
        self.notifier.notify(Notification(
            "LightRAG stopped" if ok else "Stop failed",
            msg,
        ))
        self._refresh_lightrag_actions()
        QTimer.singleShot(800, lambda: run_async(self._health_check()))

    def _refresh_lightrag_actions(self) -> None:
        owned = self._lightrag.is_owned_running()
        # Start is meaningful when we don't own a running process
        self.act_start_lightrag.setEnabled(not owned)
        # Stop only enabled when we own the process — won't kill external instances
        self.act_stop_lightrag.setEnabled(owned)

    def _rebuild_inbox_watcher(self) -> None:
        try:
            self._observer.stop()
            self._observer.join(timeout=2)
        except Exception:
            pass
        self._setup_watchers()

    def _on_quit(self) -> None:
        try:
            self._observer.stop()
            self._observer.join(timeout=2)
        except Exception:
            pass
        # Best-effort: stop LightRAG if we own it (avoids zombie servers)
        if self._lightrag.is_owned_running():
            try:
                self._lightrag.stop()
            except Exception:
                pass
        self.tray.hide()
        self.app.quit()


def main() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    if not QSystemTrayIcon.isSystemTrayAvailable():
        print("System tray is not available on this platform.", file=sys.stderr)
        return 1

    loop = qasync.QEventLoop(app)
    asyncio.set_event_loop(loop)

    tray = StelliumTray(app)
    _ = tray  # keep ref alive

    with loop:
        loop.run_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
