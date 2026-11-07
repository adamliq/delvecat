"""Merge human-curated annotations (``annotations/**/*.yaml``) into a bundle.

An annotation file looks like::

    annotations:
      - id: acme:index:web                  # one entity
        description: Storefront access logs.
        owners: [web-team]
        classifications: [PII.IPAddress]
      - match: {type: savedSearch, app: acme_web, name: "Web - *"}   # many entities
        owners: [web-team]
    glossary:
      - term: Storefront
        description: The public e-commerce site.

Selector entries apply first (in file order), then ``id`` entries, so a specific
annotation always wins over a broad one. List fields are unioned; the last
description wins. Annotations never change an entity's catalog version.
"""

from __future__ import annotations

import fnmatch
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator, FormatChecker

from .bundle import find_schema

LIST_FIELDS = ("owners", "tags", "classifications", "glossaryTerms")
MATCH_KEYS = ("type", "product", "instance", "app", "name", "owner")


class AnnotationError(ValueError):
    """One or more annotation files are invalid; ``problems`` lists them with locations."""

    def __init__(self, problems: list[str]):
        super().__init__("\n".join(problems))
        self.problems = problems


@dataclass
class Entry:
    data: dict[str, Any]
    source: str  # e.g. "annotations/acme/web.yaml:12"


@dataclass
class AnnotationSet:
    entries: list[Entry] = field(default_factory=list)
    glossary: list[dict[str, Any]] = field(default_factory=list)
    classifications: list[dict[str, Any]] = field(default_factory=list)
    domains: list[dict[str, Any]] = field(default_factory=list)
    data_products: list[dict[str, Any]] = field(default_factory=list)
    files: int = 0


def _entry_lines(text: str) -> tuple[list[int], list[int]]:
    """1-based line numbers of each item under ``annotations`` and ``glossary``."""
    lines: dict[str, list[int]] = {"annotations": [], "glossary": []}
    node = yaml.compose(text, Loader=yaml.SafeLoader)
    if isinstance(node, yaml.MappingNode):
        for key, value in node.value:
            if key.value in lines and isinstance(value, yaml.SequenceNode):
                lines[key.value] = [item.start_mark.line + 1 for item in value.value]
    return lines["annotations"], lines["glossary"]


