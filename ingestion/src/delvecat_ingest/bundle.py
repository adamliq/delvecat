"""Assemble and validate catalog bundles."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from . import SCHEMA_VERSION, __version__
from .model import ExtractResult

SCHEMA_RELATIVE = Path("schemas") / "catalog.schema.json"


def find_schema(start: Path | None = None) -> Path:
    """Locate ``schemas/catalog.schema.json`` by walking up from cwd and this file."""
    for base in (start or Path.cwd(), Path(__file__).resolve()):
        for parent in (base, *base.parents):
            candidate = parent / SCHEMA_RELATIVE
            if candidate.is_file():
                return candidate
    raise FileNotFoundError(f"could not find {SCHEMA_RELATIVE}")


def assemble(
    instances: list[dict[str, Any]], result: ExtractResult, generated_at: datetime | None = None
) -> dict[str, Any]:
    # Drop dangling edges (e.g. to an app that was not extracted) and duplicates.
    ids = {e["id"] for e in result.entities}
    seen: set[tuple[str, str, str]] = set()
    edges = []
    for edge in result.edges:
        key = (edge["from"], edge["to"], edge["type"])
        if edge["from"] in ids and edge["to"] in ids and key not in seen:
            seen.add(key)
            edges.append(edge)
    ts = (generated_at or datetime.now(UTC)).replace(microsecond=0)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": ts.isoformat().replace("+00:00", "Z"),
        "generator": {"name": "delvecat-ingest", "version": __version__},
        "instances": instances,
        "entities": sorted(result.entities, key=lambda e: e["id"]),
        "edges": edges,
        "ingestionReport": result.reports,
    }


def validate(bundle: dict[str, Any], schema_path: Path | None = None) -> list[str]:
    """Return a list of human-readable problems (empty when valid)."""
    schema = json.loads((schema_path or find_schema()).read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    problems = [
        f"{'/'.join(map(str, err.absolute_path)) or '<root>'}: {err.message}"
        for err in validator.iter_errors(bundle)
    ]
    ids = [e.get("id") for e in bundle.get("entities", [])]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    problems.extend(f"duplicate entity id: {d}" for d in dupes)
    return problems
