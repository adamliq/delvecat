"""Deployment Server, DB Connect and Stream over the recorded fixture, plus their helpers."""

import json
from collections import defaultdict
from pathlib import Path

import pytest

from delvecat_ingest.bundle import assemble, validate
from delvecat_ingest.confparse import parse_conf, read_app_conf
from delvecat_ingest.connectors import db_connect, deployment_server, splunk, stream
from delvecat_ingest.link import link_hosts
from delvecat_ingest.spl import analyze
from delvecat_ingest.sql import tables
from delvecat_ingest.transport import FixtureTransport

HERE = Path(__file__).parent
RECORDED = HERE / "fixtures" / "splunk-9.4-dev"
APPS = HERE.parents[1] / "deploy" / "deployment-apps"


@pytest.fixture(scope="module")
def bundle():
    t = FixtureTransport(RECORDED)
    r = splunk.extract(t, "dev")
    r.extend(deployment_server.extract(t, "dev", APPS))
    r.extend(db_connect.extract(t, "dev"))
    r.extend(stream.extract(t, "dev"))
    return assemble([{"id": "dev", "name": "dev", "kind": "splunkEnterprise"}], r)


@pytest.fixture(scope="module")
def by_id(bundle):
    return {e["id"]: e for e in bundle["entities"]}


def out_edges(bundle, frm, type_=None):
    return sorted(
        (e["type"], e["to"])
        for e in bundle["edges"]
        if e["from"] == frm and (type_ is None or e["type"] == type_)
    )


FLOW_FWD = {"feeds", "writes", "triggers", "accelerates", "deploys"}
FLOW_REV = {"reads", "uses", "mapsTo"}


def upstream(bundle, node, depth=8):
    """Mirror of the web app's lineage rules."""
    up = defaultdict(set)
    for e in bundle["edges"]:
        if e["type"] in FLOW_FWD:
            up[e["to"]].add(e["from"])
        elif e["type"] in FLOW_REV:
            up[e["from"]].add(e["to"])
    seen, frontier = {node}, [node]
    for _ in range(depth):
        frontier = [u for n in frontier for u in up[n] if u not in seen and not seen.add(u)]
    seen.discard(node)
    return seen


def test_valid_and_all_product_extractors_ran(bundle):
    assert validate(bundle) == []
    reports = {r["connector"]: r["status"] for r in bundle["ingestionReport"]}
    for name in (
        "deploymentServer.serverClasses",
        "deploymentServer.clients",
        "deploymentServer.appInputs",
        "dbConnect.connections",
        "dbConnect.inputs",
        "stream.streams",
        "stream.forwarders",
    ):
        assert reports[name] == "ok", name


# --- Deployment Server -------------------------------------------------------------


def test_server_classes_apps_and_clients(bundle, by_id):
    assert by_id["dev:serverClass:linux_hosts"]["properties"]["whitelist"] == ["uf-linux-*"]
    assert out_edges(bundle, "dev:serverClass:linux_hosts", "deploys") == [
        ("deploys", "dev:deploymentApp:acme_linux_inputs")
    ]
    client = by_id["dev:deploymentClient:uf-linux-01"]
    assert client["product"] == "deploymentServer"
    assert client["properties"]["serverClasses"] == ["all_forwarders", "linux_hosts"]
    assert client["properties"]["observed"]["apps"] == {
        "acme_all_outputs": "Ok",
        "acme_linux_inputs": "Ok",
    }
    # the web_servers class matches no client, so its app is deployed nowhere
    assert not any(
        e["from"] == "dev:deploymentApp:acme_web_inputs"
        and e["to"].startswith("dev:deploymentClient")
        for e in bundle["edges"]
    )


def test_app_inputs_merge_default_and_local(bundle, by_id):
    splunkd = by_id[
        "dev:input:acme_linux_inputs:monitor:///opt/splunkforwarder/var/log/splunk/splunkd.log"
    ]
    metrics = by_id[
        "dev:input:acme_linux_inputs:monitor:///opt/splunkforwarder/var/log/splunk/metrics.log"
    ]
    assert splunkd.get("disabled") is False and metrics["disabled"] is True
    assert ("feeds", "dev:index:os") in out_edges(bundle, splunkd["id"])
    assert out_edges(bundle, metrics["id"], "feeds") == []  # disabled: feeds nothing
    assert by_id["dev:deploymentApp:acme_all_outputs"]["properties"]["forwardsTo"] == [
        "splunk:9997"
    ]


def test_which_forwarders_feed_an_index(bundle):
    up = upstream(bundle, "dev:index:os")
    assert {
        "dev:deploymentClient:uf-linux-01",
        "dev:forwarder:uf-linux-01",
        "dev:host:uf-linux-01",
        "dev:deploymentApp:acme_linux_inputs",
        "dev:serverClass:linux_hosts",
    } <= up


# --- DB Connect --------------------------------------------------------------------


def test_db_connect_objects_without_credentials(bundle, by_id):
    conn = by_id["dev:dbConnection:orders_mysql"]
    assert conn["properties"]["databaseType"] == "mysql"
    assert conn["properties"]["database"] == "shop"
    assert by_id["dev:dbConnection:legacy_oracle"]["disabled"] is True
    assert out_edges(bundle, conn["id"], "uses") == [("uses", "dev:dbIdentity:orders_reader")]
    text = json.dumps(bundle)
    assert "dev-only-secret" not in text and "splunk_ro" not in text


