"""Enterprise Security connector: threat intelligence sources, asset & identity sources,
analytic stories, review statuses and suppressions, and (ES 8, Mission Control) finding
aggregation and suppression rules, automation rules, queues and the SOAR apps configured
for ES. Detections themselves come from the saved-search extractor.

All three are ordinary Splunk configuration (``inputs.conf`` modular inputs
``threatlist://`` and ``identity_manager://``, ESCU's ``analyticstories.conf``),
read through the generic ``configs/conf-*`` endpoints.
"""

from __future__ import annotations

import re
from typing import Any

from ..model import ExtractResult, edge
from ..splunk_rest import as_bool, iter_entries
from ..transport import EndpointNotFound
from .splunk import run_extractors
from .splunk.common import NS, Ctx, acl, add_global, content, epoch_to_iso, ref, split_list

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


# --- triage: review statuses and suppressions ------------------------------------------


def extract_review_statuses(ctx: Ctx, out: ExtractResult) -> int:
    """Statuses a finding (notable) or investigation moves through; "end" ones close it."""
    n = 0
    for e in iter_entries(ctx.transport, "/services/alerts/reviewstatuses", {"count": -1}):
        c = content(e)
        add_global(
            ctx,
            out,
            "esReviewStatus",
            e["name"],
            product=PRODUCT,
            app=acl(e)[0],
            displayName=c.get("label") or None,
            description=c.get("description") or None,
            disabled=as_bool(c.get("disabled", False)),
            properties={
                "statusType": c.get("status_type") or None,
                "default": as_bool(c.get("default", False)),
                "closes": as_bool(c.get("end", False)),
                "hidden": as_bool(c.get("hidden", False)),
            },
        )
        n += 1
    return n


_SOURCE = re.compile(r'\bsource\s*=\s*(?:"([^"]+)"|(\S+))', re.I)
_TIME = re.compile(r"\b_time\s*(<=?|>=?)\s*(\d+(?:\.\d+)?)")


def suppression_scope(search: str) -> dict[str, Any]:
    """What a suppression search covers: the detections (source=) it names, its time
    window (_time bounds), and whether anything else narrows it."""
    detections = [a or b for a, b in _SOURCE.findall(search or "")]
    start = end = None
    for op, value in _TIME.findall(search or ""):
        if op.startswith("<"):
            end = epoch_to_iso(value)
        else:
            start = epoch_to_iso(value)
    rest = _TIME.sub(" ", _SOURCE.sub(" ", search or ""))
    rest = re.sub(r"\b(AND|OR)\b|[()]", " ", rest, flags=re.I).strip()
    return {
        "detections": detections,
        "start": start,
        "end": end,
        "conditions": bool(rest),
    }


def extract_suppressions(ctx: Ctx, out: ExtractResult) -> int:
    """Finding (notable event) suppressions: eventtypes "notable_suppression-<name>"."""
    n = 0
    path = "/servicesNS/nobody/SplunkEnterpriseSecuritySuite/alerts/suppressions"
    for e in iter_entries(ctx.transport, path, {"count": -1}):
        c = content(e)
        name = e["name"].removeprefix("notable_suppression-")
        search = str(c.get("search") or "")
        scope = suppression_scope(search)
        ent = add_global(
            ctx,
            out,
            "esSuppression",
            name,
            product=PRODUCT,
            app=acl(e)[0],
            description=c.get("description") or None,
            disabled=as_bool(c.get("disabled", False)),
            properties={
                "kind": "notable",
                "search": search or None,
                "detections": scope["detections"],
                "start": scope["start"],
                "end": scope["end"],
                "wholeDetection": bool(scope["detections"]) and not scope["conditions"],
            },
        )
        out.refs.extend(ref(ent["id"], "correlationSearch", d, "uses") for d in scope["detections"])
        n += 1
    return n


# --- Mission Control (ES 8): aggregation, automation, queues, SOAR apps ----------------

MC = "/servicesNS/nobody/missioncontrol"
_SECRET = re.compile(r"(secret|password|passwd|token|api_?key|credential|auth)", re.I)
_MC_SCALARS = (str, int, float, bool)


def _mc_items(body: Any) -> list[dict[str, Any]]:
    """Mission Control answers a list, or an object holding one (items, results, data...)."""
    if isinstance(body, list):
        return [x for x in body if isinstance(x, dict)]
    if isinstance(body, dict):
        for key in ("items", "results", "data", "rules", "queues", "apps", "entry", "records"):
            if isinstance(body.get(key), list):
                return [x for x in body[key] if isinstance(x, dict)]
        lists = [v for v in body.values() if isinstance(v, list)]
        if len(lists) == 1:
            return [x for x in lists[0] if isinstance(x, dict)]
    return []


def _mc_get(ctx: Ctx, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 0
    while True:
        query = {"page_size": 100, "page": page, **(params or {})}
        batch = _mc_items(ctx.transport.get(f"{MC}/{path}", query))
        items.extend(batch)
        if len(batch) < 100 or page >= 200:
            return items
        page += 1


def _names(value: Any) -> list[str]:
    """Names in a value: "a", ["a", "b"], {"name": "a"}, [{"name": "a"}, ...]."""
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, dict):
        v = value.get("name") or value.get("title") or value.get("label")
        return [str(v)] if v else []
    if isinstance(value, list):
        return [n for x in value for n in _names(x)]
    return []


