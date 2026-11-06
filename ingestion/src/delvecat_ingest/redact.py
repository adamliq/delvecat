"""Drop credentials and email addresses before anything reaches a bundle or fixture."""

from __future__ import annotations

import re
from typing import Any

SENSITIVE_KEY = re.compile(
    r"(passw(or)?d|secret|token|api[_-]?key|credential|private[_-]?key|auth[_-]?header|"
    r"clear_password|ph-auth|e-?mail|^username$)",
    re.IGNORECASE,
)


def redact(value: Any) -> Any:
    """Recursively remove keys whose name looks like it holds a secret."""
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items() if not SENSITIVE_KEY.search(str(k))}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value
