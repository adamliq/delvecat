"""Structured properties: admin-defined, typed custom fields (DataHub-style).

Definitions live in annotation files under ``structuredProperties``; values are
set on any annotation entry under ``properties``. Values are validated against
the definition (type, allowed values, cardinality) when annotations load;
applying a value to an object type the property does not cover is reported and
skipped. ``required`` properties are tracked as coverage, not as errors.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

TYPES = ("string", "number", "boolean", "date", "url")
_URL = re.compile(r"^https?://\S+$")


def _type_ok(kind: str, value: Any) -> bool:
    if kind == "string":
        return isinstance(value, str) and value != ""
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "date":
        if isinstance(value, date):
            return True
        try:
            date.fromisoformat(str(value))
            return True
        except ValueError:
            return False
    if kind == "url":
        return isinstance(value, str) and bool(_URL.match(value))
    return False


def normalize(kind: str, value: Any) -> Any:
    """YAML turns 2026-01-31 into a date; keep JSON-friendly ISO strings."""
    return value.isoformat() if kind == "date" and isinstance(value, date) else value


def allowed_values(d: dict[str, Any]) -> list[Any]:
    return [v["value"] if isinstance(v, dict) else v for v in d.get("allowedValues", [])]


def check_definitions(defs: list[dict[str, Any]]) -> list[str]:
    problems, seen = [], {}
    for d in defs:
        where = d.get("source", "?")
        if d["id"] in seen:
            problems.append(
                f"{where}: structured property {d['id']!r} is already defined in {seen[d['id']]}"
            )
        seen[d["id"]] = where
        kind = d.get("type", "string")
        for v in allowed_values(d):
            if not _type_ok(kind, v):
                problems.append(f"{where}: allowed value {v!r} of {d['id']!r} is not a {kind}")
    return problems


def check_values(entries: list[Any], defs: dict[str, dict[str, Any]]) -> list[str]:
    """Validate every ``properties:`` block against the definitions (file:line errors)."""
    problems = []
    for entry in entries:
        for pid, raw in (entry.data.get("properties") or {}).items():
            d = defs.get(pid)
            if d is None:
                problems.append(f"{entry.source}: unknown structured property {pid!r}")
                continue
            kind = d.get("type", "string")
            values = raw if isinstance(raw, list) else [raw]
            if isinstance(raw, list) and d.get("cardinality", "single") == "single":
                problems.append(f"{entry.source}: {pid!r} takes a single value, not a list")
                continue
            allowed = allowed_values(d)
            for v in values:
                if not _type_ok(kind, v):
                    problems.append(f"{entry.source}: {pid!r} expects a {kind}, got {v!r}")
                elif allowed and normalize(kind, v) not in [normalize(kind, a) for a in allowed]:
                    problems.append(
                        f"{entry.source}: {v!r} is not an allowed value of {pid!r} "
                        f"({', '.join(map(str, allowed))})"
                    )
    return problems


def apply_values(
    entity: dict[str, Any], entry: Any, defs: dict[str, dict[str, Any]], misapplied: set[str]
) -> None:
    props = entry.data.get("properties") or {}
    if not props:
        return
    ann = entity.setdefault("annotations", {})
    for pid, raw in props.items():
        d = defs[pid]
        applies = d.get("appliesTo")
        if applies and entity["type"] not in applies:
            misapplied.add(f"{pid} on {entity['type']}")
            continue
        kind = d.get("type", "string")
        target = ann.setdefault("properties", {})
        if d.get("cardinality", "single") == "multiple":
            existing = target.setdefault(pid, [])
            for v in raw if isinstance(raw, list) else [raw]:
                if normalize(kind, v) not in existing:
                    existing.append(normalize(kind, v))
        else:
            target[pid] = normalize(kind, raw)  # the last applied wins


def applicable(d: dict[str, Any], entity: dict[str, Any]) -> bool:
    return not d.get("appliesTo") or entity["type"] in d["appliesTo"]


def required_for(d: dict[str, Any], entity: dict[str, Any]) -> bool:
    """Required applies to customer content: not Splunk-internal objects (``_audit``, system
    config), and only objects matching ``requiredWhere`` when that is given."""
    if not d.get("required") or not applicable(d, entity):
        return False
    if (entity.get("properties") or {}).get("internal") or entity.get("sharing") == "system":
        return False
    if entity.get("app") == "system" or entity["name"].startswith("_"):
        return False
    where = d.get("requiredWhere")
    if where:
        from .annotations import _matches  # same selector rules as annotation entries

        return _matches(where, entity)
    return True


def missing_required(entities: list[dict[str, Any]], defs: list[dict[str, Any]]) -> dict[str, int]:
    """Count missing required values and record them on each entity."""
    out = {d["id"]: 0 for d in defs if d.get("required")}
    for e in entities:
        ann = e.get("annotations") or {}
        values = ann.get("properties") or {}
        missing = [d["id"] for d in defs if required_for(d, e) and d["id"] not in values]
        if missing:
            e.setdefault("annotations", {})["missingProperties"] = missing
            for m in missing:
                out[m] += 1
        elif "missingProperties" in ann:
            ann.pop("missingProperties")
    return out
