"""Forwarding outputs (outputs.conf) and acceleration summaries.

Outputs: where this instance sends data. ``tcpout:<group>`` (indexers, or indexer
discovery), ``syslog:<group>``, ``httpout`` (HTTP Event Collector), and ``rfs:<name>``
(Ingest Actions destinations such as S3). SSL passwords, pass4SymmKey and tokens are
never read.

Acceleration summaries: data model and report acceleration (``admin/summarization``),
with size, completeness, time range and last use, linked to what they accelerate.
"""

from __future__ import annotations

import re
from typing import Any

from ...model import ExtractResult
from ...splunk_rest import as_bool, iter_entries
from ...transport import EndpointForbidden, EndpointNotFound
from .common import NS, Ctx, add_global, content, epoch_to_iso, ref, split_list, to_int
from .data import object_store

_SECRET = re.compile(r"(password|pass4symmkey|token|secret|key$|privatekey)", re.I)


def output_name(kind: str, group: str | None = None) -> str:
    """The catalog name of an output group: "tcpout:indexers", "syslog:siem", "httpout"."""
    return f"{kind}:{group}" if group else kind


def extract_outputs(ctx: Ctx, out: ExtractResult) -> int:
    stanzas = list(iter_entries(ctx.transport, f"{NS}/configs/conf-outputs"))
    discovery = {
        e["name"].split(":", 1)[1]: content(e)
        for e in stanzas
        if e["name"].startswith("indexer_discovery:")
    }
    defaults: dict[str, list[str]] = {}
    for e in stanzas:
        if e["name"] in ("tcpout", "syslog"):
            defaults[e["name"]] = split_list(content(e).get("defaultGroup"))
    forwarding = {
        "tcpoutDefaultGroups": defaults.get("tcpout") or None,
        "syslogDefaultGroups": defaults.get("syslog") or None,
        "indexAndForward": next(
            (
                as_bool(content(e).get("indexAndForward"))
                for e in stanzas
                if e["name"] == "tcpout" and content(e).get("indexAndForward") not in (None, "")
            ),
            None,
        ),
    }
    # Every Splunk has a bare [tcpout]; forwarding is configured only with a default group.
    if forwarding["tcpoutDefaultGroups"] or forwarding["syslogDefaultGroups"]:
        out.instance_facts.setdefault("properties", {})["forwarding"] = forwarding
    n = 0
    seen: set[str] = set()
    for e in stanzas:
        stanza = e["name"]
        kind, _, group = stanza.partition(":")
        if kind not in ("tcpout", "syslog", "httpout", "rfs") or (kind != "httpout" and not group):
            continue
        name = output_name(kind, group or None)
        if name in seen:
            continue
        seen.add(name)
        c = content(e)
        props: dict[str, Any] = {"kind": kind, "group": group or None}
        if kind == "tcpout":
            disc = c.get("indexerDiscovery") or None
            dc = discovery.get(disc or "", {})
            props.update(
                {
                    "servers": split_list(c.get("server")) or None,
                    "indexerDiscovery": disc,
                    "clusterManager": dc.get("manager_uri") or dc.get("master_uri") or None,
                    "useAck": as_bool(c.get("useACK", False)),
                    "compressed": as_bool(c.get("compressed", False)),
                    "ssl": bool(c.get("clientCert") or c.get("sslCertPath")) or None,
                    "default": group in (defaults.get("tcpout") or []),
                }
            )
        elif kind == "syslog":
            props.update(
                {
                    "servers": split_list(c.get("server")) or None,
                    "protocol": c.get("type") or None,
                    "default": group in (defaults.get("syslog") or []),
                }
            )
        elif kind == "httpout":
            props.update({"uri": c.get("uri") or None, "batchSize": to_int(c.get("batchSize"))})
        else:  # rfs: Ingest Actions destination (S3 and the like)
            path = c.get("path") or None
            props.update({"path": path, **object_store(path)})
        props = {k: v for k, v in props.items() if not _SECRET.search(k)}
        add_global(
            ctx,
            out,
            "outputGroup",
            name,
            app=(e.get("acl") or {}).get("app"),
            displayName=group or kind,
            disabled=as_bool(c.get("disabled", False)),
            properties=props,
        )
        n += 1
    return n


