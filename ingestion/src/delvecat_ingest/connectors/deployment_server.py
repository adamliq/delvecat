"""Deployment Server connector: server classes, deployment apps, clients, pushed inputs.

REST (on the Deployment Server): ``deployment/server/{serverclasses,applications,clients}``
and ``configs/conf-serverclass`` for the class → app mapping. Optionally reads the
deployment apps folder (``--deployment-apps-dir``) to catalogue the inputs each app
pushes to forwarders, which REST does not expose.

Two tiers: a deployment server can itself be a deployment client of an upstream one,
receiving apps into its own ``deployment-apps`` folder and passing them on. Each server
records that (``clientConfig``: upstream, repository location, which apps came from
upstream); ``tiers.link_deployment_tiers`` joins the tiers when their builds are merged.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..confparse import read_app_conf
from ..model import ExtractResult, edge, fqn
from ..splunk_rest import as_bool, iter_entries
from ..transport import EndpointForbidden, EndpointNotFound
from .splunk import run_extractors
from .splunk.common import Ctx, add_global, content, epoch_to_iso, ref, split_list, to_int

PRODUCT = "deploymentServer"
NS_SYSTEM = "/servicesNS/nobody/system"
INPUT_KINDS = (
    "monitor",
    "batch",
    "tcp",
    "udp",
    "splunktcp",
    "script",
    "http",
    "WinEventLog",
    "wineventlog",
    "perfmon",
    "WinHostMon",
    "WinNetMon",
    "WinRegMon",
    "fschange",
    "journald",
    "powershell",
    "admon",
)


def _numbered(c: dict[str, Any], prefix: str) -> list[str]:
    items = [
        (int(k.rsplit(".", 1)[1]), v)
        for k, v in c.items()
        if k.startswith(prefix + ".") and k.rsplit(".", 1)[1].isdigit()
    ]
    return [v for _, v in sorted(items) if v]


def extract_server_classes(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, "/services/deployment/server/serverclasses"):
        c = content(e)
        add_global(
            ctx,
            out,
            "serverClass",
            e["name"],
            product=PRODUCT,
            updatedAt=epoch_to_iso(c.get("loadTime")),
            properties={
                "whitelist": _numbered(c, "whitelist"),
                "blacklist": _numbered(c, "blacklist"),
                "machineTypesFilter": c.get("machineTypesFilter") or None,
                "restartSplunkd": as_bool(c.get("restartSplunkd", False)),
                "stateOnClient": c.get("stateOnClient"),
                "repositoryLocation": c.get("repositoryLocation") or None,
            },
        )
        n += 1
    return n


def extract_class_apps(ctx: Ctx, out: ExtractResult) -> int:
    """``serverClass:<class>:app:<app>`` stanzas are the authoritative class → app mapping.

    Each class also records the settings its apps get (``appSettings``): a setting on the
    class:app stanza wins over the class, which wins over ``[global]``."""
    stanzas = {
        e["name"]: content(e)
        for e in iter_entries(ctx.transport, f"{NS_SYSTEM}/configs/conf-serverclass")
    }
    glob = stanzas.get("global", {})
    settings: dict[str, dict[str, dict[str, Any]]] = {}
    n = 0
    for name, c in stanzas.items():
        parts = name.split(":")
        if len(parts) == 4 and parts[0] == "serverClass" and parts[2] == "app":
            cls, app = parts[1], parts[3]
            levels = (c, stanzas.get(f"serverClass:{cls}", {}), glob)

            def pick(key: str, default: Any, levels: tuple = levels) -> Any:
                for level in levels:
                    if level.get(key) not in (None, ""):
                        return level[key]
                return default

            settings.setdefault(cls, {})[app] = {
                "restartSplunkd": as_bool(pick("restartSplunkd", False)),
                "stateOnClient": str(pick("stateOnClient", "enabled")),
            }
            out.edges.append(
                edge(
                    fqn(ctx.instance, "serverClass", cls),
                    fqn(ctx.instance, "deploymentApp", app),
                    "deploys",
                )
            )
            n += 1
    for cls, apps in settings.items():
        add_global(
            ctx,
            out,
            "serverClass",
            cls,
            product=PRODUCT,
            properties={"appSettings": dict(sorted(apps.items()))},
        )
    return n


def extract_applications(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, "/services/deployment/server/applications"):
        c = content(e)
        ent = add_global(
            ctx,
            out,
            "deploymentApp",
            e["name"],
            product=PRODUCT,
            properties={
                "restartSplunkd": as_bool(c.get("restartSplunkd", False)),
                "stateOnClient": c.get("stateOnClient"),
            },
            observed={
                "checksum": c.get("checksum") if c.get("checksum") not in ("0", 0) else None,
                "sizeBytes": to_int(c.get("size")) if to_int(c.get("size")) != -1 else None,
            },
        )
        out.edges.extend(
            edge(fqn(ctx.instance, "serverClass", s), ent["id"], "deploys")
            for s in split_list(c.get("serverclasses"))
        )
        n += 1
    return n


def _failures(apps: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Why each app failed to install on a client, the classes sending it and their state."""
    out = {}
    for name, v in apps.items():
        v = v or {}
        if not v.get("result") or v.get("result") == "Ok":
            continue
        reason = str(v.get("failedReason") or "").strip().strip("'\"") or None
        classes = v.get("serverclasses")
        out[name] = {
            "reason": reason[:300] if reason else None,
            "serverClasses": sorted(classes) if isinstance(classes, list) else split_list(classes),
            "stateOnClient": v.get("stateOnClient") or None,
        }
    return out


