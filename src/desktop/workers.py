"""Concurrency helpers for the tray app.

Two patterns are supported:
- `run_async`: schedule a coroutine on the qasync loop. Calls `on_done` and
  `on_error` on the GUI thread (qasync runs them on the same loop).
- `SyncWorker`: QThread for blocking calls (e.g. `run_sync`). Emits `finished`
  on the GUI thread.
"""
from __future__ import annotations

import asyncio
import traceback
from typing import Any, Callable, Coroutine

from PySide6.QtCore import QObject, QThread, Signal


_active_tasks: set[asyncio.Task[Any]] = set()


def run_async(
    coro: Coroutine[Any, Any, Any],
    on_done: Callable[[Any], None] | None = None,
    on_error: Callable[[BaseException], None] | None = None,
) -> asyncio.Task[Any]:
    """Schedule `coro` on the running asyncio (qasync) loop.

    `on_done`/`on_error` fire on the same loop, so they're safe to mutate Qt
    widgets directly. We retain a strong ref in `_active_tasks` so the task
    isn't GC'd mid-flight.
    """
    loop = asyncio.get_event_loop()
    task = loop.create_task(coro)
    _active_tasks.add(task)

    def _completed(t: asyncio.Task[Any]) -> None:
        _active_tasks.discard(t)
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            traceback.print_exception(type(exc), exc, exc.__traceback__)
            if on_error is not None:
                on_error(exc)
            return
        if on_done is not None:
            on_done(t.result())

    task.add_done_callback(_completed)
    return task


class SyncWorker(QObject):
    """QThread-backed wrapper for blocking sync calls. Use:

        worker = SyncWorker(lambda: run_sync(cfg))
        worker.finished.connect(on_done)
        worker.error.connect(on_error)
        worker.start()
    """

    finished = Signal(object)
    error = Signal(object)

    def __init__(self, fn: Callable[[], Any], parent: QObject | None = None):
        super().__init__(parent)
        self._fn = fn
        self._thread = QThread()
        self.moveToThread(self._thread)
        self._thread.started.connect(self._run)
        self.finished.connect(self._thread.quit)
        self.error.connect(self._thread.quit)
        self._thread.finished.connect(self._thread.deleteLater)

    def start(self) -> None:
        self._thread.start()

    def _run(self) -> None:
        try:
            result = self._fn()
        except BaseException as exc:
            traceback.print_exception(type(exc), exc, exc.__traceback__)
            self.error.emit(exc)
            return
        self.finished.emit(result)