def load_annotations(directory: Path) -> AnnotationSet:
    """Load and validate every ``*.yaml`` / ``*.yml`` file under ``directory``."""
    schema = json.loads(find_schema(name="annotations.schema.json").read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    result = AnnotationSet()
    problems: list[str] = []
    files = sorted([*directory.rglob("*.yaml"), *directory.rglob("*.yml")])
    for file in files:
        rel = (Path(directory.name) / file.relative_to(directory)).as_posix()
        text = file.read_text(encoding="utf-8")
        try:
            data = yaml.safe_load(text) or {}
            ann_lines, term_lines = _entry_lines(text)
        except yaml.YAMLError as exc:
            problems.append(f"{rel}: invalid YAML: {exc}")
            continue
        errors = sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
        for err in errors:
            path = list(err.absolute_path)
            line = ""
            if len(path) >= 2 and path[0] in ("annotations", "glossary"):
                index = path[1]
                found = ann_lines if path[0] == "annotations" else term_lines
                if isinstance(index, int) and index < len(found):
                    line = f":{found[index]}"
            where = "/".join(map(str, path)) or "<root>"
            problems.append(f"{rel}{line}: {where}: {err.message}")
        if errors:
            continue
        result.files += 1
        for i, entry in enumerate(data.get("annotations", [])):
            line = ann_lines[i] if i < len(ann_lines) else 0
            result.entries.append(Entry(entry, f"{rel}:{line}"))
        for i, term in enumerate(data.get("glossary", [])):
            line = term_lines[i] if i < len(term_lines) else 0
            result.glossary.append({**term, "source": f"{rel}:{line}"})
        for c in data.get("classifications", []):
            result.classifications.append({**c, "source": rel})
        for d in data.get("domains", []):
            result.domains.append({**d, "source": rel})
        for p in data.get("dataProducts", []):
            result.data_products.append({**p, "source": rel})
    for kind, items in (("domain", result.domains), ("data product", result.data_products)):
        names: dict[str, str] = {}
        for item in items:
            key = item["name"].lower()
            if key in names:
                problems.append(
                    f"{item['source']}: {kind} {item['name']!r} is already defined in {names[key]}"
                )
            names[key] = item["source"]
    seen: dict[str, str] = {}
    for term in result.glossary:
        key = term["term"].lower()
        if key in seen:
            problems.append(
                f"{term['source']}: glossary term {term['term']!r} is already "
                f"defined at {seen[key]}"
            )
        seen[key] = term["source"]
    if problems:
        raise AnnotationError(problems)
    return result


def _matches(selector: dict[str, str], entity: dict[str, Any]) -> bool:
    for key in MATCH_KEYS:
        if key not in selector:
            continue
        value = entity.get(key)
        if value is None:
            return False
        if key in ("name", "app", "owner"):
            if not fnmatch.fnmatchcase(str(value), selector[key]):
                return False
        elif str(value) != selector[key]:
            return False
    return True


def _apply(entity: dict[str, Any], entry: Entry) -> None:
    ann = entity.setdefault("annotations", {})
    data = entry.data
    if (data.get("description") or "").strip():  # an empty template field changes nothing
        ann["description"] = data["description"].strip()
    if (data.get("domain") or "").strip():  # one domain per object; the last applied wins
        ann["domain"] = data["domain"].strip()
    for key in LIST_FIELDS:
        for item in data.get(key, []):
            ann.setdefault(key, [])
            if item not in ann[key]:
                ann[key].append(item)
    for link in data.get("links", []):
        links = ann.setdefault("links", [])
        if all(existing["url"] != link["url"] for existing in links):
            links.append(link)
    ann.setdefault("sources", []).append(entry.source)


def _apply_domains_and_products(
    bundle: dict[str, Any], annotations: AnnotationSet, unmatched: list[str]
) -> list[str]:
    """Publish domain and data product definitions; resolve each product's assets.
    Returns notes about references to domains that are not defined."""
    entities = bundle["entities"]
    by_id = {e["id"]: e for e in entities}
    keep = ("name", "description", "owners", "parent", "links", "source")
    domains = [{k: d[k] for k in keep if d.get(k)} for d in annotations.domains]
    products = []
    for p in annotations.data_products:
        assets: list[str] = []
        for i, spec in enumerate(p.get("assets", [])):
            if "id" in spec:
                hits = [by_id[spec["id"]]] if spec["id"] in by_id else []
            else:
                hits = [e for e in entities if _matches(spec["match"], e)]
            if not hits:
                unmatched.append(f"{p['source']} (data product {p['name']!r} asset {i + 1})")
            for e in hits:
                if e["id"] not in assets:
                    assets.append(e["id"])
                listed = e.setdefault("annotations", {}).setdefault("dataProducts", [])
                if p["name"] not in listed:
                    listed.append(p["name"])
        products.append(
            {**{k: p[k] for k in (*keep, "domain") if p.get(k)}, "assets": sorted(assets)}
        )
    for key, items in (("domains", domains), ("dataProducts", products)):
        if items:
            bundle[key] = sorted(items, key=lambda x: x["name"].lower())
        else:
            bundle.pop(key, None)

    defined = {d["name"] for d in domains}
    used = {(e.get("annotations") or {}).get("domain") for e in entities} - {None}
    used |= {p["domain"] for p in products if p.get("domain")}
    used |= {d["parent"] for d in domains if d.get("parent")}
    missing = sorted(used - defined)
    return [f"domains used but not defined: {', '.join(missing[:10])}"] if missing else []


def apply_annotations(
    bundle: dict[str, Any],
    annotations: AnnotationSet,
    source: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Apply annotations to ``bundle`` in place and return a connector report.

    Existing annotations in the bundle are replaced, so re-annotating is idempotent.
    """
    entities = bundle["entities"]
    by_id = {e["id"]: e for e in entities}
    for e in entities:
        e.pop("annotations", None)
    unmatched: list[str] = []
    selectors = [e for e in annotations.entries if "match" in e.data]
    exact = [e for e in annotations.entries if "id" in e.data]
    for entry in selectors:
        hits = [e for e in entities if _matches(entry.data["match"], e)]
        if not hits:
            unmatched.append(f"{entry.source} (match {entry.data['match']})")
        for e in hits:
            _apply(e, entry)
    for entry in exact:
        target = by_id.get(entry.data["id"])
        if target is None:
            unmatched.append(f"{entry.source} ({entry.data['id']})")
        else:
            _apply(target, entry)
            target["annotations"]["primarySource"] = entry.source

    if annotations.glossary:
        bundle["glossary"] = sorted(annotations.glossary, key=lambda t: t["term"].lower())
    else:
        bundle.pop("glossary", None)
    if source:
        bundle["annotationSource"] = source
    if annotations.classifications:
        bundle["classifications"] = sorted(annotations.classifications, key=lambda c: c["name"])
    else:
        bundle.pop("classifications", None)
    domain_notes = _apply_domains_and_products(bundle, annotations, unmatched)
    from .governance import apply_governance  # classifications drive governance

    apply_governance(bundle)

    # Terms used on entities but not defined anywhere are worth flagging too.
    defined = {t["term"].lower() for t in annotations.glossary}
    for t in (t.get("synonyms", []) for t in annotations.glossary):
        defined.update(s.lower() for s in t)
    undefined = sorted(
        {
            term
            for e in entities
            for term in (e.get("annotations") or {}).get("glossaryTerms", [])
            if term.lower() not in defined
        }
    )

    annotated = sum(1 for e in entities if "annotations" in e)
    report: dict[str, Any] = {
        "connector": "annotations",
        "status": "partial" if unmatched else "ok",
        "counts": {
            "files": annotations.files,
            "entries": len(annotations.entries),
            "annotatedEntities": annotated,
            "unmatchedEntries": len(unmatched),
            "glossaryTerms": len(annotations.glossary),
            "domains": len(annotations.domains),
            "dataProducts": len(annotations.data_products),
        },
    }
    notes = []
    if unmatched:
        notes.append("entries that matched nothing: " + "; ".join(unmatched[:10]))
    if undefined:
        notes.append("glossary terms used but not defined: " + ", ".join(undefined[:10]))
    notes.extend(domain_notes)
    if notes:
        report["message"] = " | ".join(notes)
    reports = [r for r in bundle.get("ingestionReport", []) if r["connector"] != "annotations"]
    bundle["ingestionReport"] = [*reports, report]
    return report
