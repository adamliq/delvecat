"""Instance facts from /services/server/info."""

from __future__ import annotations

from ...model import ExtractResult
from .common import Ctx, content, split_list


def extract_server_info(ctx: Ctx, out: ExtractResult) -> int:
    body = ctx.transport.get("/services/server/info")
    entries = body.get("entry") or [{}]
    c = content(entries[0])
    cloud = (
        str(c.get("instance_type", "")).lower() == "cloud"
        or "cloud" in str(c.get("product_type", "")).lower()
    )
    out.instance_facts.update(
        {
            "version": c.get("version"),
            "roles": split_list(c.get("server_roles")),
            "kind": "splunkCloud" if cloud else "splunkEnterprise",
            "properties": {
                "serverName": c.get("serverName"),
                "productType": c.get("product_type"),
                "build": c.get("build"),
                "os": c.get("os_name"),
                "licenseState": c.get("licenseState"),
            },
        }
    )
    return 1
