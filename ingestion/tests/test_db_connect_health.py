"""DB Connect: custom JDBC URLs, output column mappings, broken references, run status."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from delvecat_ingest.bundle import assemble
from delvecat_ingest.connectors import db_connect
from delvecat_ingest.connectors.db_connect import parse_jdbc_url
from delvecat_ingest.transport import EndpointNotFound

NOW = datetime(2026, 11, 25, 22, 0, tzinfo=timezone.utc)
NS = "/servicesNS/nobody/splunk_app_db_connect/configs/conf-"
SECRET = "Sup3r-Secret!"


class Mem:
    def __init__(self, routes, searches=None):
        self.routes, self.searches, self.ran = routes, searches or {}, []

    def get(self, path, params=None):
        if path not in self.routes:
            raise EndpointNotFound(path)
        return {"entry": [{"name": n, "content": c, "acl": {}} for n, c in self.routes[path]]}

    def search(self, name, spl, earliest="-24h", latest="now"):
        self.ran.append((name, spl, earliest))
        return self.searches.get(name, [])


ROUTES = {
    NS + "identities": [
        ("reader", {"username": "svc_reader", "password": SECRET}),
        ("old", {"username": "svc_old", "password": SECRET, "disabled": "1"}),
    ],
    NS + "db_connections": [
        (
            "crm",
            {
                "connection_type": "postgres",
                "host": "pg",
                "port": "5432",
                "database": "crm",
                "identity": "reader",
            },
        ),
        (
            "legacy",
            {
                "connection_type": "generic_mssql",
                "identity": "reader",
                "customizedJdbcUrl": "jdbc:sqlserver://mssql.acme:1433;databaseName=legacy;"
                f"user=sa;password={SECRET}",
            },
        ),
        ("reporting", {"connection_type": "postgres", "host": "rep", "identity": "retired"}),
        ("archive", {"connection_type": "postgres", "host": "arc", "identity": "old"}),
        ("off", {"connection_type": "mysql", "host": "m", "identity": "reader", "disabled": "1"}),
    ],
    NS + "db_inputs": [
        (
            "orders",
            {
                "connection": "crm",
                "mode": "rising",
                "query": "SELECT * FROM sales.orders",
                "index": "db",
            },
        ),
        (
            "kpis",
            {
                "connection": "reporting",
                "mode": "batch",
                "query": "SELECT * FROM kpi",
                "index": "db",
            },
        ),
        ("ghost", {"connection": "nowhere", "query": "SELECT 1 FROM t", "index": "db"}),
        ("stale", {"connection": "off", "query": "SELECT * FROM t2", "index": "db"}),
        ("idle", {"connection": "crm", "query": "SELECT * FROM sales.customers", "index": "db"}),
        (
            "parked",
            {"connection": "crm", "query": "SELECT * FROM x", "index": "db", "disabled": "1"},
        ),
    ],
    NS + "db_outputs": [
        (
            "fraud",
            {
                "connection": "crm",
                "table_name": "fraud_flags",
                "customized_mappings": "order_id:ORDER_ID:4, amount:AMOUNT:3",
                "search": "index=db | table order_id amount",
            },
        ),
    ],
    NS + "db_lookups": [],
}
METRICS = [
    {
        "job": "orders",
        "runs": "288",
        "failed": "0",
        "rows_read": "5120",
        "rows_written": "5120",
        "errors": "0",
        "last_status": "COMPLETED",
        "last": "1795644000",
    },
    {
        "job": "kpis",
        "runs": "7",
        "failed": "7",
        "rows_read": "0",
        "errors": "7",
        "last_status": "FAILED",
        "last": "1795640000",
    },
    {
        "job": "fraud",
        "runs": "144",
        "failed": "3",
        "rows_written": "41",
        "errors": "3",
        "last_status": "COMPLETED",
        "last": "1795643000",
    },
]


def build(searches=None):
    t = Mem(ROUTES, {"dbx_job_metrics": METRICS} if searches is None else searches)
    r = db_connect.extract(t, "hf")
    b = assemble([{"id": "hf", "name": "hf", "kind": "splunkEnterprise"}], r, NOW)
    return {e["name"]: e for e in b["entities"] if e["type"].startswith("db")}, b, t


def checks(e):
    return {
        c["check"]: (c["status"], c["message"]) for c in (e.get("health") or {}).get("checks", [])
    }


@pytest.mark.parametrize(
    "url, expected",
    [
        (
            "jdbc:sqlserver://mssql:1433;databaseName=legacy;password=x",
            {"host": "mssql", "port": "1433", "database": "legacy"},
        ),
        (
            "jdbc:mysql://u:pw@db1:3306/shop?password=x",
            {"host": "db1", "port": "3306", "database": "shop"},
        ),
        ("jdbc:oracle:thin:@ora:1521:ORCL", {"host": "ora", "port": "1521", "database": "ORCL"}),
        (
            "jdbc:oracle:thin:@//ora:1521/sales",
            {"host": "ora", "port": "1521", "database": "sales"},
        ),
        (
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=o2)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=fin)))",
            {"host": "o2", "port": "1522", "database": "fin"},
        ),
        (
            "jdbc:snowflake://acct.snowflakecomputing.com/?db=AN&warehouse=W",
            {"host": "acct.snowflakecomputing.com", "database": "AN"},
        ),
        (
            "jdbc:sqlserver://[::1]:1433;database=x",
            {"host": "[::1]", "port": "1433", "database": "x"},
        ),
        ("not a url", {}),
    ],
)
def test_parse_jdbc_url(url, expected):
    assert parse_jdbc_url(url) == expected


def test_custom_jdbc_url_gives_server_and_database_but_is_never_stored():
    dbs, b, _ = build()
    p = dbs["legacy"]["properties"]
    assert (p["host"], p["port"], p["database"], p["customJdbcUrl"]) == (
        "mssql.acme",
        "1433",
        "legacy",
        True,
    )
    text = str(b)
    assert SECRET not in text and "jdbc:" not in text and "svc_reader" not in text


def test_output_keeps_field_to_column_mappings():
    dbs, _, _ = build()
    assert dbs["fraud"]["properties"]["columnMappings"] == [
        {"field": "order_id", "column": "ORDER_ID"},
        {"field": "amount", "column": "AMOUNT"},
    ]


def test_missing_or_disabled_identity_and_connection_are_critical():
    dbs, _, _ = build()
    assert checks(dbs["reporting"])["dbMissing"] == (
        "critical",
        "Its identity retired does not exist, so DB Connect cannot connect",
    )
    assert checks(dbs["archive"])["dbMissing"][1] == "Its identity old is disabled"
    assert (
        checks(dbs["ghost"])["dbMissing"][1]
        == "Its connection nowhere does not exist, so it cannot run"
    )
    assert (
        checks(dbs["stale"])["dbMissing"][1] == "Its connection off is disabled, so it cannot run"
    )
    assert "dbMissing" not in checks(dbs["orders"])
    assert not checks(dbs["crm"])


def test_run_status_from_job_metrics():
    dbs, _, t = build()
    assert t.ran[0][0] == "dbx_job_metrics" and t.ran[0][2] == "-7d"
    u = dbs["orders"]["usage"]
    assert (u["dbRuns"], u["dbFailedRuns"], u["dbRowsRead"], u["dbLastStatus"]) == (
        288,
        0,
        5120,
        "COMPLETED",
    )
    assert u["lastUsed"] == "2026-11-25T22:00:00Z"
    assert "dbFailed" not in checks(dbs["orders"])
    assert checks(dbs["kpis"])["dbFailed"] == (
        "critical",
        "7 of 7 runs failed in the last 7d (last run: failed)",
    )
    assert checks(dbs["fraud"])["dbFailed"][0] == "warning"
    # enabled with no run while the log has runs: not running; disabled: nothing
    assert checks(dbs["idle"])["dbNotRunning"] == ("warning", "No runs recorded in the last 7d")
    assert "health" not in dbs["parked"]


def test_no_job_metrics_means_no_run_checks():
    dbs, _, _ = build(searches={})
    assert "dbRuns" not in (dbs["idle"].get("usage") or {})
    assert "dbNotRunning" not in checks(dbs["idle"])
