"""Splunk UBA (UEBA) connector.

Reads data sources, anomaly models, threat rules and output connectors from the
UBA server's REST API (bearer token). **The endpoint paths and field names here
are this project's best reading of the UBA documentation and have not been
checked against a live UBA server**; paths can be overridden with
``--ueba-path kind=/path`` and fields are read with fallbacks. Please report
differences.

Lineage: index/sourcetype → data source → model → anomaly type → threat rule →
output connector → index (typically Enterprise Security's).
"""

from __future__ import annotations

from typing import Any

from ..model import ExtractResult, edge, fqn
from ..splunk_rest import as_bool
from .splunk import run_extractors
from .splunk.common import Ctx, add_global, ref

PRODUCT = "ueba"
DEFAULT_PATHS = {
    "dataSources": "/uba/datasources",
    "models": "/uba/models",
    "threatRules": "/uba/threatrules",
    "outputConnectors": "/uba/outputconnectors",
}


def _items(body: Any) -> list[dict[str, Any]]:
    if isinstance(body, list):
        return [b for b in body if isinstance(b, dict)]
    if isinstance(body, dict):
        for key in ("data", "items", "results", "content"):
            if isinstance(body.get(key), list):
                return [b for b in body[key] if isinstance(b, dict)]
    return []


def _first(d: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        if d.get(k) not in (None, "", []):
            return d[k]
    return None


def _names(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v.get("name") if isinstance(v, dict) else v) for v in value if v]
    return [v.strip() for v in str(value or "").split(",") if v.strip()]


def _enabled(d: dict[str, Any]) -> bool:
    if "enabled" in d:
        return as_bool(d["enabled"])
    return str(d.get("status", "enabled")).lower() not in ("disabled", "stopped", "inactive")


def make_extractors(paths: dict[str, str]):
    def data_sources(ctx: Ctx, out: ExtractResult) -> int:
        items = _items(ctx.transport.get(paths["dataSources"]))
        for d in items:
            name = str(_first(d, "name", "displayName", "id"))
            index = _first(d, "index", "splunkIndex")
            sourcetype = _first(d, "sourcetype", "sourceType", "splunkSourcetype")
            ent = add_global(
                ctx,
                out,
                "uebaDataSource",
                name,
                product=PRODUCT,
                disabled=not _enabled(d),
                properties={
                    "type": _first(d, "type", "sourceType_"),
                    "format": _first(d, "format", "dataFormat"),
                    "index": index,
                    "sourcetype": sourcetype,
                    "search": _first(d, "query", "search", "splQuery"),
                    "status": d.get("status"),
                },
            )
            for i in _names(index):
                out.refs.append(ref(ent["id"], "index", i, "reads"))
            for s in _names(sourcetype):
                out.refs.append(ref(ent["id"], "sourcetype", s, "reads"))
        return len(items)

    def models(ctx: Ctx, out: ExtractResult) -> int:
        items = _items(ctx.transport.get(paths["models"]))
        for m in items:
            name = str(_first(m, "name", "displayName", "id"))
            anomalies = _names(_first(m, "anomalyTypes", "anomalies", "outputAnomalyTypes"))
            sources = _names(_first(m, "dataSources", "datasources", "inputDataSources"))
            ent = add_global(
                ctx,
                out,
                "uebaModel",
                name,
                product=PRODUCT,
                disabled=not _enabled(m),
                description=_first(m, "description") or None,
                properties={
                    "type": _first(m, "type", "modelType"),
                    "anomalyTypes": anomalies,
                    "dataSources": sources,
                },
            )
            for s in sources:
                out.refs.append(ref(ent["id"], "uebaDataSource", s, "reads"))
            for a in anomalies:
                add_global(ctx, out, "uebaAnomalyType", a, product=PRODUCT)
                out.edges.append(edge(ent["id"], fqn(ctx.instance, "uebaAnomalyType", a), "feeds"))
        return len(items)

    def threat_rules(ctx: Ctx, out: ExtractResult) -> int:
        items = _items(ctx.transport.get(paths["threatRules"]))
        for t in items:
            name = str(_first(t, "name", "displayName", "id"))
            anomalies = _names(_first(t, "anomalyTypes", "anomalies", "conditions"))
            ent = add_global(
                ctx,
                out,
                "uebaThreatRule",
                name,
                product=PRODUCT,
                disabled=not _enabled(t),
                description=_first(t, "description") or None,
                properties={
                    "threatType": _first(t, "threatType", "type"),
                    "anomalyTypes": anomalies,
                    "score": _first(t, "score", "riskScore"),
                },
            )
            for a in anomalies:
                out.refs.append(ref(ent["id"], "uebaAnomalyType", a, "uses"))
        return len(items)

    def output_connectors(ctx: Ctx, out: ExtractResult) -> int:
        items = _items(ctx.transport.get(paths["outputConnectors"]))
        rules = [e for e in out.entities if e["type"] == "uebaThreatRule"]
        for o in items:
            name = str(_first(o, "name", "displayName", "id"))
            index = _first(o, "index", "splunkIndex", "targetIndex")
            sends = [s.lower() for s in _names(_first(o, "sends", "outputTypes", "types"))]
            ent = add_global(
                ctx,
                out,
                "uebaOutputConnector",
                name,
                product=PRODUCT,
                disabled=not _enabled(o),
                properties={
                    "type": _first(o, "type", "connectorType"),
                    "index": index,
                    "sends": sends,
                    "url": _first(o, "url", "host"),
                },
            )
            if not sends or "threats" in sends:
                out.edges.extend(edge(r["id"], ent["id"], "triggers") for r in rules)
            for i in _names(index):
                out.refs.append(ref(ent["id"], "index", i, "writes"))
        return len(items)

    return {
        "dataSources": data_sources,
        "models": models,
        "threatRules": threat_rules,
        "outputConnectors": output_connectors,
    }


def extract(transport, instance: str, paths: dict[str, str] | None = None) -> ExtractResult:
    out = ExtractResult()
    out.instance_facts["kind"] = "uba"
    run_extractors(
        Ctx(transport, instance), make_extractors({**DEFAULT_PATHS, **(paths or {})}), "ueba", out
    )
    return out