# --- acceleration summaries --------------------------------------------------------------


def _mb(value: Any) -> float | None:
    try:
        return round(float(value) / 1048576, 2)
    except (TypeError, ValueError):
        return None


def _summary_props(c: dict[str, Any], kind: str) -> dict[str, Any]:
    complete = c.get("summary.complete")
    try:
        pct = float(complete)
        pct = round(pct * 100 if pct <= 1 else pct, 1)
    except (TypeError, ValueError):
        pct = None
    return {
        "kind": kind,
        "summaryId": c.get("summary.id") or None,
        "sizeMB": _mb(c.get("summary.size")),
        "completePercent": pct,
        "earliest": epoch_to_iso(c.get("summary.earliest_time")),
        "latest": epoch_to_iso(c.get("summary.latest_time")),
        "timeRangeSecs": to_int(c.get("summary.time_range")),
        "lastAccess": epoch_to_iso(c.get("summary.access_time")),
        "accessCount": to_int(c.get("summary.access_count")),
        "buckets": to_int(c.get("summary.buckets")),
        "lastBuilt": epoch_to_iso(c.get("summary.mod_time")),
        "lastRunSecs": c.get("summary.latest_run_duration") or None,
        "inProgress": as_bool(c.get("summary.is_inprogress", False)),
        "suspended": as_bool(c.get("summary.is_suspended", False)),
        "lastError": c.get("summary.last_error") or None,
    }


def _data_model_of(summary_id: str, apps: list[str]) -> tuple[str | None, str]:
    """DM_<app>_<model> -> (app, model); app names may contain underscores."""
    rest = summary_id.removeprefix("DM_")
    for app in sorted(apps, key=len, reverse=True):
        if rest.startswith(app + "_"):
            return app, rest[len(app) + 1 :]
    app, _, model = rest.partition("_")
    return (app or None), model


def extract_acceleration_summaries(ctx: Ctx, out: ExtractResult) -> int:
    apps = [e["name"] for e in out.entities if e["type"] == "app"]
    n = 0
    for e in iter_entries(ctx.transport, "/services/admin/summarization", {"by_tstats": "true"}):
        if not e["name"].startswith("tstats:"):
            continue
        c = content(e)
        sid = str(c.get("summary.id") or e["name"].removeprefix("tstats:"))
        app, model = _data_model_of(sid, apps)
        ent = add_global(
            ctx,
            out,
            "accelerationSummary",
            sid,
            displayName=f"Data model acceleration: {model}",
            properties={**_summary_props(c, "dataModel"), "dataModel": model},
        )
        out.refs.append(ref(ent["id"], "dataModel", model, "accelerates", app=app))
        n += 1
    try:
        reports = list(
            iter_entries(ctx.transport, "/services/admin/summarization", {"by_tstats": "false"})
        )
    except (EndpointNotFound, EndpointForbidden):
        reports = []
    for e in reports:
        if e["name"].startswith("tstats:"):
            continue  # a data model summary, read above
        c = content(e)
        sid = str(c.get("summary.id") or e["name"])
        searches = list((c.get("saved_searches") or {}).values())
        names = [s.get("name") for s in searches if isinstance(s, dict) and s.get("name")]
        ent = add_global(
            ctx,
            out,
            "accelerationSummary",
            sid,
            displayName="Report acceleration: " + (", ".join(names) or sid),
            properties={**_summary_props(c, "report"), "reports": names or None},
        )
        for s in searches:
            if isinstance(s, dict) and s.get("name"):
                out.refs.append(
                    ref(ent["id"], "savedSearch", s["name"], "accelerates", app=s.get("app"))
                )
        n += 1
    return n
