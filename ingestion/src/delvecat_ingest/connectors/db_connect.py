"""Splunk DB Connect connector.

Reads DB Connect's configuration files through Splunk's generic
``configs/conf-<file>`` endpoint in the ``splunk_app_db_connect`` app:
``identities``, ``db_connections``, ``db_inputs``, ``db_outputs``, ``db_lookups``.
Identity user names and passwords are never collected.

Lineage: external table → DB input → index/sourcetype; search → DB output →
external table; DB lookup ← external table. ``dbxquery`` in SPL is handled by the
SPL analyzer.

A connection given as a custom JDBC URL keeps only its server, port and database (the URL
itself can carry a user name and password, so it is never stored). An output keeps its
field → column mappings. Run status of inputs and outputs comes from DB Connect's job
metrics in ``_internal`` (``sourcetype=dbx_job_metrics``), when that log is searchable.
"""

from __future__ import annotations

import re
from typing import Any

from ..model import ExtractResult, edge, fqn
from ..splunk_rest import as_bool, iter_entries
from ..sql import tables
from .splunk import run_extractors
from .splunk.common import Ctx, add_global, content, epoch_to_iso, ref, split_list, to_int

APP = "splunk_app_db_connect"
PRODUCT = "dbConnect"


_HOST_PORT = re.compile(r"^(\[[^\]]+\]|[^/:;?@()=\s]+)(?::(\d+))?")


def parse_jdbc_url(url: str | None) -> dict[str, str]:
    """Server, port and database of a JDBC URL, for the common drivers. Never returns user
    names, passwords or other parameters."""
    if not url or not url.lower().startswith("jdbc:"):
        return {}
    rest = url[5:]
    out: dict[str, str] = {}
    params = dict(
        (k.strip().lower(), v.strip())
        for k, v in re.findall(r"[;?&]\s*([A-Za-z_.]+)\s*=\s*([^;&]*)", rest)
    )
    if rest.lower().startswith("oracle:"):
        desc = {
            k.lower(): v
            for k, v in re.findall(r"\((HOST|PORT|SERVICE_NAME|SID)\s*=\s*([^)]+)\)", rest, re.I)
        }
        if desc:
            out = {
                "host": desc.get("host", ""),
                "port": desc.get("port", ""),
                "database": desc.get("service_name") or desc.get("sid", ""),
            }
        else:
            m = re.search(r"@(?://)?([^:/]+)(?::(\d+))?(?:[:/]([^?;]+))?", rest)
            if m:
                out = {"host": m.group(1), "port": m.group(2) or "", "database": m.group(3) or ""}
    else:
        m = re.search(r"//([^/;?]*)", rest)
        if m:
            hostpart = m.group(1).rsplit("@", 1)[-1]  # drop user:password@
            h = _HOST_PORT.match(hostpart.split(",")[0])
            if h:
                out = {"host": h.group(1), "port": h.group(2) or ""}
            path = rest[m.end() :]
            db = re.match(r"/([^;?/]+)", path)
            if db:
                out["database"] = db.group(1)
    for key in ("databasename", "database", "db"):
        if not out.get("database") and params.get(key):
            out["database"] = params[key]
    return {k: v for k, v in out.items() if v}


def _mappings(value: str | None) -> list[dict[str, str]]:
    """``customized_mappings`` = ``field:column:sqltype,...`` (DB Connect outputs)."""
    out = []
    for item in split_list(value):
        parts = item.split(":")
        if len(parts) >= 2 and parts[0] and parts[1]:
            out.append({"field": parts[0].strip(), "column": parts[1].strip()})
    return out


def table_id(instance: str, connection: str, table: str) -> str:
    return fqn(instance, "externalTable", f"{connection}/{table}")


def _stanzas(ctx: Ctx, conf: str):
    for e in iter_entries(ctx.transport, f"/servicesNS/nobody/{APP}/configs/conf-{conf}"):
        if e["name"] != "default":
            yield e, content(e)


