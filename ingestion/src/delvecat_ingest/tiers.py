"""Join deployment servers in tiers when their builds are merged.

A second-tier deployment server is a deployment client of an upstream one: the upstream
lists it among its clients, and it receives apps into its own ``deployment-apps`` folder
to pass on to its forwarders. With both built and merged, this step:

- recognises the upstream's client record as the downstream server (same GUID as the
  downstream's ``server/info``, else the same host name) and marks it
  (``deploymentServerInstance``); the downstream instance gets ``upstreamInstance`` and
  every deployment server its ``deploymentTier`` (1 = top);
- links each upstream app to the downstream copy it becomes (``deploys``), and marks that
  copy ``receivedFrom``; downstream apps not from upstream are ``origin: local``;
- flags classes that send apps to a server that passes them on with a ``stateOnClient``
  other than ``noop``: that server cannot enable them, so the install fails at every
  phone home;
- marks a forwarder moved from one deployment server to another (the same GUID listed by
  both): the older record gets ``movedTo`` and no longer counts as not phoning home.
"""

from __future__ import annotations

from typing import Any

from .health import SEVERITY

DS_TYPES = ("serverClass", "deploymentApp")


def _set_health(e: dict[str, Any], checks: list[dict[str, str]]) -> None:
    if checks:
        worst = max(checks, key=lambda c: SEVERITY[c["status"]])["status"]
        e["health"] = {"status": worst, "checks": checks}
    else:
        e.pop("health", None)


def _tier(inst: str, upstream: dict[str, str], seen: frozenset = frozenset()) -> int:
    up = upstream.get(inst)
    if not up or up in seen:
        return 1
    return 1 + _tier(up, upstream, seen | {inst})


def link_deployment_tiers(
    entities: list[dict[str, Any]], instances: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Annotate tiers in place; returns the new upstream app → downstream app edges."""
    ds_ids = {e["instance"] for e in entities if e["type"] in DS_TYPES}
    if not ds_ids:
        return []
    by_guid: dict[str, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    for inst in instances:
        p = inst.get("properties") or {}
        if p.get("guid"):
            by_guid[str(p["guid"]).upper()] = inst
        if p.get("serverName"):
            by_name[str(p["serverName"]).lower()] = inst
    apps = {(e["instance"], e["name"]): e for e in entities if e["type"] == "deploymentApp"}
    classes = {(e["instance"], e["name"]): e for e in entities if e["type"] == "serverClass"}
    clients = [e for e in entities if e["type"] == "deploymentClient"]
    upstream: dict[str, str] = {}
    edges: list[dict[str, Any]] = []
    for c in clients:
        p = c.setdefault("properties", {})
        host = str(p.get("hostname") or c["name"]).lower()
        inst = by_guid.get(str(p.get("guid") or "").upper()) or by_name.get(host)
        if not inst or inst["id"] == c["instance"] or inst["id"] not in ds_ids:
            continue
        p["deploymentServerInstance"] = inst["id"]
        upstream[inst["id"]] = c["instance"]
        ip = inst.setdefault("properties", {})
        conf = ip.setdefault("deploymentClient", {})
        conf["upstreamInstance"] = c["instance"]
        relays = conf.get("relaysApps") is not False
        received = set()
        for name in (p.get("observed") or {}).get("apps") or {}:
            up, down = apps.get((c["instance"], name)), apps.get((inst["id"], name))
            if relays and up and down:
                edges.append(
                    {"from": up["id"], "to": down["id"], "type": "deploys", "origin": "connector"}
                )
                down.setdefault("properties", {})["receivedFrom"] = up["id"]
                received.add(name)
        if relays:
            for (i, name), a in apps.items():
                if i == inst["id"]:
                    a.setdefault("properties", {}).setdefault(
                        "origin", "upstream" if name in received else "local"
                    )
            _relay_checks(c, inst["id"], classes)
    for inst in instances:
        if inst["id"] in ds_ids:
            inst.setdefault("properties", {})["deploymentTier"] = _tier(inst["id"], upstream)
    _moved(clients)
    return edges


def _relay_checks(
    client: dict[str, Any], downstream: str, classes: dict[tuple[str, str], dict[str, Any]]
) -> None:
    """Classes sending apps to a server that passes them on must not try to enable them."""
    bad: dict[str, list[str]] = {}
    for cls in (client.get("properties") or {}).get("serverClasses") or []:
        sc = classes.get((client["instance"], cls))
        for app, st in ((sc or {}).get("properties") or {}).get("appSettings", {}).items():
            if st.get("stateOnClient", "enabled") != "noop":
                bad.setdefault(cls, []).append(app)
    if not bad:
        return
    checks = [c for c in (client.get("health") or {}).get("checks", []) if c["check"] != "relay"]
    detail = "; ".join(f"{cls}: {', '.join(sorted(a))}" for cls, a in sorted(bad.items()))
    checks.append(
        {
            "check": "relay",
            "status": "warning",
            "message": f"Deployment server {downstream} passes apps on, but these server "
            f"classes send it apps to enable ({detail}). It cannot enable them, so they fail "
            "to install at every phone home: set stateOnClient = noop or keep it out of "
            "these classes",
        }
    )
    _set_health(client, checks)


def _last_phone_home(c: dict[str, Any]) -> str:
    return ((c.get("properties") or {}).get("observed") or {}).get("lastPhoneHome") or ""


def _moved(clients: list[dict[str, Any]]) -> None:
    """A forwarder listed by two deployment servers moved: the older record is stale."""
    by_guid: dict[str, list[dict[str, Any]]] = {}
    for c in clients:
        p = c.get("properties") or {}
        if p.get("guid") and not p.get("deploymentServerInstance"):
            by_guid.setdefault(str(p["guid"]).upper(), []).append(c)
    for records in by_guid.values():
        if len({c["instance"] for c in records}) < 2:
            continue
        current = max(records, key=_last_phone_home)
        for c in records:
            if c is current:
                continue
            c["properties"]["movedTo"] = current["instance"]
            checks = (c.get("health") or {}).get("checks", [])
            _set_health(c, [x for x in checks if x["check"] != "phoneHome"])
