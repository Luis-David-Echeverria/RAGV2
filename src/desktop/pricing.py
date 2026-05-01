"""Per-model token pricing in USD per 1M tokens.

Rates current as of late 2025 / early 2026. Edit this file directly when
Google or Jina change their pricing — there's no API to query rates.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Rate:
    input_per_1m: float
    output_per_1m: float
    notes: str = ""


_USD_PER_1M = 1_000_000.0

# Defaults: Gemini 2.5 family + Jina rerank.
_RATES: dict[str, Rate] = {
    # Gemini text generation models
    "gemini-2.5-flash":      Rate(0.30, 2.50, "smart tier"),
    "gemini-2.5-flash-lite": Rate(0.10, 0.40, "cheap tier"),
    "gemini-2.5-pro":        Rate(1.25, 10.00, "pro tier"),
    # Embedding (output cost is 0; treat embedding as input-only)
    "gemini-embedding-001":  Rate(0.15, 0.0, "embedding"),
    # Jina reranker — billed per total tokens (we treat them as input)
    "jina-reranker-v2-base-multilingual": Rate(0.40, 0.0, "rerank"),
}

# Loose alias map so callers can pass the bare model id from .env even if
# Google publishes the price under a slightly different key.
_ALIASES = {
    "gemini-2.5-flash-002": "gemini-2.5-flash",
    "gemini-flash":         "gemini-2.5-flash",
    "gemini-flash-lite":    "gemini-2.5-flash-lite",
    "embedding-001":        "gemini-embedding-001",
}


def _resolve(model: str) -> str:
    m = (model or "").strip()
    return _ALIASES.get(m, m)


def get_rate(model: str) -> Rate | None:
    return _RATES.get(_resolve(model))


def cost_for(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    """USD cost for a single call. Returns 0.0 if model isn't priced.

    Prompt and completion are billed at separate per-1M rates."""
    rate = get_rate(model)
    if rate is None:
        return 0.0
    return (
        prompt_tokens * rate.input_per_1m / _USD_PER_1M
        + completion_tokens * rate.output_per_1m / _USD_PER_1M
    )


def known_models() -> list[str]:
    return sorted(_RATES.keys())


# ── Service dashboard URLs (no API for credits — these are the manual checks)
JINA_DASHBOARD = "https://jina.ai/api-dashboard/"
GEMINI_DASHBOARD = "https://aistudio.google.com/usage"
GCP_BILLING = "https://console.cloud.google.com/billing"
