"""Turn name-based references into edges once every entity is known."""

from __future__ import annotations

import fnmatch
from collections import defaultdict
from typing import Any

from .model import GLOBAL_TYPES, Ref, Target, edge


def splunk_wildcard_match(pattern: str, name: str) -> bool:
    """Splunk index wildcards: ``*`` does not match internal (``_``-prefixed) indexes."""
    if name.startswith("_") and not pattern.startswith("_"):
        return False
    return fnmatch.fnmatchcase(name, pattern)


class Resolver:
    def __init__(self, entities: list[dict[str, Any]]):
        self._by_name: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        self._by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for e in entities:
            self._by_name[(e["type"], e["name"])].append(e)
            self._by_type[e["type"]].append(e)

    def candidates(self, target: Target) -> list[dict[str, Any]]:
        if target.pattern and any(c in target.name for c in "*?"):
            return [
                e
                for e in self._by_type.get(target.type, [])
                if splunk_wildcard_match(target.name, e["name"])
            ]
        found = self._by_name.get((target.type, target.name), [])
        if target.visible_only and target.type not in GLOBAL_TYPES:

            def visible(e: dict[str, Any]) -> bool:
                if e.get("sharing") == "user":
                    return e.get("app") == target.app and e.get("owner") == target.owner
                return e.get("app") == target.app or e.get("sharing") in ("global", "system")

            seen = [e for e in found if visible(e)]
            same_app = [e for e in seen if e.get("app") == target.app]
            return (same_app or seen)[:1]
        if target.type in GLOBAL_TYPES or len(found) <= 1:
            return found
        # Knowledge objects: Splunk prefers the current app, then globally shared objects.
        same_app = [e for e in found if e.get("app") == target.app]
        if same_app:
            return same_app[:1]
        shared = [e for e in found if e.get("sharing") in ("global", "system")]
        return (shared or found)[:1]

    def resolve(self, refs: list[Ref]) -> tuple[list[dict[str, Any]], list[Ref]]:
        edges: list[dict[str, Any]] = []
        unresolved: list[Ref] = []
        for ref in refs:
            matches = self.candidates(ref.target)
            if not matches:
                unresolved.append(ref)
            for m in matches:
                a, b = (ref.known, m["id"]) if ref.known_is_from else (m["id"], ref.known)
                if a != b:
                    edges.append(edge(a, b, ref.edge_type, ref.origin))
        return edges, unresolved
