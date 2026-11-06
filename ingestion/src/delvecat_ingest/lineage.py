"""Derive lineage from SPL wherever it appears in the catalog.

Runs after extraction on the merged entities. For each object holding SPL it
expands macros (using the catalogued macro definitions, with Splunk's
visibility rules), analyzes the search, and emits references that the resolver
turns into ``reads`` / ``writes`` / ``uses`` edges with origin ``spl``.

Diagnostics go to ``entity["lineage"]`` (not part of the content hash):
``implicitIndex``, ``dynamic``, ``unresolved`` (filled in after resolution)
and ``warnings``.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from .model import Ref, Target
from .spl import SplAnalysis, analyze

# Object types an SPL reference may point at; the resolver only matches visible ones.
KNOWLEDGE_TYPES = frozenset({"macro", "lookup", "eventtype", "savedSearch", "dataModel"})


class MacroLibrary:
    """Macro lookup with Splunk visibility: same app first, then globally shared."""

    def __init__(self, entities: list[dict[str, Any]]):
        self._by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for e in entities:
            if e["type"] == "macro" and not e.get("disabled"):
                self._by_name[e["name"]].append(e)

    def visible(self, name: str, app: str | None, owner: str | None = None):
        candidates = self._by_name.get(name, [])
        for e in candidates:
            if e.get("app") == app and (e.get("sharing") != "user" or e.get("owner") == owner):
                return e
        for e in candidates:
            if e.get("sharing") in ("global", "system"):
                return e
        return None

    def hidden_elsewhere(self, name: str) -> list[str]:
        return sorted({e.get("app") or "?" for e in self._by_name.get(name, [])})

    def resolver(self, app: str | None, owner: str | None):
        def resolve(name: str):
            e = self.visible(name, app, owner)
            if e is None:
                return None
            p = e.get("properties") or {}
            return str(p.get("definition") or ""), list(p.get("args") or [])

        return resolve


def _spl_sources(e: dict[str, Any]) -> list[tuple[str, bool, str]]:
    """(spl, is_fragment, label) for every search held by an entity."""
    p = e.get("properties") or {}
    t = e["type"]
    if t == "savedSearch":
        return [(p.get("search") or "", False, "search")]
    if t == "workflowAction" and p.get("search"):
        return [(p["search"], False, "search")]
    if t in ("eventtype",):
        return [(p.get("search") or "", True, "search")]
    if t == "macro":
        return [(p.get("definition") or "", True, "definition")]
    if t == "dataModel":
        return [
            (d.get("constraint") or "", True, f"dataset {d.get('name')}")
            for d in p.get("datasets") or []
            if d.get("constraint")
        ]
    if t == "dashboard":
        out = []
        for s in p.get("searches") or []:
            label = f"panel {s.get('title') or s.get('id') or '?'}"
            if s.get("kind") == "inline":
                out.append((s.get("query") or "", False, label))
            elif s.get("kind") == "postProcess" and s.get("query"):
                out.append((s["query"], True, label))
        return out
    return []


def derive(entities: list[dict[str, Any]]) -> list[Ref]:
    """Analyze SPL on every entity; return references and set ``entity["lineage"]``."""
    macros = MacroLibrary(entities)
    refs: list[Ref] = []
    for e in entities:
        sources = _spl_sources(e)
        saved_refs = [
            s["ref"]
            for s in (e.get("properties") or {}).get("searches") or []
            if e["type"] == "dashboard" and s.get("kind") == "savedSearch" and s.get("ref")
        ]
        if not sources and not saved_refs:
            continue
        app, owner = e.get("app"), e.get("owner") if e.get("sharing") == "user" else None
        combined = SplAnalysis()
        # Keep warnings recorded during extraction (e.g. unparseable dashboard XML).
        combined.warnings.extend((e.get("lineage") or {}).get("warnings", []))
        for spl, fragment, label in sources:
            a = analyze(spl, macros.resolver(app, owner), fragment=fragment)
            combined.merge(a)
            if a.implicit_index:
                combined.warnings.append(
                    f"{label}: no index specified, so Splunk searches the user's default indexes"
                )
        for name in saved_refs:
            combined.refs.add(("reads", "savedSearch", name, False))

        for edge_type, target_type, name, pattern in sorted(combined.refs):
            if e["type"] == "macro" and target_type == "macro" and name == e["name"]:
                continue
            refs.append(
                Ref(
                    e["id"],
                    Target(
                        target_type,
                        name,
                        app,
                        pattern,
                        visible_only=target_type in KNOWLEDGE_TYPES,
                        owner=owner,
                    ),
                    edge_type,
                    origin="spl",
                )
            )
        unresolved = [f"macro:{m}" for m in combined.unresolved_macros if not m.startswith("(")]
        for m in combined.unresolved_macros:
            if m.startswith("("):
                combined.warnings.append(m.strip("()"))
            elif apps := macros.hidden_elsewhere(m):
                combined.warnings.append(
                    f"macro {m} exists in {', '.join(apps)} but is not shared with {app}"
                )
        lineage: dict[str, Any] = {}
        if combined.implicit_index and e["type"] in ("savedSearch", "dashboard", "workflowAction"):
            lineage["implicitIndex"] = True
        if combined.dynamic and e["type"] in ("dashboard", "workflowAction"):
            lineage["dynamic"] = True
        if unresolved:
            lineage["unresolved"] = unresolved
        warnings = [
            w
            for w in combined.warnings
            if e["type"] in ("savedSearch", "dashboard", "workflowAction")
            or "not shared" in w
            or "too deep" in w
            or "could not parse" in w
        ]
        if warnings:
            lineage["warnings"] = warnings
        if lineage:
            e["lineage"] = lineage
        else:
            e.pop("lineage", None)
    return refs


def record_unresolved(entities_by_id: dict[str, dict[str, Any]], unresolved: list[Ref]) -> int:
    """Attach SPL references the resolver could not match to their entity."""
    n = 0
    for ref in unresolved:
        # Patterns may legitimately match nothing; written lookups appear on first run.
        if ref.origin != "spl" or ref.target.pattern or ref.edge_type == "writes":
            continue
        e = entities_by_id.get(ref.known)
        if e is None:
            continue
        label = f"{ref.target.type}:{ref.target.name}"
        lin = e.setdefault("lineage", {})
        lin.setdefault("unresolved", [])
        if label not in lin["unresolved"]:
            lin["unresolved"].append(label)
            n += 1
    return n