def _refs_by_key(item: dict[str, Any], words: tuple[str, ...]) -> list[str]:
    """Names under keys containing any of words (e.g. "playbook"), one level deep."""
    out: list[str] = []
    for k, v in item.items():
        if any(w in k.lower() for w in words) and not k.lower().endswith("_id"):
            out.extend(n for n in _names(v) if n not in out)
        elif isinstance(v, dict):
            out.extend(n for n in _refs_by_key(v, words) if n not in out)
    return out


def _mc_permissions(item: dict[str, Any]) -> dict[str, list[str]] | None:
    p = item.get("permissions")
    if isinstance(p, dict):
        out = {k: sorted(set(_names(p.get(k)))) for k in ("read", "write") if p.get(k)}
        return out or None
    if isinstance(p, list):
        perms: dict[str, set[str]] = {}
        for x in p:
            if not isinstance(x, dict):
                continue
            role = x.get("role") or x.get("name")
            for op in _names(x.get("operations") or x.get("permissions") or x.get("access")):
                if role and op in ("read", "write"):
                    perms.setdefault(op, set()).add(str(role))
        return {k: sorted(v) for k, v in perms.items()} or None
    return None


def _mc_entity(ctx: Ctx, out: ExtractResult, type_: str, item: dict[str, Any], **extra):
    """One Mission Control object: its name, state and plain settings (never secrets)."""
    name = str(item.get("name") or item.get("title") or item.get("label") or item.get("id"))
    enabled = item.get("enabled", item.get("is_enabled"))
    disabled = (
        (not as_bool(enabled)) if enabled is not None else as_bool(item.get("disabled", False))
    )
    settings = {
        k: v
        for k, v in item.items()
        if isinstance(v, _MC_SCALARS)
        and not _SECRET.search(k)
        and k not in ("name", "title", "label", "description", "enabled", "is_enabled", "disabled")
        and not (isinstance(v, str) and len(v) > 500)
    }
    return add_global(
        ctx,
        out,
        type_,
        name,
        product=PRODUCT,
        description=item.get("description") or None,
        disabled=disabled,
        updatedAt=item.get("updated_time")
        or item.get("update_time")
        or item.get("updatedAt")
        or None,
        permissions=_mc_permissions(item),
        properties={**settings, **extra},
    )


def extract_aggregation_rules(ctx: Ctx, out: ExtractResult) -> int:
    """Finding aggregation rules (grouping findings into finding groups) and finding
    suppression rules (ES 8)."""
    n = 0
    seen: set[str] = set()
    for rule_type, params in (("aggregation", {}), ("suppression", {"rule_type": "suppression"})):
        try:
            items = _mc_get(ctx, "v2/finding_aggregation", params)
        except EndpointNotFound:
            if rule_type == "aggregation":
                raise
            continue
        for item in items:
            key = str(item.get("id") or item.get("_key") or item.get("name"))
            if key in seen:  # the unfiltered list may hold suppression rules too
                continue
            seen.add(key)
            kind = str(item.get("rule_type") or rule_type)
            ent = _mc_entity(
                ctx,
                out,
                "esSuppression" if kind == "suppression" else "esAggregationRule",
                item,
                kind="findingRule" if kind == "suppression" else None,
                ruleType=kind,
            )
            for d in _refs_by_key(item, ("detection", "rule_name", "search_name", "source")):
                out.refs.append(ref(ent["id"], "correlationSearch", d, "uses"))
            n += 1
    return n


def extract_automation_rules(ctx: Ctx, out: ExtractResult) -> int:
    """Automation rules: run SOAR playbooks (or actions) on findings that match."""
    n = 0
    for item in _mc_get(ctx, "v1/automation_rule"):
        ent = _mc_entity(ctx, out, "esAutomationRule", item)
        for p in _refs_by_key(item, ("playbook",)):
            out.refs.append(ref(ent["id"], "soarPlaybook", p, "uses"))
        for d in _refs_by_key(item, ("detection",)):
            out.refs.append(ref(ent["id"], "correlationSearch", d, "uses"))
        n += 1
    return n


def extract_queues(ctx: Ctx, out: ExtractResult) -> int:
    """Queues findings and investigations are worked in, with who may see them."""
    n = 0
    for item in _mc_get(ctx, "v2/queues", {"include_permissions": "true"}):
        _mc_entity(ctx, out, "esQueue", item)
        n += 1
    return n


def extract_soar_apps(ctx: Ctx, out: ExtractResult) -> int:
    """SOAR apps configured for ES (the connectors automation runs actions through)."""
    n = 0
    items = _mc_get(ctx, "v1/soar/app", {"configured": "true", "sort": "name", "order": "asc"})
    for item in items:
        _mc_entity(ctx, out, "soarApp", item, configuredInES=True)
        n += 1
    return n


EXTRACTORS = {
    "threatIntel": extract_threat_intel,
    "assetIdentity": extract_asset_identity,
    "analyticStories": extract_analytic_stories,
    "reviewStatuses": extract_review_statuses,
    "suppressions": extract_suppressions,
    "aggregationRules": extract_aggregation_rules,
    "automationRules": extract_automation_rules,
    "queues": extract_queues,
    "soarApps": extract_soar_apps,
}


def extract(transport, instance: str) -> ExtractResult:
    out = ExtractResult()
    run_extractors(Ctx(transport, instance), EXTRACTORS, "enterpriseSecurity", out)  # shared cache
    return out


__all__ = ["edge", "extract"]
