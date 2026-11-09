"""Transports that fetch Splunk REST responses and run searches.

Every transport is read-only. ``HttpTransport`` enforces this with
:func:`check_read_only` before any request leaves the process. The one
exception is ``delvecat-ingest publish``, which may write the DelveCat app's own
catalog collection and nothing else (:func:`publish_allowlist`).
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
    # Cancelling a search job: DelveCat cancels its own searches when they exceed the
    # search time limit. It affects that job only, never configuration.
    re.compile(r"^/services/search/jobs/[A-Za-z0-9_.-]+/control/?$"),
)


SEARCH_MARKER = "```delvecat-ingest```"


class WriteAttemptError(RuntimeError):
    """Raised when code tries to send a request that could modify Splunk."""


class EndpointNotFound(LookupError):
    """The endpoint (or recorded fixture) does not exist — e.g. an app is not installed."""


class SearchError(RuntimeError):
    """Splunk accepted the search request but reported a fatal error in its messages."""


class SearchTimeout(SearchError):
    """A search ran longer than the search time limit and was cancelled."""


class EndpointForbidden(PermissionError):
    """The service account may not read this endpoint (common on Splunk Cloud)."""


# Some Splunk endpoints act on GET (e.g. ``_reload`` re-reads config). Never call them.
_GET_DENYLIST = re.compile(r"/(_reload|_new|control|restart|enable|disable|move|dispatch)(/|$|\?)")


def publish_allowlist(app: str, collection: str) -> tuple[re.Pattern[str], ...]:
    """The one place DelveCat may write: its own app's catalog collection in the KV
    store (``delvecat-ingest publish``). Nothing else in Splunk is ever changed."""
    for name in (app, collection):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise ValueError(f"invalid app or collection name {name!r}")
    base = f"/servicesNS/nobody/{re.escape(app)}/storage/collections/data/{re.escape(collection)}"
    return (re.compile(rf"^{base}(/batch_save)?/?$"),)


def check_read_only(
    method: str, path: str, allowed_writes: tuple[re.Pattern[str], ...] = ()
) -> None:
    method = method.upper()
    if method in ("POST", "DELETE") and any(p.match(path) for p in allowed_writes):
        return
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
        meta = root / "__meta__.json"
        # When the responses were captured: "now" for health checks on replayed data.
        self.as_of: str | None = (
            json.loads(meta.read_text(encoding="utf-8")).get("recordedAt")
            if meta.is_file()
            else None
        )

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
        auth_header: str = "Authorization",
        auth_prefix: str = "Bearer ",
        http_transport: httpx.BaseTransport | None = None,
        allowed_writes: tuple[re.Pattern[str], ...] = (),
        trust_env: bool = True,
        search_timeout: float | None = None,
        poll: float = 0.5,
    ):
        # None or 0: searches run as one blocking request with no limit (oneshot).
        self._search_timeout = search_timeout
        self._poll = poll
        self._allowed_writes = allowed_writes
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={auth_header: f"{auth_prefix}{token}"},
            verify=verify,
            timeout=timeout,
            transport=http_transport,
            trust_env=trust_env,  # False for splunkd on the same machine: no proxy
        )
        self._backoff = backoff
        self._retries = retries
        self._splunk_json = splunk_json

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        check_read_only(method, path, self._allowed_writes)
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
        # Tag DelveCat's own searches so usage reports can leave them out (SPL comment).
        query = f"{query} {SEARCH_MARKER}"
        if self._search_timeout:
            return self._search_job(name, query, earliest, latest)
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

    def _search_job(self, name: str, query: str, earliest: str, latest: str) -> list[dict]:
        """Run a search as a job, cancelling it past the search time limit."""
        resp = self.request(
            "POST",
            "/services/search/jobs",
            data={
                "search": query,
                "exec_mode": "normal",
                "output_mode": "json",
                "earliest_time": earliest,
                "latest_time": latest,
                "timeout": 120,  # keep the finished job only briefly
            },
        )
        self._check(resp, f"search {name}")
        sid = resp.json()["sid"]
        job = f"/services/search/jobs/{sid}"
        limit = float(self._search_timeout or 0)
        deadline = time.monotonic() + limit
        while True:
            content = self.get(job)["entry"][0]["content"]
            fatal = [
                m.get("text", "")
                for m in content.get("messages") or []
                if isinstance(m, dict) and m.get("type") in ("FATAL", "ERROR")
            ]
            if content.get("isFailed") or content.get("dispatchState") == "FAILED":
                raise SearchError(f"search {name}: {'; '.join(fatal) or 'failed'}")
            if content.get("isDone"):
                if fatal:
                    raise SearchError(f"search {name}: {'; '.join(fatal)}")
                break
            if time.monotonic() >= deadline:
                self.request("POST", f"{job}/control", data={"action": "cancel"})
                raise SearchTimeout(
                    f"search {name} ran longer than the search time limit "
                    f"({limit:g} s) and was cancelled"
                )
            time.sleep(self._poll)
        results: list[dict[str, Any]] = []
        page = 10000
        while True:
            body = self.get(f"{job}/results", {"count": page, "offset": len(results)})
            batch = body.get("results", [])
            results.extend(batch)
            if len(batch) < page:
                return results


class RecordingTransport:
    """Wraps another transport and saves every response as a replayable fixture.

    Paged responses are combined into one fixture. Secrets are removed before
    anything is written (see :mod:`delvecat_ingest.redact`).
    """

    def __init__(self, inner: Transport, root: Path) -> None:
        from datetime import datetime

        from .compat import UTC

        self.inner = inner
        self.root = root
        self._pages: dict[str, dict[str, Any]] = {}
        root.mkdir(parents=True, exist_ok=True)
        now = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        (root / "__meta__.json").write_text(json.dumps({"recordedAt": now}) + "\n", "utf-8")

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