def extract_clients(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e in iter_entries(ctx.transport, "/services/deployment/server/clients"):
        c = content(e)
        hostname = c.get("hostname") or c.get("instanceName") or e["name"]
        apps = c.get("applications") or {}
        classes = c.get("serverClasses") or {}
        ent = add_global(
            ctx,
            out,
            "deploymentClient",
            hostname,
            product=PRODUCT,
            properties={
                "hostname": hostname,
                "guid": c.get("guid") or e["name"],
                "dns": c.get("dns") or None,
                "ip": c.get("ip") or None,
                "machineType": c.get("utsname") or None,
                "package": c.get("package") or None,
                "splunkVersion": c.get("splunkVersion") or None,
                "serverClasses": sorted(classes),
            },
            observed={
                "lastPhoneHome": epoch_to_iso(c.get("lastPhoneHomeTime")),
                "phoneHomeIntervalSecs": to_int(c.get("averagePhoneHomeInterval")),
                "apps": {a: (v or {}).get("result") for a, v in apps.items()},
                "appFailures": _failures(apps) or None,
            },
        )
        out.edges.extend(
            edge(fqn(ctx.instance, "deploymentApp", a), ent["id"], "deploys") for a in apps
        )
        out.edges.extend(
            edge(ent["id"], fqn(ctx.instance, "serverClass", s), "memberOf") for s in classes
        )
        n += 1
    return n


def _input_kind(stanza: str) -> str | None:
    kind, sep, _ = stanza.partition("://")
    return kind if sep and kind in INPUT_KINDS else None


def extract_app_inputs(ctx: Ctx, out: ExtractResult, apps_dir: Path) -> int:
    """Inputs (and output targets) inside each deployment app on disk."""
    n = 0
    for app_dir in sorted(
        p for p in apps_dir.iterdir() if p.is_dir() and not p.name.startswith("_")
    ):
        app_id = fqn(ctx.instance, "deploymentApp", app_dir.name)
        conf = read_app_conf(app_dir, "app")
        add_global(
            ctx,
            out,
            "deploymentApp",
            app_dir.name,
            product=PRODUCT,
            displayName=(conf.get("ui") or {}).get("label") or None,
            properties={
                "onDisk": True,
                # What forwarders get: the app's own version (launcher, else id stanza).
                "version": (conf.get("launcher") or {}).get("version")
                or (conf.get("id") or {}).get("version")
                or None,
                "label": (conf.get("ui") or {}).get("label") or None,
            },
        )
        inputs = read_app_conf(app_dir, "inputs")
        defaults = inputs.get("default", {})
        for stanza, keys in inputs.items():
            kind = _input_kind(stanza)
            if not kind:
                continue
            merged = {**defaults, **keys}
            index = merged.get("index") or "main"
            ent = add_global(
                ctx,
                out,
                "input",
                f"{app_dir.name}:{stanza}",
                product=PRODUCT,
                displayName=stanza,
                disabled=as_bool(merged.get("disabled", False)),
                properties={
                    "kind": kind,
                    "deploymentApp": app_dir.name,
                    "stanza": stanza,
                    "index": index,
                    "sourcetype": merged.get("sourcetype") or None,
                    "host": merged.get("host") or None,
                    "source": merged.get("source") or None,
                    "interval": merged.get("interval") or None,
                },
            )
            out.edges.append(edge(app_id, ent["id"], "deploys"))
            if not ent.get("disabled"):
                out.refs.append(ref(ent["id"], "index", index, "feeds"))
                if merged.get("sourcetype"):
                    out.refs.append(ref(ent["id"], "sourcetype", merged["sourcetype"], "feeds"))
            n += 1
        outputs = read_app_conf(app_dir, "outputs")
        servers = sorted(
            {
                s
                for k, v in outputs.items()
                if k.startswith("tcpout:")
                for s in split_list(v.get("server"))
            }
        )
        if servers:
            add_global(
                ctx,
                out,
                "deploymentApp",
                app_dir.name,
                product=PRODUCT,
                properties={"forwardsTo": servers},
            )
    return n


def extract_client_config(ctx: Ctx, out: ExtractResult) -> int:
    """This server's own deployment client settings: set when it takes apps from an upstream
    deployment server (the second tier). Apps that came from upstream are marked
    ``origin: upstream``, the others ``origin: local``."""
    try:
        entries = list(iter_entries(ctx.transport, "/services/deployment/client"))
    except (EndpointNotFound, EndpointForbidden):
        return 0
    c = content(entries[0]) if entries else {}
    if as_bool(c.get("disabled", True)) or not c.get("targetUri"):
        return 0
    dc: dict[str, Any] = {}
    try:
        for e in iter_entries(ctx.transport, f"{NS_SYSTEM}/configs/conf-deploymentclient"):
            if e["name"] == "deployment-client":
                dc = content(e)
    except (EndpointNotFound, EndpointForbidden):
        pass
    repo = dc.get("repositoryLocation") or None
    relays = bool(repo) and "deployment-apps" in str(repo)
    pairs = c.get("serverClasses") or []
    received = sorted({p.split(":", 1)[1] for p in pairs if isinstance(p, str) and ":" in p})
    out.instance_facts.setdefault("properties", {})["deploymentClient"] = {
        "upstream": c["targetUri"],
        "clientName": c.get("clientName") or dc.get("clientName") or None,
        "repositoryLocation": repo,
        "relaysApps": relays,
        "serverRepositoryLocationPolicy": dc.get("serverRepositoryLocationPolicy") or None,
        "receivedApps": received,
    }
    if relays:
        for e in out.entities:
            if e["type"] == "deploymentApp" and e["instance"] == ctx.instance:
                e.setdefault("properties", {})["origin"] = (
                    "upstream" if e["name"] in received else "local"
                )
    return 1


def extract(transport, instance: str, apps_dir: Path | None = None) -> ExtractResult:
    out = ExtractResult()
    ctx = Ctx(transport, instance)
    extractors = {
        "serverClasses": extract_server_classes,
        "classApps": extract_class_apps,
        "applications": extract_applications,
        "clients": extract_clients,
    }
    if apps_dir is not None:
        extractors["appInputs"] = lambda c, o: extract_app_inputs(c, o, apps_dir)
    extractors["clientConfig"] = extract_client_config  # last: it marks the apps' origin
    run_extractors(ctx, extractors, "deploymentServer", out)
    _mark_use(ctx, out)
    return out


def _mark_use(ctx: Ctx, out: ExtractResult) -> None:
    """How many server classes deploy each app and how many clients have it, for the
    check on apps nothing deploys (only when classes or clients were read)."""
    read = {r["connector"] for r in out.reports if r.get("status") in ("ok", "partial")}
    if not {"deploymentServer.classApps", "deploymentServer.clients"} <= read:
        return
    kind = lambda i: i.split(":")[1]  # noqa: E731
    classes: dict[str, set[str]] = {}
    clients: dict[str, set[str]] = {}
    for x in out.edges:
        if (
            x["type"] != "deploys"
            or kind(x["from"]) == "deploymentApp"
            and kind(x["to"]) == "input"
        ):
            continue
        if kind(x["from"]) == "serverClass" and kind(x["to"]) == "deploymentApp":
            classes.setdefault(x["to"], set()).add(x["from"])
        elif kind(x["from"]) == "deploymentApp" and kind(x["to"]) == "deploymentClient":
            clients.setdefault(x["from"], set()).add(x["to"])
    for e in out.entities:
        if e["type"] == "deploymentApp" and e["instance"] == ctx.instance:
            p = e.setdefault("properties", {})
            p["serverClassCount"] = len(classes.get(e["id"], ()))
            p["clientCount"] = len(clients.get(e["id"], ()))
