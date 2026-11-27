"""Read-only queries over a catalog, for the app's REST endpoint /services/delvecat/catalog.

Scripts and other tools can list objects, read one with its relationships, and follow
dependencies upstream or downstream without the web page. Dependencies are the same as
the risk rules and the SQL console's ``depends`` view: a search depends on the index it
reads, an index on the sourcetype that feeds it.
"""

from __future__ import annotations

from collections import deque
from typing import Any

from .risk import FROM_NEEDS_TO, TO_NEEDS_FROM

MAX_LIMIT = 1000
DEFAULT_LIMIT = 100
MAX_DEPTH = 10


class QueryError(ValueError):
    pass


def summary(e: dict[str, Any]) -> dict[str, Any]:
    """The fields most callers need (``fields=full`` gives whole objects)."""
    out = {k: e[k] for k in ("id", "type", "name", "instance", "app", "owner") if k in e}
    desc = (e.get("annotations") or {}).get("description") or e.get("description")
    if desc:
        out["description"] = desc
    status = (e.get("health") or {}).get("status")
    if status:
        out["health"] = status
    return out


class CatalogIndex:
    """A catalog loaded once, indexed for lookups."""

    def __init__(self, bundle: dict[str, Any]):
        self.bundle = bundle
        self.by_id = {e["id"]: e for e in bundle["entities"]}
        self.out: dict[str, list[dict[str, Any]]] = {}
        self.inc: dict[str, list[dict[str, Any]]] = {}
        self.depends_on: dict[str, list[str]] = {}  # object -> what it depends on
        self.depended_by: dict[str, list[str]] = {}  # object -> what depends on it
        for x in bundle["edges"]:
            self.out.setdefault(x["from"], []).append(x)
            self.inc.setdefault(x["to"], []).append(x)
            if x["type"] in FROM_NEEDS_TO:
                dep, on = x["from"], x["to"]
            elif x["type"] in TO_NEEDS_FROM:
                dep, on = x["to"], x["from"]
            else:
                continue
            if dep != on:
                self.depends_on.setdefault(dep, []).append(on)
                self.depended_by.setdefault(on, []).append(dep)

    def query(self, params: dict[str, str]) -> dict[str, Any]:
        full = params.get("fields") == "full"
        show = (lambda e: e) if full else summary
        if params.get("id"):
            e = self.by_id.get(params["id"])
            if e is None:
                raise QueryError(f"No object with id {params['id']}.")
            result: dict[str, Any] = {"object": e}
            if params.get("relationships", "1") != "0":
                result["outgoing"] = self.out.get(e["id"], [])
                result["incoming"] = self.inc.get(e["id"], [])
            return result
        for direction in ("upstream", "downstream"):
            if params.get(direction):
                return self._walk(params[direction], direction, params, show)
        return self._list(params, show)

    def _page(self, params: dict[str, str]) -> tuple[int, int]:
        try:
            limit = int(params.get("limit", DEFAULT_LIMIT))
            offset = int(params.get("offset", 0))
        except ValueError:
            raise QueryError("limit and offset must be numbers.") from None
        if not 1 <= limit <= MAX_LIMIT or offset < 0:
            raise QueryError(f"limit must be 1 to {MAX_LIMIT}, offset 0 or more.")
        return limit, offset

    def _list(self, params: dict[str, str], show: Any) -> dict[str, Any]:
        limit, offset = self._page(params)
        types = set(filter(None, params.get("type", "").split(",")))
        instance, app = params.get("instance"), params.get("app")
        name = (params.get("name") or "").lower()
        hits = [
            e
            for e in self.bundle["entities"]
            if (not types or e["type"] in types)
            and (not instance or e.get("instance") == instance)
            and (not app or e.get("app") == app)
            and (not name or name in str(e.get("name", "")).lower())
        ]
        return {
            "total": len(hits),
            "offset": offset,
            "limit": limit,
            "results": [show(e) for e in hits[offset : offset + limit]],
        }

    def _walk(
        self, start: str, direction: str, params: dict[str, str], show: Any
    ) -> dict[str, Any]:
        if start not in self.by_id:
            raise QueryError(f"No object with id {start}.")
        try:
            depth_limit = int(params.get("depth", 3))
        except ValueError:
            raise QueryError("depth must be a number.") from None
        if not 1 <= depth_limit <= MAX_DEPTH:
            raise QueryError(f"depth must be 1 to {MAX_DEPTH}.")
        limit, offset = self._page(params)
        step = self.depends_on if direction == "upstream" else self.depended_by
        seen = {start: 0}
        queue = deque([start])
        while queue:
            cur = queue.popleft()
            if seen[cur] >= depth_limit:
                continue
            for nxt in step.get(cur, ()):
                if nxt not in seen:
                    seen[nxt] = seen[cur] + 1
                    queue.append(nxt)
        found = [(d, i) for i, d in seen.items() if i != start and i in self.by_id]
        found.sort(key=lambda x: (x[0], x[1]))
        return {
            "start": start,
            "direction": direction,
            "depth": depth_limit,
            "total": len(found),
            "offset": offset,
            "limit": limit,
            "results": [
                {**show(self.by_id[i]), "steps": d} for d, i in found[offset : offset + limit]
            ],
        }
