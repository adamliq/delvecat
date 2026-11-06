"""Transports that fetch Splunk REST responses.

Every transport is read-only. ``HttpTransport`` enforces this with
:func:`check_read_only` before any request leaves the process.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Protocol

import httpx

# POST is only permitted to endpoints that read or compute, never configure.
_POST_ALLOWLIST = (
    re.compile(r"^/services(NS/[^/]+/[^/]+)?/search/jobs/?$"),
    re.compile(r"^/services(NS/[^/]+/[^/]+)?/search/v2/jobs/?$"),
    re.compile(r"^/services(NS/[^/]+/[^/]+)?/search/parser/?$"),
)


class WriteAttemptError(RuntimeError):
    """Raised when code tries to send a request that could modify Splunk."""


def check_read_only(method: str, path: str) -> None:
    method = method.upper()
    if method in ("GET", "HEAD"):
        return
    if method == "POST" and any(p.match(path) for p in _POST_ALLOWLIST):
        return
    raise WriteAttemptError(f"DelveCat is read-only; refusing {method} {path}")


class Transport(Protocol):
    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]: ...


class FixtureTransport:
    """Replays recorded REST responses from ``<root>/<path>.json``.

    Paging parameters are ignored; each fixture holds the complete result.
    A missing fixture behaves like an HTTP 404.
    """

    def __init__(self, root: Path) -> None:
        self.root = root

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        check_read_only("GET", path)
        file = self.root / (path.strip("/") + ".json")
        if not file.is_file():
            raise EndpointNotFound(path)
        return json.loads(file.read_text(encoding="utf-8"))


class EndpointNotFound(LookupError):
    pass


class HttpTransport:
    """Talks to the Splunk management port (8089) with a bearer token."""

    def __init__(self, base_url: str, token: str, verify: bool | str = True, timeout: float = 60):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            verify=verify,
            timeout=timeout,
        )

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        check_read_only(method, path)
        return self._client.request(method, path, **kwargs)

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        query = {"output_mode": "json", **(params or {})}
        resp = self.request("GET", path, params=query)
        if resp.status_code == 404:
            raise EndpointNotFound(path)
        resp.raise_for_status()
        return resp.json()
