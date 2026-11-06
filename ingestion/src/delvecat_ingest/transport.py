"""Transports that fetch Splunk REST responses and run searches.

Every transport is read-only. ``HttpTransport`` enforces this with
:func:`check_read_only` before any request leaves the process.
"""

from __future__ import annotations

import json
import re
import time
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


class EndpointNotFound(LookupError):
    """The endpoint (or recorded fixture) does not exist — e.g. an app is not installed."""


class SearchError(RuntimeError):
    """Splunk accepted the search request but reported a fatal error in its messages."""


class EndpointForbidden(PermissionError):
    """The service account may not read this endpoint (common on Splunk Cloud)."""


# Some Splunk endpoints act on GET (e.g. ``_reload`` re-reads config). Never call them.
_GET_DENYLIST = re.compile(r"/(_reload|_new|control|restart|enable|disable|move|dispatch)(/|$|\?)")


def check_read_only(method: str, path: str) -> None:
    method = method.upper()
    if method in ("GET", "HEAD"):
        if _GET_DENYLIST.search(path):
            raise WriteAttemptError(f"DelveCat is read-only; refusing {method} {path}")
        return
    if method == "POST" and any(p.match(path) for p in _POST_ALLOWLIST):
        return
    raise WriteAttemptError(f"DelveCat is read-only; refusing {method} {path}")


def search_fixture_path(name: str) -> str:
    """Fixture path for a named search; characters invalid on Windows are percent-encoded."""
    from urllib.parse import quote

    return "__search__/" + quote(name, safe="/ -_.()")


class Transport(Protocol):
    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]: ...

    def search(
        self, name: str, spl: str, earliest: str = "-24h", latest: str = "now"
    ) -> list[dict[str, Any]]:
        """Run a read-only search and return its result rows.

        ``name`` identifies the query so recorded fixtures can be replayed.
        """
        ...


class FixtureTransport:
    """Replays recorded responses.

    REST: ``<root>/<path>.json``. Searches: ``<root>/__search__/<name>.json``
    containing ``{"results": [...]}``. Paging parameters are ignored; each
    fixture holds the complete result. A missing fixture behaves like a 404,
    and a fixture of ``{"__status__": 403}`` like a permission error.
    """

    def __init__(self, root: Path) -> None:
        self.root = root

    def _load(self, relative: str, label: str) -> dict[str, Any]:
        file = self.root / (relative.strip("/") + ".json")
        if not file.is_file():
            raise EndpointNotFound(label)
        body = json.loads(file.read_text(encoding="utf-8"))
        if body.get("__status__") == 403:
            raise EndpointForbidden(label)
        return body

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        check_read_only("GET", path)
        body = self._load(path, path)
        return body.get("__list__", body)

    def search(
        self, name: str, spl: str, earliest: str = "-24h", latest: str = "now"
    ) -> list[dict[str, Any]]:
        return self._load(search_fixture_path(name), f"search {name}").get("results", [])


class HttpTransport:
    """Read-only HTTP client for the Splunk management port (8089) or the ACS API."""

    RETRY_STATUSES = (429, 502, 503, 504)

    def __init__(
        self,
        base_url: str,
        token: str,
        verify: bool | str = True,
        timeout: float = 120,
        retries: int = 3,
        splunk_json: bool = True,
        backoff: float = 2.0,
        http_transport: httpx.BaseTransport | None = None,
    ):
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {token}"},
            verify=verify,
            timeout=timeout,
            transport=http_transport,
        )
        self._backoff = backoff
        self._retries = retries
        self._splunk_json = splunk_json

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        check_read_only(method, path)
        for attempt in range(self._retries + 1):
            try:
                resp = self._client.request(method, path, **kwargs)
            except httpx.TransportError:
                if attempt == self._retries:
                    raise
            else:
                if resp.status_code not in self.RETRY_STATUSES or attempt == self._retries:
                    return resp
            time.sleep(self._backoff**attempt if self._backoff else 0)
        raise AssertionError("unreachable")

    def _check(self, resp: httpx.Response, label: str) -> None:
        if resp.status_code == 404:
            raise EndpointNotFound(label)
        if resp.status_code in (401, 403):
            raise EndpointForbidden(f"{label} (HTTP {resp.status_code})")
        resp.raise_for_status()

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        query = dict(params or {})
        if self._splunk_json:
            query.setdefault("output_mode", "json")
        resp = self.request("GET", path, params=query)
        self._check(resp, path)
        return resp.json()

    def search(
        self, name: str, spl: str, earliest: str = "-24h", latest: str = "now"
    ) -> list[dict[str, Any]]:
        stripped = spl.lstrip()
        if stripped.startswith("|") or stripped.lower().startswith("search "):
            query = stripped
        else:
            query = f"search {stripped}"
        resp = self.request(
            "POST",
            "/services/search/jobs",
            data={
                "search": query,
                "exec_mode": "oneshot",
                "output_mode": "json",
                "count": 0,
                "earliest_time": earliest,
                "latest_time": latest,
            },
        )
        self._check(resp, f"search {name}")
        body = resp.json()
        fatal = [
            m.get("text", "")
            for m in body.get("messages", [])
            if m.get("type") in ("FATAL", "ERROR")
        ]
        if fatal:
            raise SearchError(f"search {name}: {'; '.join(fatal)}")
        return body.get("results", [])


class RecordingTransport:
    """Wraps another transport and saves every response as a replayable fixture.

    Paged responses are combined into one fixture. Secrets are removed before
    anything is written (see :mod:`delvecat_ingest.redact`).
    """

    def __init__(self, inner: Transport, root: Path) -> None:
        self.inner = inner
        self.root = root
        self._pages: dict[str, dict[str, Any]] = {}

    def _write(self, relative: str, body: dict[str, Any]) -> None:
        from .redact import redact

        file = self.root / (relative.strip("/") + ".json")
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(redact(body), indent=1, sort_keys=True) + "\n", "utf-8")

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            body = self.inner.get(path, params)
        except EndpointForbidden:
            self._write(path, {"__status__": 403})
            raise
        offset = int((params or {}).get("offset", 0))
        if isinstance(body, dict) and "entry" in body:
            combined = self._pages.get(path) if offset else None
            if combined is None:
                combined = {k: v for k, v in body.items() if k not in ("links", "origin")}
                combined["entry"] = []
                self._pages[path] = combined
            combined["entry"].extend(body["entry"])
            combined["paging"] = {"total": len(combined["entry"]), "offset": 0}
            self._write(path, combined)
        else:
            self._write(path, body if isinstance(body, dict) else {"__list__": body})
        return body

    def search(
        self, name: str, spl: str, earliest: str = "-24h", latest: str = "now"
    ) -> list[dict[str, Any]]:
        rows = self.inner.search(name, spl, earliest, latest)
        self._write(search_fixture_path(name), {"spl": spl, "earliest": earliest, "results": rows})
        return rows
