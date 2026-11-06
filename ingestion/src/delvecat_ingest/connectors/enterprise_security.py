"""Enterprise Security connector: threat intelligence sources, asset & identity sources,
analytic stories. Detections themselves come from the saved-search extractor.

All three are ordinary Splunk configuration (``inputs.conf`` modular inputs
``threatlist://`` and ``identity_manager://``, ESCU's ``analyticstories.conf``),
read through the generic ``configs/conf-*`` endpoints.
"""

from __future__ import annotations

from ..model import ExtractResult, edge
from ..splunk_rest import as_bool, iter_entries
from .splunk import run_extractors
from .splunk.common import NS, Ctx, acl, add_global, content, ref, split_list

PRODUCT = "enterpriseSecurity"


def _inputs(ctx: Ctx, scheme: str):
    # One read of inputs.conf serves every modular-input scheme (and keeps recordings simple).
    if "conf-inputs" not in ctx.cache:
        ctx.cache["conf-inputs"] = list(iter_entries(ctx.transport, f"{NS}/configs/conf-inputs"))
    for e in ctx.cache["conf-inputs"]:
        if e["name"].startswith(f"{scheme}://"):
            yield e, e["name"][len(scheme) + 3 :], content(e)


def extract_threat_intel(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e, name, c in _inputs(ctx, "threatlist"):
        add_global(
            ctx,
            out,
            "threatIntelSource",
            name,
            product=PRODUCT,
            app=acl(e)[0],
            description=c.get("description") or None,
            disabled=as_bool(c.get("disabled", False)),
            properties={
                "url": c.get("url") or None,
                "type": c.get("type") or None,
                "weight": c.get("weight") or None,
                "intervalSecs": c.get("interval") or None,
                "category": c.get("category") or None,
            },
        )
        n += 1
    return n


def extract_asset_identity(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e, name, c in _inputs(ctx, "identity_manager"):
        url = c.get("url") or ""
        ent = add_global(
            ctx,
            out,
            "assetIdentitySource",
            name,
            product=PRODUCT,
            app=acl(e)[0],
            description=c.get("description") or None,
            disabled=as_bool(c.get("disabled", False)),
            properties={
                "target": c.get("target") or c.get("category") or None,
                "category": c.get("category") or None,
                "url": url or None,
            },
        )
        if url.startswith("lookup://"):
            out.refs.append(
                ref(ent["id"], "lookup", url[len("lookup://") :], "reads", app=acl(e)[0])
            )
        n += 1
    return n


def extract_analytic_stories(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, f"{NS}/configs/conf-analyticstories"):
        name = e["name"]
        if name == "default":
            continue
        if name.startswith("analytic_story://"):
            name = name[len("analytic_story://") :]
        c = content(e)
        add_global(
            ctx,
            out,
            "analyticStory",
            name,
            product=PRODUCT,
            app=acl(e)[0],
            description=c.get("description") or None,
            properties={
                "category": split_list(c.get("category")),
                "narrative": c.get("narrative") or None,
                "references": split_list(c.get("references")),
            },
        )
        n += 1
    return n


EXTRACTORS = {
    "threatIntel": extract_threat_intel,
    "assetIdentity": extract_asset_identity,
    "analyticStories": extract_analytic_stories,
}


def extract(transport, instance: str) -> ExtractResult:
    out = ExtractResult()
    run_extractors(Ctx(transport, instance), EXTRACTORS, "enterpriseSecurity", out)  # shared cache
    return out


__all__ = ["edge", "extract"]
