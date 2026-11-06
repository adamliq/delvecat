"""Find the searches inside Splunk dashboards (Simple XML and Dashboard Studio)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any
from xml.etree.ElementTree import Element

from defusedxml import ElementTree as SafeET  # dashboards are user content: parse defensively

MAX_QUERY_CHARS = 4000


@dataclass
class DashboardSearch:
    kind: str  # "inline" | "savedSearch" | "postProcess"
    title: str | None = None
    query: str | None = None
    ref: str | None = None  # saved search name (kind savedSearch)
    base: str | None = None  # id of the base search (kind postProcess)
    id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        d = {k: v for k, v in self.__dict__.items() if v is not None}
        if "query" in d and len(d["query"]) > MAX_QUERY_CHARS:
            d["query"] = d["query"][:MAX_QUERY_CHARS] + " …"
        return d


def parse_dashboard(source: str) -> tuple[str, list[DashboardSearch], list[str]]:
    """Return (framework, searches, warnings)."""
    source = source or ""
    if not source.strip():
        return "other", [], []
    try:
        root = SafeET.fromstring(source)
    except Exception as exc:  # malformed XML, entity tricks rejected by defusedxml, ...
        return "other", [], [f"could not parse dashboard XML: {type(exc).__name__}"]
    if root.get("version") == "2":
        return "dashboardStudio", *_studio(root)
    if root.tag in ("dashboard", "form"):
        framework = "simpleXmlForm" if root.tag == "form" else "simpleXml"
        return framework, _simple_xml(root), []
    return ("html" if root.tag == "view" else "other"), [], []


def _text(el: Element | None) -> str | None:
    if el is None or el.text is None:
        return None
    return el.text.strip() or None


def _simple_xml(root: Element) -> list[DashboardSearch]:
    found: list[DashboardSearch] = []
    seen: set[int] = set()

    def visit(el: Element, title: str | None) -> None:
        if el.tag in ("panel", "chart", "table", "event", "single", "map", "viz", "input"):
            title = _text(el.find("title")) or _text(el.find("label")) or title
        if el.tag == "search" and id(el) not in seen:
            seen.add(id(el))
            ref, base = el.get("ref"), el.get("base")
            query = _text(el.find("query"))
            if ref:
                found.append(DashboardSearch("savedSearch", title, ref=ref, id=el.get("id")))
            elif base:
                found.append(
                    DashboardSearch("postProcess", title, query=query, base=base, id=el.get("id"))
                )
            elif query:
                found.append(DashboardSearch("inline", title, query=query, id=el.get("id")))
        for child in el:
            visit(child, title)

    visit(root, None)
    return found


def _studio(root: Element) -> tuple[list[DashboardSearch], list[str]]:
    definition = _text(root.find("definition"))
    if not definition:
        return [], []
    try:
        data = json.loads(definition)
    except ValueError:
        return [], ["could not parse Dashboard Studio JSON definition"]
    titles: dict[str, str] = {}
    for viz in (data.get("visualizations") or {}).values():
        ds = (viz.get("dataSources") or {}).get("primary")
        if ds and viz.get("title"):
            titles.setdefault(ds, viz["title"])
    found = []
    for ds_id, ds in (data.get("dataSources") or {}).items():
        options = ds.get("options") or {}
        title = ds.get("name") or titles.get(ds_id)
        kind = ds.get("type")
        if kind == "ds.search" and options.get("query"):
            found.append(DashboardSearch("inline", title, query=options["query"], id=ds_id))
        elif kind == "ds.savedSearch" and options.get("ref"):
            found.append(DashboardSearch("savedSearch", title, ref=options["ref"], id=ds_id))
        elif kind == "ds.chain":
            found.append(
                DashboardSearch(
                    "postProcess",
                    title,
                    query=options.get("query"),
                    base=options.get("extend"),
                    id=ds_id,
                )
            )
    return found, []


_TOKEN = re.compile(r"\$[^$\s]+\$")


def has_tokens(query: str | None) -> bool:
    return bool(query and _TOKEN.search(query))