def test_which_databases_feed_an_index(bundle, by_id):
    rising = by_id["dev:dbInput:orders_rising"]
    assert rising["properties"]["mode"] == "rising"
    assert out_edges(bundle, rising["id"]) == [
        ("feeds", "dev:index:db_orders"),
        ("feeds", "dev:sourcetype:mysql:orders"),
        ("reads", "dev:externalTable:orders_mysql/shop.orders"),
        ("uses", "dev:dbConnection:orders_mysql"),
    ]
    assert out_edges(bundle, "dev:dbInput:customers_batch", "feeds") == []  # disabled
    up = upstream(bundle, "dev:index:db_orders")
    assert {"dev:externalTable:orders_mysql/shop.orders", "dev:dbConnection:orders_mysql"} <= up


def test_db_output_lineage_round_trip(bundle):
    out = "dev:dbOutput:fraud_flags_out"
    assert out_edges(bundle, out) == [
        ("reads", "dev:index:db_orders"),
        ("reads", "dev:sourcetype:mysql:orders"),
        ("uses", "dev:dbConnection:orders_mysql"),
        ("writes", "dev:externalTable:orders_mysql/shop.fraud_flags"),
    ]


def test_dbxquery_in_spl_reaches_tables(bundle, by_id):
    s = "dev:savedSearch:acme_web/Web - Orders vs Errors"
    assert out_edges(bundle, s) == [
        ("reads", "dev:externalTable:orders_mysql/shop.customers"),
        ("reads", "dev:externalTable:orders_mysql/shop.orders"),
        ("reads", "dev:index:web"),
        ("uses", "dev:dbConnection:orders_mysql"),
    ]
    assert set(by_id[s].get("lineage", {})) <= {"fields"}


# --- Stream ------------------------------------------------------------------------


def test_which_streams_feed_an_index(bundle, by_id):
    http = by_id["dev:streamDefinition:http"]
    assert http["properties"]["sourcetype"] == "stream:http"
    assert "uri_path" in http["properties"]["fields"]
    assert by_id["dev:streamDefinition:smtp"]["disabled"] is True
    assert out_edges(bundle, "dev:streamDefinition:smtp", "feeds") == []
    assert ("deploys", "dev:streamForwarder:streamfwd-dmz-01") in out_edges(
        bundle, "dev:streamGroup:dmz_sensors"
    )
    up = upstream(bundle, "dev:index:stream")
    assert {
        "dev:streamDefinition:http",
        "dev:streamDefinition:dns",
        "dev:streamForwarder:streamfwd-dmz-01",
        "dev:streamGroup:dmz_sensors",
    } <= up


def test_products_absent_are_skipped(tmp_path):
    t = FixtureTransport(tmp_path)
    for mod, prefix in ((db_connect, "dbConnect"), (stream, "stream")):
        r = mod.extract(t, "x")
        assert {x["status"] for x in r.reports if x["connector"].startswith(prefix)} == {"skipped"}


# --- helpers -----------------------------------------------------------------------


def test_conf_parser_layers_and_continuations(tmp_path):
    app = tmp_path / "app"
    (app / "default").mkdir(parents=True)
    (app / "local").mkdir()
    (app / "default" / "inputs.conf").write_text(
        "# comment\n[default]\nindex = main\n[monitor:///a]\nsourcetype = a\nwhitelist = x\\\n|y\n"
    )
    (app / "local" / "inputs.conf").write_text("[monitor:///a]\nindex = other\n")
    conf = read_app_conf(app, "inputs")
    assert conf["monitor:///a"] == {"sourcetype": "a", "whitelist": "x\n|y", "index": "other"}
    assert parse_conf("[a]\nk=v\n; c\n")["a"] == {"k": "v"}


@pytest.mark.parametrize(
    "sql,expected",
    [
        ("SELECT * FROM shop.orders WHERE x = 1", ["shop.orders"]),
        (
            "select a from orders o join customers c on o.c = c.id "
            "left join [dbo].[Tiers] t on 1=1",
            ["orders", "customers", "dbo.Tiers"],
        ),
        ('SELECT * FROM "Sales"."Order Lines"', ["Sales.Order Lines"]),
        ("WITH recent AS (SELECT * FROM orders) SELECT * FROM recent", ["orders"]),
        ("SELECT 'from fake' AS x FROM real_table -- from comment", ["real_table"]),
        ("INSERT INTO audit.log SELECT * FROM events", ["audit.log", "events"]),
        ("SELECT 1 FROM DUAL", []),
        (None, []),
    ],
)
def test_sql_tables(sql, expected):
    assert tables(sql) == expected


def test_dbx_commands_in_spl():
    refs = sorted(
        analyze(
            '| dbxquery connection=orders query="SELECT * FROM shop.orders" '
            "| dbxlookup lookup=customer_tier | dbxoutput output=flags_out"
        ).refs
    )
    assert refs == [
        ("reads", "externalTable", "orders/shop.orders", False),
        ("uses", "dbConnection", "orders", False),
        ("uses", "dbLookup", "customer_tier", False),
        ("writes", "dbOutput", "flags_out", False),
    ]


def test_host_linking_is_case_insensitive_and_handles_fqdns():
    ents = [
        {"id": "i:host:WEB01.corp.example", "type": "host", "name": "WEB01.corp.example"},
        {"id": "i:host:db01", "type": "host", "name": "db01"},
        {"id": "i:forwarder:web01", "type": "forwarder", "name": "web01"},
        {
            "id": "i:deploymentClient:x",
            "type": "deploymentClient",
            "name": "x",
            "properties": {"hostname": "DB01.corp.example"},
        },
        {"id": "i:streamForwarder:nomatch", "type": "streamForwarder", "name": "nomatch"},
    ]
    assert sorted((e["from"], e["to"]) for e in link_hosts(ents)) == [
        ("i:deploymentClient:x", "i:host:db01"),
        ("i:forwarder:web01", "i:host:WEB01.corp.example"),
    ]