def _table(ctx: Ctx, out: ExtractResult, connection: str | None, table: str) -> str | None:
    if not connection:
        return None
    tid = table_id(ctx.instance, connection, table)
    add_global(
        ctx,
        out,
        "externalTable",
        f"{connection}/{table}",
        product=PRODUCT,
        displayName=table,
        properties={"connection": connection, "table": table},
    )
    out.edges.append(edge(fqn(ctx.instance, "dbConnection", connection), tid, "contains"))
    return tid


def extract_identities(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e, c in _stanzas(ctx, "identities"):
        add_global(
            ctx,
            out,
            "dbIdentity",
            e["name"],
            product=PRODUCT,
            app=APP,
            disabled=as_bool(c.get("disabled", False)),
            properties={"windowsAuth": as_bool(c.get("use_win_auth", False))},
        )
        n += 1
    return n


def extract_connections(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e, c in _stanzas(ctx, "db_connections"):
        jdbc = parse_jdbc_url(c.get("customizedJdbcUrl"))
        ent = add_global(
            ctx,
            out,
            "dbConnection",
            e["name"],
            product=PRODUCT,
            app=APP,
            disabled=as_bool(c.get("disabled", False)),
            properties={
                "databaseType": c.get("connection_type"),
                "host": c.get("host") or jdbc.get("host"),
                "port": c.get("port") or jdbc.get("port"),
                "database": c.get("database") or jdbc.get("database"),
                "identity": c.get("identity") or None,
                "readonly": as_bool(c.get("readonly", False)),
                "ssl": as_bool(c.get("jdbcUseSSL", False)),
                "customJdbcUrl": bool(c.get("customizedJdbcUrl")),
            },
        )
        if c.get("identity"):
            out.edges.append(
                edge(ent["id"], fqn(ctx.instance, "dbIdentity", c["identity"]), "uses")
            )
        n += 1
    return n


def _source_tables(c: dict[str, Any]) -> list[str]:
    return [c["table_name"]] if c.get("table_name") else tables(c.get("query"))


def extract_inputs(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e, c in _stanzas(ctx, "db_inputs"):
        conn = c.get("connection")
        mode = c.get("mode") or "batch"
        index = c.get("index") or "main"
        ent = add_global(
            ctx,
            out,
            "dbInput",
            e["name"],
            product=PRODUCT,
            app=APP,
            disabled=as_bool(c.get("disabled", False)),
            description=c.get("description") or None,
            properties={
                "connection": conn,
                "mode": mode,
                "query": c.get("query") or None,
                "table": c.get("table_name") or None,
                "risingColumn": c.get("tail_rising_column_name") or None,
                "timestampColumn": c.get("input_timestamp_column_name") or None,
                "index": index,
                "sourcetype": c.get("sourcetype") or None,
                "source": c.get("source") or None,
                "host": c.get("host") or None,
                "interval": c.get("interval") or None,
            },
        )
        if conn:
            out.edges.append(edge(ent["id"], fqn(ctx.instance, "dbConnection", conn), "uses"))
        for t in _source_tables(c):
            if tid := _table(ctx, out, conn, t):
                out.edges.append(edge(ent["id"], tid, "reads"))
        if not ent.get("disabled"):  # a disabled input does not feed anything
            out.refs.append(ref(ent["id"], "index", index, "feeds"))
            if c.get("sourcetype"):
                out.refs.append(ref(ent["id"], "sourcetype", c["sourcetype"], "feeds"))
        n += 1
    return n


def extract_outputs(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e, c in _stanzas(ctx, "db_outputs"):
        conn = c.get("connection")
        ent = add_global(
            ctx,
            out,
            "dbOutput",
            e["name"],
            product=PRODUCT,
            app=APP,
            disabled=as_bool(c.get("disabled", False)),
            description=c.get("description") or None,
            properties={
                "connection": conn,
                "table": c.get("table_name") or None,
                "columnMappings": _mappings(c.get("customized_mappings")) or None,
                "search": c.get("search") or None,
                "interval": c.get("interval") or None,
            },
        )
        if conn:
            out.edges.append(edge(ent["id"], fqn(ctx.instance, "dbConnection", conn), "uses"))
        if c.get("table_name") and (tid := _table(ctx, out, conn, c["table_name"])):
            out.edges.append(edge(ent["id"], tid, "writes"))
        n += 1
    return n


def extract_lookups(ctx: Ctx, out: ExtractResult) -> int:
    n = 0
    for e, c in _stanzas(ctx, "db_lookups"):
        conn = c.get("connection")
        sql = c.get("lookupSQL") or c.get("query")
        ent = add_global(
            ctx,
            out,
            "dbLookup",
            e["name"],
            product=PRODUCT,
            app=APP,
            disabled=as_bool(c.get("disabled", False)),
            properties={
                "connection": conn,
                "query": sql or None,
                "table": c.get("table_name") or None,
                "inputFields": split_list(c.get("input_fields")),
                "outputFields": split_list(c.get("output_fields")),
            },
        )
        if conn:
            out.edges.append(edge(ent["id"], fqn(ctx.instance, "dbConnection", conn), "uses"))
        for t in [c["table_name"]] if c.get("table_name") else tables(sql):
            if tid := _table(ctx, out, conn, t):
                out.edges.append(edge(ent["id"], tid, "reads"))
        n += 1
    return n


def extract_job_metrics(ctx: Ctx, out: ExtractResult) -> int:
    """Runs of each input and output in the health window, from DB Connect's job metrics:
    how many, how many failed, rows read or written, errors, and the last run. Enabled
    inputs and outputs with no run are recorded with zero runs, when the log has any run
    at all (otherwise it is simply not searchable here). Error messages are not read:
    they can carry user names and SQL."""
    rows = ctx.transport.search(
        "dbx_job_metrics",
        "index=_internal sourcetype=dbx_job_metrics "
        "| eval job=coalesce(input_name, output_name, name), "
        'failed=if(upper(status)="COMPLETED" OR upper(status)="SUCCESS", 0, 1) '
        "| stats count as runs sum(failed) as failed sum(read_count) as rows_read "
        "sum(write_count) as rows_written sum(error_count) as errors "
        "latest(status) as last_status max(_time) as last by job",
        earliest=ctx.options.health_window,
    )
    seen = set()
    for r in rows:
        if not r.get("job"):
            continue
        seen.add(r["job"])
        out.usage.append(
            {
                "types": ["dbInput", "dbOutput"],
                "name": r["job"],
                "usage": {
                    "dbRuns": to_int(r.get("runs")) or 0,
                    "dbFailedRuns": to_int(r.get("failed")) or 0,
                    "dbRowsRead": to_int(r.get("rows_read")),
                    "dbRowsWritten": to_int(r.get("rows_written")),
                    "dbErrors": to_int(r.get("errors")) or 0,
                    "dbLastStatus": r.get("last_status") or None,
                    "lastUsed": epoch_to_iso(r.get("last")),
                    "dbWindow": ctx.options.health_window,
                },
            }
        )
    if seen:
        for e in out.entities:
            if (
                e["type"] in ("dbInput", "dbOutput")
                and not e.get("disabled")
                and e["name"] not in seen
            ):
                out.usage.append(
                    {
                        "types": [e["type"]],
                        "name": e["name"],
                        "usage": {"dbRuns": 0, "dbWindow": ctx.options.health_window},
                    }
                )
    return len(seen)


EXTRACTORS = {
    "identities": extract_identities,
    "connections": extract_connections,
    "inputs": extract_inputs,
    "outputs": extract_outputs,
    "lookups": extract_lookups,
    "jobMetrics": extract_job_metrics,
}


def extract(transport, instance: str) -> ExtractResult:
    out = ExtractResult()
    run_extractors(Ctx(transport, instance), EXTRACTORS, "dbConnect", out)
    return out
