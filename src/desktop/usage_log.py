"""Daily token-usage ledger.

Appends one JSON line per recorded operation to `_meta/token_usage.jsonl`.
The tray reads it to build the "today: $0.024 · month: $0.41" header.

Format per line:
    {"ts": "2026-04-29T03:14:21Z", "op": "query", "model": "gemini-2.5-flash",
     "prompt": 3214, "completion": 612, "cost_usd": 0.0019, "kind": "actual" | "estimate"}

`kind="actual"` lines come from real LLM responses (TokenTracker reports);
`kind="estimate"` lines come from heuristic estimators (e.g. ingest, where
LightRAG-internal calls aren't observable). Both contribute to the rolling
total — being slightly off is better than being silent."""
from __future__ import annotations

import datetime
import json
from dataclasses import dataclass
from pathlib import Path

from . import pricing


_LOG_PATH = "_meta/token_usage.jsonl"


def _log_path(vault_path: Path) -> Path:
    return Path(vault_path) / _LOG_PATH


def record(
    vault_path: Path,
    op: str,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    *,
    kind: str = "actual",
    cost_usd: float | None = None,
) -> None:
    if cost_usd is None:
        cost_usd = pricing.cost_for(model, prompt_tokens, completion_tokens)
    line = {
        "ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "op": op,
        "model": model,
        "prompt": int(prompt_tokens),
        "completion": int(completion_tokens),
        "cost_usd": round(float(cost_usd), 6),
        "kind": kind,
    }
    p = _log_path(vault_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(line, ensure_ascii=False) + "\n")


def record_tracker_report(
    vault_path: Path,
    report: dict,
    op_prefix: str = "query",
) -> None:
    """Persist every operation in a TokenTracker report. The agent's query()
    returns one such report per call."""
    for op_name, u in (report or {}).items():
        record(
            vault_path,
            op=f"{op_prefix}.{op_name}",
            model=u.get("model", "") or "",
            prompt_tokens=int(u.get("prompt", 0) or 0),
            completion_tokens=int(u.get("completion", 0) or 0),
            kind="actual",
        )


@dataclass
class UsageSummary:
    cost_usd: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    n_calls: int = 0


def _iter_lines(path: Path):
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def usage_for_period(vault_path: Path, since_iso: str) -> UsageSummary:
    """Aggregate usage from `since_iso` (inclusive) onwards. `since_iso` should
    be the start of the period in UTC, format `YYYY-MM-DDTHH:MM:SSZ`."""
    s = UsageSummary()
    p = _log_path(vault_path)
    for entry in _iter_lines(p):
        ts = entry.get("ts", "")
        if ts < since_iso:
            continue
        s.cost_usd += float(entry.get("cost_usd", 0) or 0)
        s.prompt_tokens += int(entry.get("prompt", 0) or 0)
        s.completion_tokens += int(entry.get("completion", 0) or 0)
        s.n_calls += 1
    return s


def today_usage(vault_path: Path) -> UsageSummary:
    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT00:00:00Z")
    return usage_for_period(vault_path, today)


def month_usage(vault_path: Path) -> UsageSummary:
    now = datetime.datetime.now(datetime.timezone.utc)
    month_start = now.strftime("%Y-%m-01T00:00:00Z")
    return usage_for_period(vault_path, month_start)
