"""SPL2 objects from Splunk's Data Orchestrator (Splunk 10 and later): connections, SPL2
modules and SPL2-native datasets.

The orchestrator is a sidecar service of splunkd, at /services/orchestrator/v1. Splunk 9.x
has none (404: the part is skipped); after a restart it answers 404 for about a minute
until the sidecar is up. Only GET requests are made.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qs, urlparse

from ...model import ExtractResult, entity, fqn
from ...transport import EndpointForbidden, EndpointNotFound
from .common import Ctx, app_edge, ref, to_int

API = "/services/orchestrator/v1"
PAGE = 200
MAX_PAGES = 500
# Dataset kinds that are the classic Splunk objects Licoryx Delvecat reads elsewhere.
CLASSIC_KINDS = frozenset({"index", "metricindex", "lookup", "kvcollection", "savedsearch", "job"})
# SPL2 module namespace "~.apps.<app>[...]" -> the app.
_APP_NAMESPACE = re.compile(r"^~?\.?apps\.([^.]+)")
# "from <dataset>" in SPL2; "$name" is a statement of the same module, not a dataset.
_FROM = re.compile(r"\bfrom\s+(?!\$)([A-Za-z_][\w:.-]*)", re.I)
_KIND_TARGET = {
    "index": "index",
    "metricindex": "index",
    "lookup": "lookup",
    "savedsearch": "savedSearch",
}


def _results(body: Any) -> list[dict[str, Any]]:
    if isinstance(body, list):
        return body
    return list((body or {}).get("results") or [])


def _pages(ctx: Ctx, path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    """All pages of a listing that pages with nextLink/paginationToken."""
    out: list[dict[str, Any]] = []
    query = dict(params)
    for _ in range(MAX_PAGES):
        body = ctx.transport.get(path, query)
        out.extend(_results(body))
        link = body.get("nextLink") if isinstance(body, dict) else None
        token = (
            (parse_qs(urlparse(link).query).get("paginationToken") or [None])[0] if link else None
        )
        if not token:
            break
        query = {**params, "paginationToken": token}
    return out


def _dataset_detail(ctx: Ctx, d: dict[str, Any]) -> dict[str, Any]:
    """The dataset with its properties (the list may leave them out)."""
    if any(isinstance(d.get(k), dict) for k in ("properties", "datasetConfig")):
        return d
    key = d.get("id") or d.get("resourceName")
    if not key:
        return d
    try:
        full = ctx.transport.get(f"{API}/datasets/{str(key).lstrip('~.')}", {})
    except (EndpointNotFound, EndpointForbidden):
        return d
    return {**d, **full} if isinstance(full, dict) else d


def app_of(namespace: str | None) -> str | None:
    m = _APP_NAMESPACE.match(namespace or "")
    return m.group(1) if m else None


def module_permissions(rows: list[dict[str, Any]]) -> dict[str, list[str]] | None:
    """[{role: user, operations: [read]}, ...] -> {"read": [...], "write": [...]}."""
    perms: dict[str, set[str]] = {}
    for r in rows:
        role = r.get("role")
        for op in r.get("operations") or []:
            if role and op in ("read", "write"):
                perms.setdefault(op, set()).add(role)
    return {k: sorted(v) for k, v in sorted(perms.items())} or None


def spl2_reads(definition: str, kinds: dict[str, str]) -> list[tuple[str, str]]:
    """(target type, name) for each dataset a module reads with "from <dataset>".
    The orchestrator's dataset list says what each name is; unknown names are left out."""
    out: list[tuple[str, str]] = []
    for name in _FROM.findall(definition or ""):
        name = name.removeprefix("index:")
        target = _KIND_TARGET.get(kinds.get(name, ""))
        if target and (target, name) not in out:
            out.append((target, name))
    return out


# Unified (Federated Analytics) connections and datasets reach external stores: Amazon S3,
# Azure Blob Storage / Data Lake, Snowflake, Splunk DDSS. Their credentials (auths,
# datasetSecret) are never read; only settings that say where the data is.
_SECRET_KEY = re.compile(r"(auth|secret|password|passwd|credential|token|key$|apikey)", re.I)
_LOCATION_KEYS = (
    "storageAccount",
    "container",
    "containerName",
    "directory",
    "filePrefix",
    "dataFormat",
    "compressionType",
    "region",
    "bucket",
    "database",
    "schema",
    "table",
    "warehouse",
)
_AZURE_KINDS = ("azure_blob", "azure_abs", "dmx_azure_blob")


def _location(d: dict[str, Any]) -> dict[str, Any]:
    """Where a dataset's data is, from the dataset or its properties/datasetConfig."""
    found: dict[str, Any] = {}
    for src in (d, d.get("properties"), d.get("datasetConfig"), d.get("connectionProperties")):
        if not isinstance(src, dict):
            continue
        for k in _LOCATION_KEYS:
            v = src.get(k)
            if v not in (None, "", {}, []) and k not in found and isinstance(v, (str, int)):
                found["container" if k == "containerName" else k] = v
    return found


def data_source(item: dict[str, Any]) -> str | None:
    """AWS, Azure, Snowflake, DDSS or Splunk."""
    ds = item.get("dataSource") or item.get("data_source")
    if not ds and str(item.get("kind") or "").lower() in _AZURE_KINDS:
        ds = "Azure"
    if not ds and (item.get("hostnameip") or item.get("serviceaccountuser")):
        ds = "Splunk"
    return str(ds) if ds else None


