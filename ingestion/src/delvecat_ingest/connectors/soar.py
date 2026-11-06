"""Splunk SOAR connector (SOAR REST API, ``ph-auth-token`` header).

Endpoints: ``/rest/version``, ``/rest/playbook``, ``/rest/asset``, ``/rest/app``,
``/rest/custom_function`` (paged with ``page`` / ``page_size``; responses are
``{"count", "num_pages", "data": [...]}``). Asset configuration is never read
into the catalog: it holds credentials.

Lineage: ES detection --triggers--> SOAR label --triggers--> playbook; asset uses app.
Response shapes follow the SOAR REST API documentation and have not been checked
against a live SOAR server by this project yet.
"""

from __future__ import annotations

from typing import Any

from ..model import ExtractResult, edge, fqn
from ..splunk_rest import as_bool
from .splunk import run_extractors
from .splunk.common import Ctx, add_global

PRODUCT = "soar"
PAGE_SIZE = 200


def _paged(ctx: Ctx, path: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 0
    while True:
        body = ctx.transport.get(path, {"page": page, "page_size": PAGE_SIZE})
        data = body.get("data", []) if isinstance(body, dict) else []
        items.extend(data)
        pages = int(body.get("num_pages") or 1) if isinstance(body, dict) else 1
        page += 1
        if page >= pages or not data:
            return items


def _labels(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if v]
    return [v.strip() for v in str(value or "").split(",") if v.strip()]


def extract_version(ctx: Ctx, out: ExtractResult) -> int:
    body = ctx.transport.get("/rest/version")
    out.instance_facts.update({"kind": "soar", "version": body.get("version")})
    return 1


def extract_apps(ctx: Ctx, out: ExtractResult) -> int:
    apps = _paged(ctx, "/rest/app")
    for a in apps:
        add_global(
            ctx,
            out,
            "soarApp",
            a.get("name") or str(a.get("id")),
            product=PRODUCT,
            description=a.get("description") or None,
            disabled=not as_bool(a.get("enabled", True)),
            properties={
                "appId": a.get("appid"),
                "id": a.get("id"),
                "vendor": a.get("product_vendor"),
                "productName": a.get("product_name"),
                "version": a.get("app_version"),
                "publisher": a.get("publisher"),
                "type": a.get("type"),
            },
        )
    return len(apps)


def extract_assets(ctx: Ctx, out: ExtractResult) -> int:
    apps_by_id = {
        (e.get("properties") or {}).get("id"): e["name"]
        for e in out.entities
        if e["type"] == "soarApp"
    }
    assets = _paged(ctx, "/rest/asset")
    for a in assets:
        app_name = apps_by_id.get(a.get("app"))
        ent = add_global(
            ctx,
            out,
            "soarAsset",
            a.get("name") or str(a.get("id")),
            product=PRODUCT,
            description=a.get("description") or None,
            disabled=as_bool(a.get("disabled", False)),
            properties={
                "vendor": a.get("product_vendor"),
                "productName": a.get("product_name"),
                "app": app_name,
                "type": a.get("type"),
                "tags": a.get("tags") or [],
                "configured": bool(a.get("configuration")),
            },
        )
        if app_name:
            out.edges.append(edge(ent["id"], fqn(ctx.instance, "soarApp", app_name), "uses"))
    return len(assets)


def extract_playbooks(ctx: Ctx, out: ExtractResult) -> int:
    playbooks = _paged(ctx, "/rest/playbook")
    labels_seen: set[str] = set()
    for p in playbooks:
        labels = _labels(p.get("labels") or p.get("label"))
        ent = add_global(
            ctx,
            out,
            "soarPlaybook",
            p.get("name") or str(p.get("id")),
            product=PRODUCT,
            description=p.get("description") or None,
            disabled=not as_bool(p.get("active", False)),
            updatedAt=p.get("update_time") or None,
            properties={
                "id": p.get("id"),
                "repository": p.get("scm_name") or p.get("scm"),
                "category": p.get("category") or None,
                "labels": labels,
                "tags": p.get("tags") or [],
                "playbookType": p.get("playbook_type") or None,
                "pythonVersion": p.get("python_version") or None,
                "version": p.get("version"),
            },
        )
        for label in labels:
            if label == "*":
                continue  # runs on every label
            if label not in labels_seen:
                add_global(ctx, out, "soarLabel", label, product=PRODUCT)
                labels_seen.add(label)
            out.edges.append(edge(fqn(ctx.instance, "soarLabel", label), ent["id"], "triggers"))
    return len(playbooks)


def extract_custom_functions(ctx: Ctx, out: ExtractResult) -> int:
    functions = _paged(ctx, "/rest/custom_function")
    for f in functions:
        add_global(
            ctx,
            out,
            "soarCustomFunction",
            f.get("name") or str(f.get("id")),
            product=PRODUCT,
            description=f.get("description") or None,
            properties={
                "repository": f.get("scm_name") or f.get("scm"),
                "draft": as_bool(f.get("draft_mode", False)),
                "pythonVersion": f.get("python_version") or None,
            },
        )
    return len(functions)


EXTRACTORS = {
    "version": extract_version,
    "apps": extract_apps,
    "assets": extract_assets,
    "playbooks": extract_playbooks,
    "customFunctions": extract_custom_functions,
}


def extract(transport, instance: str) -> ExtractResult:
    out = ExtractResult()
    run_extractors(Ctx(transport, instance), EXTRACTORS, "soar", out)
    return out
