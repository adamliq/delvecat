"""Data Management metadata catalog (splunk-data-management app, mdc API): the objects
Data Management knows about (sources, datasets, destinations, pipelines...).

Served by a Splunk Cloud service; Splunk Enterprise 10.4 has the app but not the
service (404: the part is skipped). GET only.
"""

from __future__ import annotations

from typing import Any

from ...model import ExtractResult, entity, fqn
from ...transport import EndpointForbidden, EndpointNotFound
from .common import Ctx, ref

PATH = "/servicesNS/-/splunk-data-management/mdc/v1alpha2/catalog-objects"
FIELDS = "id,name,resourceName,kind,type,namespace,createdBy,created"
PAGE = 100
MAX_PAGES = 500


def _items(body: Any) -> list[dict[str, Any]]:
    if isinstance(body, list):
        return [x for x in body if isinstance(x, dict)]
    if isinstance(body, dict):
        for key in ("items", "results", "objects", "data", "entry"):
            if isinstance(body.get(key), list):
                return [x for x in body[key] if isinstance(x, dict)]
    return []


def extract_catalog_objects(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for page in range(MAX_PAGES):
        try:
            body = ctx.transport.get(
                PATH,
                {"fields": FIELDS, "sort": "created DESC", "count": PAGE, "offset": page * PAGE},
            )
        except EndpointForbidden:
            raise
        except EndpointNotFound:
            if page == 0:
                raise
            break
        items = _items(body)
        for o in items:
            name = o.get("name") or o.get("resourceName") or o.get("id")
            if not name:
                continue
            key = o.get("resourceName") or o.get("id") or name
            eid = fqn(ctx.instance, "dmCatalogObject", str(key))
            kind = str(o.get("kind") or "")
            out.entities.append(
                entity(
                    id=eid,
                    type="dmCatalogObject",
                    name=str(name),
                    instance=ctx.instance,
                    owner=o.get("createdBy") or None,
                    properties={
                        "catalogId": o.get("id") or None,
                        "resourceName": o.get("resourceName") or None,
                        "kind": kind or None,
                        "objectType": o.get("type") or None,
                        "namespace": o.get("namespace") or None,
                        "createdBy": o.get("createdBy") or None,
                        "created": o.get("created") or None,
                    },
                )
            )
            # An index the catalog describes is the index itself.
            if "index" in kind.lower():
                out.refs.append(ref(eid, "index", str(name), "mapsTo"))
            n += 1
        if len(items) < PAGE:
            break
    return n