def connection_properties(c: dict[str, Any], status: str) -> dict[str, Any]:
    """A connection, Splunk or unified, without its credentials."""
    auths = c.get("auths") if isinstance(c.get("auths"), list) else []
    methods = sorted(
        {str(a.get("authMethod")) for a in auths if isinstance(a, dict) and a.get("authMethod")}
    )
    tenants = sorted(
        {str(a.get("tenantId")) for a in auths if isinstance(a, dict) and a.get("tenantId")}
    )
    props: dict[str, Any] = {
        "dataSource": data_source(c),
        "description": c.get("description") or None,
        "created": c.get("created") or None,
        "host": c.get("hostnameip") or None,
        "port": to_int(c.get("port")),
        "account": c.get("serviceaccountuser") or None,
        "connectionType": c.get("connectionType") or None,
        "supportedCapabilities": c.get("supportedCapabilities") or None,
        "accessLevel": c.get("accessLevel") or c.get("visibility") or None,
        "authMethods": methods or None,
        # Azure: the Entra ID tenant the app registration is in (an id, not a secret).
        "azureTenantId": (tenants[0] if len(tenants) == 1 else tenants) or None,
        "status": status,
    }
    props.update({k: v for k, v in _location(c).items() if not _SECRET_KEY.search(k)})
    return props


def _starting(exc: Exception) -> bool:
    """502/503/504: the orchestrator is not up yet (e.g. just after a restart)."""
    status = getattr(getattr(exc, "response", None), "status_code", None)
    return status in (502, 503, 504)


def extract_spl2(ctx: Ctx, out: ExtractResult) -> int:
    try:
        return _extract_spl2(ctx, out)
    except Exception as exc:
        if _starting(exc):
            raise EndpointNotFound(
                "SPL2 orchestrator not running yet (it starts a minute after splunkd)"
            ) from exc
        raise


def _extract_spl2(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    # Connections: the Splunk deployments SPL2 runs against. Published ones are in effect;
    # a draft is an edit not published yet. No secret is returned, only the account name.
    published = ctx.transport.get(
        f"{API}/connections", {"pageSize": 1000, "visibility": "PUBLISHED"}
    )
    try:
        drafts = ctx.transport.get(f"{API}/connections", {"pageSize": 1000, "visibility": "DRAFT"})
    except (EndpointNotFound, EndpointForbidden):
        drafts = []
    names = {c.get("name") for c in _results(published)}
    for c in [*_results(published), *(d for d in _results(drafts) if d.get("name") not in names)]:
        if not c.get("name"):
            continue
        out.entities.append(
            entity(
                id=fqn(ctx.instance, "spl2Connection", c["name"]),
                type="spl2Connection",
                name=c["name"],
                instance=ctx.instance,
                description=c.get("description") or None,
                properties=connection_properties(c, "published" if c["name"] in names else "draft"),
            )
        )
        n += 1

    # Datasets: what each name is (for module lineage), and the SPL2-native ones.
    try:
        datasets = _pages(ctx, f"{API}/datasets", {"count": PAGE})
    except (EndpointNotFound, EndpointForbidden):
        datasets = []
    kinds = {d["name"]: d.get("kind", "") for d in datasets if d.get("name")}
    for d in datasets:
        if d.get("kind") in CLASSIC_KINDS or not d.get("name"):
            continue
        app = app_of(d.get("namespace"))
        eid = fqn(ctx.instance, "spl2Dataset", d.get("resourceName") or d["name"])
        out.entities.append(
            entity(
                id=eid,
                type="spl2Dataset",
                name=d["name"],
                instance=ctx.instance,
                app=app,
                owner=d.get("owner") or d.get("createdBy") or None,
                updatedAt=d.get("updatedAt") or None,
                properties={
                    "kind": d.get("kind"),
                    "dataSource": data_source(d),
                    "connection": d.get("connection") or None,
                    **_location(_dataset_detail(ctx, d)),
                    "namespace": d.get("namespace") or None,
                    "module": d.get("module") or None,
                    "resourceName": d.get("resourceName") or None,
                },
            )
        )
        if e := app_edge(ctx, app, eid):
            out.edges.append(e)
        if d.get("connection"):
            out.refs.append(ref(eid, "spl2Connection", str(d["connection"]), "uses"))
        n += 1

    # Modules: SPL2 code saved in an app, with its own permissions.
    try:
        modules = _pages(ctx, f"{API}/spl2/modules", {"count": PAGE})
    except EndpointForbidden:
        modules = []  # needs list_spl2_modules
    for m in modules:
        namespace, name = m.get("namespace") or "", m.get("name")
        if not name:
            continue
        resource = f"{namespace}.{name}" if namespace else name
        try:
            full = ctx.transport.get(f"{API}/spl2/modules/{resource.lstrip('~.')}", {})
        except (EndpointNotFound, EndpointForbidden):
            full = m
        try:
            perms = ctx.transport.get(f"{API}/spl2/modules/permissions", {"resourceName": resource})
        except (EndpointNotFound, EndpointForbidden):
            perms = []
        app = app_of(namespace)
        definition = full.get("definition") or None
        eid = fqn(ctx.instance, "spl2Module", name, app=app or "unknown")
        out.entities.append(
            entity(
                id=eid,
                type="spl2Module",
                name=name,
                instance=ctx.instance,
                app=app,
                owner=m.get("createdBy") or None,
                description=m.get("description") or None,
                updatedAt=m.get("updatedAt") or None,
                permissions=module_permissions(_results(perms)),
                properties={
                    "namespace": namespace or None,
                    "version": m.get("version"),
                    "updatedBy": m.get("updatedBy") or None,
                    "definition": definition,
                },
            )
        )
        if e := app_edge(ctx, app, eid):
            out.edges.append(e)
        out.refs.extend(
            ref(eid, target, ds, "reads", app=app)
            for target, ds in spl2_reads(definition or "", kinds)
        )
        n += 1
    return n
