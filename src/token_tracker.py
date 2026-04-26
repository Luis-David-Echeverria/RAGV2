from dataclasses import dataclass
from typing import Any


@dataclass
class _OpUsage:
    prompt: int = 0
    completion: int = 0
    model: str = ""

    @property
    def total(self) -> int:
        return self.prompt + self.completion


class TokenTracker:
    """Accumulates token usage across all LLM calls in a session."""

    def __init__(self):
        self._ops: dict[str, _OpUsage] = {}

    def record(self, operation: str, prompt: int, completion: int, model: str = "") -> None:
        if operation not in self._ops:
            self._ops[operation] = _OpUsage(model=model)
        elif model and not self._ops[operation].model:
            self._ops[operation].model = model
        self._ops[operation].prompt += prompt
        self._ops[operation].completion += completion

    def record_response(self, operation: str, response: Any, model: str = "") -> None:
        """Extract usage from a google-genai response object."""
        meta = getattr(response, "usage_metadata", None)
        if meta is None:
            return
        self.record(
            operation,
            prompt=getattr(meta, "prompt_token_count", 0) or 0,
            completion=getattr(meta, "candidates_token_count", 0) or 0,
            model=model,
        )

    def estimate_lightrag(self, operation: str, text: str) -> None:
        """Rough estimate for LightRAG internal calls (not accessible via REST)."""
        words = len(text.split())
        tokens = int(words * 1.3)
        self.record(operation, prompt=tokens, completion=int(tokens * 0.4))

    def reset(self) -> None:
        self._ops.clear()

    def report(self) -> dict:
        return {
            op: {"prompt": u.prompt, "completion": u.completion, "total": u.total, "model": u.model}
            for op, u in self._ops.items()
        }

    def total_tokens(self) -> int:
        return sum(u.total for u in self._ops.values())

    def summary_lines(self) -> list[str]:
        lines = []
        for op, u in self._ops.items():
            model_tag = f"({u.model})" if u.model else ""
            lines.append(
                f"  {op:<26} {model_tag:<30} prompt={u.prompt:>6}  completion={u.completion:>6}  total={u.total:>7}"
            )
        lines.append(
            f"  {'TOTAL':<57} prompt={'':>6}  completion={'':>6}  total={self.total_tokens():>7}"
        )
        return lines
