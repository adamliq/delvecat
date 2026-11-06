"""Helpers for Splunk's Atom-style JSON REST responses."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from .transport import Transport

PAGE_SIZE = 500


def iter_entries(transport: Transport, path: str) -> Iterator[dict[str, Any]]:
    """Yield every ``entry`` of a collection endpoint, following ``paging``."""
    offset = 0
    while True:
        body = transport.get(path, {"count": PAGE_SIZE, "offset": offset})
        entries = body.get("entry", [])
        yield from entries
        paging = body.get("paging") or {}
        total = paging.get("total", len(entries))
        offset += len(entries)
        if not entries or offset >= total:
            return


def as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")
