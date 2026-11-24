"""Data models: field types and flags, calculations, acceleration limits, and the datasets
searches name."""

from __future__ import annotations

import json
from pathlib import Path

from delvecat_ingest.inapp import build_here
from delvecat_ingest.spl import analyze
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
MODELS = "/servicesNS/-/-/datamodel/model"


def _field(name, owner, type_="string", **flags):
    return {"fieldName": name, "owner": owner, "type": type_, "displayName": name, "comment": "",
            "required": False, "multivalue": False, "hidden": False, **flags}  # fmt: skip


MODEL = {
    "displayName": "Assets",
    "objects": [
        {
            "objectName": "Hosts",
            "displayName": "Hosts",
            "parentName": "BaseEvent",
            "lineage": "Hosts",
            "comment": "Every host event",
            "constraints": [{"search": "index=assets"}],
            "fields": [
                _field("_time", "BaseEvent", "timestamp"),
                _field("ip", "Hosts", required=True),
                _field("mac", "Hosts", multivalue=True, displayName="MAC address"),
            ],
            "calculations": [
                {
                    "calculationType": "Lookup",
                    "owner": "Hosts",
                    "lookupName": "asset_owners",
                    "lookupInputs": [{"inputField": "ip", "lookupField": "ip"}],
                    "outputFields": [
                        {**_field("owner", "Hosts"), "lookupOutputFieldName": "owner"}
                    ],
                },
                {
                    "calculationType": "Eval",
                    "owner": "Hosts",
                    "expression": "lower(ip)",
                    "outputFields": [_field("ip_lc", "Hosts")],
                },
            ],
        },  # fmt: skip
        {
            "objectName": "Servers",
            "displayName": "Servers",
            "parentName": "Hosts",
            "lineage": "Hosts.Servers",
            "constraints": [{"search": "role=server"}],
            "fields": [
                _field("_time", "BaseEvent", "timestamp"),
                _field("ip", "Hosts", required=True),
                _field("rack", "Hosts.Servers", "number"),
            ],
            "calculations": [
                {
                    "calculationType": "Eval",
                    "owner": "Hosts",
                    "expression": "lower(ip)",
                    "outputFields": [_field("ip_lc", "Hosts")],
                },
            ],
        },  # fmt: skip
    ],
}
ACCEL = {"enabled": True, "earliest_time": "-7d", "cron_schedule": "*/5 * * * *",
         "max_time": 3600, "max_concurrent": 3, "backfill_time": "-1d", "manual_rebuilds": True,
         "schedule_priority": "default", "allow_skew": "0"}  # fmt: skip


class Models(FixtureTransport):
    def get(self, path, params=None):
        body = super().get(path, params)
        if path == MODELS:
            entry = json.loads(json.dumps(body["entry"][0]))
            entry["name"] = "Assets"
            entry["content"].update(
                {
                    "eai:data": json.dumps(MODEL),
                    "acceleration": json.dumps(ACCEL),
                    "displayName": "Assets",
                    "tags_whitelist": "network,asset",
                }  # fmt: skip
            )
            body = {**body, "entry": [*body["entry"], entry]}
        return body


def _build():
    bundle = build_here(Models(FIXTURE), "acme")
    return bundle, {e["name"]: e for e in bundle["entities"] if e["type"] == "dataModel"}


def test_fields_have_types_flags_and_calculations_listed_once():
    _, models = _build()
    p = models["Assets"]["properties"]
    hosts, servers = p["datasets"]
    # Calculated fields count as fields of the dataset; inherited ones are listed by name.
    assert hosts["fields"] == ["_time", "ip", "mac", "owner", "ip_lc"]
    assert (
        servers["fields"] == ["_time", "ip", "rack", "ip_lc"] and servers["path"] == "Hosts.Servers"
    )
    info = {f["name"]: f for f in hosts["fieldInfo"]}
    assert info["ip"] == {"name": "ip", "type": "string", "required": True}
    assert info["mac"]["multivalue"] and info["mac"]["displayName"] == "MAC address"
    assert info["owner"]["calculation"] == "lookup" and "_time" not in info  # BaseEvent's
    # A child describes only what it adds: rack, not the parent's ip or ip_lc.
    assert [f["name"] for f in servers["fieldInfo"]] == ["rack"]
    assert "calculations" not in servers
    lookup, ev = hosts["calculations"]
    assert lookup["type"] == "lookup" and lookup["lookup"] == "asset_owners"
    assert lookup["outputs"] == ["owner"] and lookup["lookupInputs"] == {"ip": "ip"}
    assert lookup["lookupOutputs"] == {"owner": "owner"}
    assert ev == {"type": "eval", "expression": "lower(ip)", "outputs": ["ip_lc"]}
    assert hosts["comment"] == "Every host event"


def test_lookup_calculations_link_the_model_to_the_lookup():
    bundle, models = _build()
    uses = {x["to"] for x in bundle["edges"] if x["from"] == models["Assets"]["id"]}
    assert "acme:lookup:TA-acme-firewall/asset_owners" in uses


def test_acceleration_limits_leave_out_splunk_defaults():
    _, models = _build()
    p = models["Assets"]["properties"]
    assert p["accelerated"] and p["accelerationEarliest"] == "-7d"
    assert p["acceleration"] == {"backfillTime": "-1d", "manualRebuilds": True}
    assert p["tagsAllowlist"] == ["network", "asset"]
    assert p["accelerationAllowed"] is True


def test_searches_name_datasets():
    def ds(q):
        return sorted(analyze(q, lambda m: None).datasets)

    assert ds("| tstats count from datamodel=Network_Traffic.All_Traffic by All_Traffic.src") == [
        "Network_Traffic.All_Traffic"
    ]
    assert ds(
        "| tstats count from datamodel=Authentication where nodename=Authentication.Failed by x"
    ) == ["Authentication.Authentication.Failed"]
    assert ds("| datamodel Web Web search | stats count") == ["Web.Web"]
    assert ds("| datamodel Web search") == []  # a search mode, not a dataset
    assert ds('| from datamodel:"Authentication.Failed_Authentication"') == [
        "Authentication.Failed_Authentication"
    ]
    assert ds("| pivot Network_Traffic All_Traffic count(All_Traffic) AS c") == [
        "Network_Traffic.All_Traffic"
    ]
    assert ds("| tstats count from datamodel=$dm$") == []


def test_built_catalog_records_datasets_on_searches():
    bundle, _ = _build()
    by = {e["name"]: e for e in bundle["entities"]}
    lineage = by["Web - Requests by Status (Pivot)"]["lineage"]
    assert lineage["dataModelDatasets"] == ["Acme_Web.Requests"]
