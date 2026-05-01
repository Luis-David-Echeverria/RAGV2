"""Wrapper around the `lightrag-server` subprocess.

Owns the process handle when the tray launched it. If the server was started
externally (e.g. from a terminal) the tray detects it via the health check
but does NOT manage its lifecycle — the user has to stop it where they
started it. We refuse to send signals to processes we don't own to avoid
killing surprises.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path


def _find_executable() -> list[str]:
    exe = shutil.which("lightrag-server")
    if exe:
        return [exe]
    # Fallback: `python -m lightrag.api.lightrag_server`
    return [sys.executable, "-m", "lightrag.api.lightrag_server"]


class LightRAGProcess:
    def __init__(self, log_path: Path, cwd: Path | None = None):
        self.log_path = Path(log_path)
        self.cwd = Path(cwd) if cwd else Path.cwd()
        self._proc: subprocess.Popen | None = None
        self._log_handle = None

    def is_owned_running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def start(self) -> tuple[bool, str]:
        """Returns (success, message). Idempotent — calling while we already
        own a running process is a no-op success."""
        if self.is_owned_running():
            return True, "LightRAG already running (owned by tray)."

        # If a previous proc crashed, release its log handle before reopening
        self._cleanup_log()
        self._proc = None

        cmd = _find_executable()
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            self._log_handle = open(self.log_path, "ab", buffering=0)
        except Exception as exc:
            return False, f"Could not open log file: {exc}"

        flags = 0
        # On Windows we need a new process group so CTRL_BREAK_EVENT can
        # reach the server without also killing the tray app.
        if sys.platform == "win32":
            flags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]

        # Force UTF-8 on the child's stdio. LightRAG's splash screen prints
        # ANSI / unicode characters; on Windows the default cp1252 codec
        # crashes the server immediately when stdout is redirected to a file.
        child_env = os.environ.copy()
        child_env["PYTHONUTF8"] = "1"
        child_env["PYTHONIOENCODING"] = "utf-8"

        try:
            self._proc = subprocess.Popen(
                cmd,
                stdout=self._log_handle,
                stderr=subprocess.STDOUT,
                cwd=str(self.cwd),
                creationflags=flags,
                env=child_env,
            )
        except FileNotFoundError as exc:
            self._cleanup_log()
            return False, f"lightrag-server not found: {exc}"
        except Exception as exc:
            self._cleanup_log()
            return False, f"Failed to launch lightrag-server: {exc}"

        return True, f"LightRAG launching (PID {self._proc.pid}). Health turns green when ready."

    def stop(self) -> tuple[bool, str]:
        if self._proc is None:
            return False, "LightRAG was not started by the tray."
        if self._proc.poll() is not None:
            self._cleanup_log()
            self._proc = None
            return True, "LightRAG was already stopped."

        try:
            if sys.platform == "win32":
                # Graceful CTRL_BREAK; wait briefly; otherwise terminate.
                self._proc.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
            else:
                self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=2)
        except Exception as exc:
            try:
                self._proc.kill()
            except Exception:
                pass
            self._cleanup_log()
            self._proc = None
            return False, f"Stopped with errors: {exc}"

        self._cleanup_log()
        self._proc = None
        return True, "LightRAG stopped."

    def _cleanup_log(self) -> None:
        try:
            if self._log_handle:
                self._log_handle.close()
        except Exception:
            pass
        self._log_handle = None
