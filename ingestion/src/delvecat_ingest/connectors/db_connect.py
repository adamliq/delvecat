"""Splunk DB Connect connector.

Reads DB Connect's configuration files through Splunk's generic
``configs/conf-<file>`` endpoint in the ``splunk_app_db_connect`` app:
``identities``, ``db_connections``, ``db_inputs``, ``db_outputs``, ``db_lookups``.
Identity user names and passwords are never collected.

Lineage: external table → DB input → index/sourcetype; search → DB output →
external table; DB lookup ← external table. ``dbxquery`` in SPL is handled by the
SPL analyzer.
"""

from __future__ import annotations

from typing import Any

from ..model import ExtractResult, edge, fqn
from ..splunk_rest import as_bool, iter_entries
from ..sql import tables
from .splunk import run_extractors
from .splunk.common import Ctx, add_global, content, ref, split_list

APP = "splunk_app_db_connect"
PRODUCT = "dbConnect"


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
                "host": c.get("host") or None,
                "port": c.get("port") or None,
                "database": c.get("database") or None,
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


EXTRACTORS = {
    "identities": extract_identities,
    "connections": extract_connections,
    "inputs": extract_inputs,
    "outputs": extract_outputs,
    "lookups": extract_lookups,
}


def extract(transport, instance: str) -> ExtractResult:
    out = ExtractResult()
    run_extractors(Ctx(transport, instance), EXTRACTORS, "dbConnect", out)
    return out
