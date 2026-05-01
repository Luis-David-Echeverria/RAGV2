"""Notification wrapper: native Windows toasts when available, QSystemTrayIcon
balloon fallback otherwise. Click actions open a path in the OS."""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from PySide6.QtWidgets import QSystemTrayIcon

_NATIVE_TOASTS = False
_Toaster = None
try:
    if sys.platform == "win32":
        from windows_toasts import Toast, WindowsToaster  # type: ignore[import-not-found]
        _Toaster = WindowsToaster("Stellium")
        _NATIVE_TOASTS = True
except Exception:
    _NATIVE_TOASTS = False


@dataclass
class Notification:
    title: str
    body: str
    on_click: Callable[[], None] | None = None


class Notifier:
    """Posts notifications. If `windows-toasts` is unavailable, falls back to
    `QSystemTrayIcon.showMessage`, which still surfaces a Windows toast on
    Win10/11 but without action buttons or persistence."""

    def __init__(self, tray_icon: QSystemTrayIcon | None = None):
        self._tray_icon = tray_icon

    def notify(self, n: Notification) -> None:
        if _NATIVE_TOASTS and _Toaster is not None:
            try:
                toast = Toast(text_fields=[n.title, n.body])
                if n.on_click is not None:
                    toast.on_activated = lambda _evt: n.on_click() if n.on_click else None
                _Toaster.show_toast(toast)
                return
            except Exception:
                pass
        if self._tray_icon is not None:
            self._tray_icon.showMessage(n.title, n.body, QSystemTrayIcon.MessageIcon.Information, 5000)


def open_path(path: str | os.PathLike[str]) -> None:
    """Cross-platform 'open this file/folder in the default app'."""
    p = str(path)
    try:
        if sys.platform == "win32":
            os.startfile(p)  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            os.system(f'open "{p}"')
        else:
            os.system(f'xdg-open "{p}"')
    except Exception:
        pass


def open_vault(vault_path: Path) -> Callable[[], None]:
    return lambda: open_path(vault_path)
