"""Build from responses recorded against a real Splunk 9.4 seeded by deploy/seed_dev_splunk.py."""

import json
from pathlib import Path

import pytest

from delvecat_ingest.bundle import assemble, validate
from delvecat_ingest.connectors import splunk, splunk_cloud_acs
from delvecat_ingest.model import GLOBAL_TYPES, fqn
from delvecat_ingest.transport import FixtureTransport

HERE = Path(__file__).parent
RECORDED = HERE / "fixtures" / "splunk-9.4-dev"
ACS = HERE / "fixtures" / "acs-sample"
SEED_MANIFEST = HERE.parent.parent / "deploy" / "seed_manifest.json"
DEPLOYMENT_APPS = HERE.parent.parent / "deploy" / "deployment-apps"


def seed_ids(instance: str) -> list[str]:
    ids = []
    for o in json.loads(SEED_MANIFEST.read_text()):
        if o["type"] in GLOBAL_TYPES:
            ids.append(fqn(instance, o["type"], o["name"]))
        else:
            sharing = "user" if o.get("owner") else "app"
            ids.append(fqn(instance, o["type"], o["name"], o["app"], o.get("owner"), sharing))
    return ids


@pytest.fixture(scope="module")
def bundle():
    result = splunk.extract(FixtureTransport(RECORDED), "dev")
    inst = {"id": "dev", "name": "dev", "kind": "splunkEnterprise"}
    return assemble([inst], result)


@pytest.fixture(scope="module")
def by_id(bundle):
    return {e["id"]: e for e in bundle["entities"]}


def edges(bundle, *, frm=None, to=None, type_=None):
    return sorted(
        (e["from"], e["type"], e["to"])
        for e in bundle["edges"]
        if (frm is None or e["from"] == frm)
        and (to is None or e["to"] == to)
        and (type_ is None or e["type"] == type_)
    )


def test_bundle_is_valid_and_every_extractor_ran(bundle):
    assert validate(bundle) == []
    statuses = {r["connector"]: r["status"] for r in bundle["ingestionReport"]}
    assert all(s == "ok" for s in statuses.values()), statuses
    assert set(statuses) >= {f"splunk.{n}" for n in splunk.EXTRACTORS if n != "fields"}


def test_every_seeded_object_is_in_the_bundle():
    """Exit criterion: every object seeded into the test instance is catalogued,
    across the platform and the Deployment Server, DB Connect and Stream connectors."""
    from delvecat_ingest.connectors import (
        db_connect,
        deployment_server,
        enterprise_security,
        stream,
    )

    t = FixtureTransport(RECORDED)
    result = splunk.extract(t, "dev")
    result.extend(deployment_server.extract(t, "dev", DEPLOYMENT_APPS))
    result.extend(db_connect.extract(t, "dev"))
    result.extend(stream.extract(t, "dev"))
    result.extend(enterprise_security.extract(t, "dev"))
    ids = {
        e["id"]
        for e in assemble([{"id": "dev", "name": "dev", "kind": "splunkEnterprise"}], result)[
            "entities"
        ]
    }
    assert [i for i in seed_ids("dev") if i not in ids] == []


def test_no_secrets_or_emails(bundle):
    text = json.dumps(bundle)
    assert "@example.com" not in text
    assert '"token"' not in text
    assert "Dev-only-pass" not in text and "DelveCat-dev" not in text


def test_role_index_access_is_effective_and_expands_wildcards(bundle):
    # acme_soc: firewall;wineventlog directly, plus main;os inherited from the user role
    granted = {t for _, _, t in edges(bundle, frm="dev:role:acme_soc", type_="grantsAccess")}
    assert granted == {
        "dev:index:firewall",
        "dev:index:wineventlog",
        "dev:index:main",
        "dev:index:os",
    }
    analyst = {
        t for _, _, t in edges(bundle, frm="dev:role:acme_web_analyst", type_="grantsAccess")
    }
    assert {"dev:index:web", "dev:index:summary_web"} <= analyst  # web* and summary_*
    admin = {t for _, _, t in edges(bundle, frm="dev:role:admin", type_="grantsAccess")}
    assert "dev:index:_internal" in admin  # admin's "*" plus "_*"
    assert ("dev:role:acme_soc", "inherits", "dev:role:user") in edges(
        bundle, frm="dev:role:acme_soc"
    )
    assert ("dev:user:jlee", "memberOf", "dev:role:acme_soc") in edges(bundle, frm="dev:user:jlee")


def test_props_objects_hang_off_their_sourcetype(bundle, by_id):
    st = "dev:sourcetype:acme:fw"
    used = {t for _, _, t in edges(bundle, frm=st, type_="uses")}
    ta = "dev:{}:TA-acme-firewall/acme:fw : {}"
    assert used >= {
        ta.format("fieldExtraction", "EXTRACT-action"),
        ta.format("fieldAlias", "FIELDALIAS-src"),
        ta.format("calculatedField", "EVAL-vendor_product"),
        ta.format("automaticLookup", "LOOKUP-asset_owner"),
    }
    alias = by_id[ta.format("fieldAlias", "FIELDALIAS-src")]["properties"]["aliases"]
    assert alias  # e.g. {"src_ip": "src", ...}
    assert by_id[st]["properties"]["parsing"]["KV_MODE"] == "auto"
    by_index = by_id[st]["properties"]["observed"]["eventsByIndex"]
    assert list(by_index) == ["firewall"] and by_index["firewall"] > 0


def test_lookup_chains(bundle):
    auto = "dev:automaticLookup:TA-acme-firewall/acme:fw : LOOKUP-asset_owner"
    definition = "dev:lookup:TA-acme-firewall/asset_owners"
    assert edges(bundle, frm=auto, type_="uses") == [(auto, "uses", definition)]
    assert edges(bundle, frm=definition, type_="uses") == [
        (definition, "uses", "dev:lookup:TA-acme-firewall/asset_owners.csv")
    ]
    kv_def = "dev:lookup:acme_secops/threat_hosts_lookup"
    assert edges(bundle, frm=kv_def, type_="uses") == [
        (kv_def, "uses", "dev:kvCollection:acme_secops/threat_hosts")
    ]
    report = "dev:fieldExtraction:TA-acme-firewall/acme:fw : REPORT-fw_kv"
    assert edges(bundle, frm=report, type_="uses") == [
        (report, "uses", "dev:transform:TA-acme-firewall/acme_fw_kv")
    ]


def test_saved_searches_and_dashboards(bundle, by_id):
    summary = by_id["dev:savedSearch:acme_web/Web - Hourly Status Summary"]
    assert summary["properties"]["kind"] == "scheduledReport"
    assert ("writes", "dev:index:summary_web") in [
        (t, d) for _, t, d in edges(bundle, frm=summary["id"])
    ]
    alert = by_id["dev:savedSearch:acme_secops/Firewall - Denied Outbound to Rare Ports"]
    assert alert["properties"]["kind"] == "alert" and alert["properties"]["actions"] == ["email"]
    private = by_id["dev:savedSearch:acme_secops/@jlee/Windows - Failed Logons by User"]
    assert private["sharing"] == "user" and private["owner"] == "jlee"
    assert (
        by_id["dev:dashboard:acme_secops/soc_overview"]["properties"]["framework"]
        == "dashboardStudio"
    )
    assert (
        by_id["dev:dashboard:acme_web/storefront_health"]["properties"]["framework"] == "simpleXml"
    )


def test_data_model_kv_and_tags(bundle, by_id):
    dm = by_id["dev:dataModel:acme_web/Acme_Web"]["properties"]
    assert dm["datasets"][0]["name"] == "Requests"
    assert dm["datasets"][0]["constraint"] == "index=web sourcetype=access_combined"
    assert "status" in dm["datasets"][0]["fields"]
    kv = by_id["dev:kvCollection:acme_secops/threat_hosts"]["properties"]
    assert kv["fields"] == {"ip": "string", "score": "number"}
    assert edges(bundle, frm="dev:tag:authentication") == [
        ("dev:tag:authentication", "mapsTo", "dev:eventtype:acme_secops/acme_failed_login")
    ]
    assert ("dev:tag:firewall", "mapsTo", "dev:sourcetype:acme:fw") in edges(
        bundle, frm="dev:tag:firewall"
    )


def test_inputs_and_inventory(bundle, by_id):
    hec = "dev:input:splunk_httpinput/http://acme_storefront"
    assert edges(bundle, frm=hec, type_="feeds") == [
        (hec, "feeds", "dev:index:summary_web"),
        (hec, "feeds", "dev:index:web"),
        (hec, "feeds", "dev:sourcetype:access_combined"),
    ]
    assert ("dev:input:TA-acme-firewall/udp://5514", "feeds", "dev:index:firewall") in edges(
        bundle, frm="dev:input:TA-acme-firewall/udp://5514"
    )
    assert by_id["dev:index:infra_metrics"]["properties"]["datatype"] == "metric"
    assert by_id["dev:host:fw-edge-1"]["properties"]["observed"]["indexes"] == ["firewall"]
    assert ("dev:host:fw-edge-1", "feeds", "dev:index:firewall") in edges(
        bundle, frm="dev:host:fw-edge-1"
    )


def test_acs_enriches_cloud_instance():
    result = splunk.extract(FixtureTransport(RECORDED), "c")
    result.extend(splunk_cloud_acs.extract(FixtureTransport(ACS), "c"))
    inst = {"id": "c", "name": "c", "kind": "splunkEnterprise"}
    from delvecat_ingest.model import merge_facts

    merge_facts(inst, result.instance_facts)
    b = assemble([inst], result)
    assert validate(b) == []
    by = {e["id"]: e for e in b["entities"]}
    web = by["c:index:web"]["properties"]
    assert web["searchableDays"] == 90 and web["frozenTimePeriodInSecs"]  # ACS + REST merged
    assert "c:index:cloud_only_audit" in by
    mobile = by["c:input:splunk_httpinput/http://mobile_app"]
    assert mobile["disabled"] is True and mobile["properties"]["managedBy"] == "acs"
    assert "c:app:Splunk_TA_aws" in by
    assert inst["kind"] == "splunkCloud"
    assert inst["properties"]["ipAllowlistSubnetCounts"] == {"search-api": 2, "hec": 1}
    text = json.dumps(b)
    assert "00000000-1111" not in text and "55555555-6666" not in text
    acs_reports = {
        r["connector"]: r["status"]
        for r in b["ingestionReport"]
        if r["connector"].startswith("acs.")
    }
    assert acs_reports == {
        "acs.indexes": "ok",
        "acs.hecTokens": "ok",
        "acs.apps": "ok",
        "acs.ipAllowlists": "ok",
    }


def test_forbidden_and_missing_endpoints_are_skipped(tmp_path):
    (tmp_path / "services" / "authentication").mkdir(parents=True)
    (tmp_path / "services" / "authentication" / "users.json").write_text('{"__status__": 403}')
    result = splunk.extract(FixtureTransport(tmp_path), "x")
    reports = {r["connector"]: r for r in result.reports}
    assert reports["splunk.users"]["status"] == "skipped"
    assert "permission denied" in reports["splunk.users"]["message"]
    assert reports["splunk.apps"]["status"] == "skipped"
    assert reports["splunk.macros"]["status"] == "skipped"


def test_field_discovery_from_sampled_events():
    opts = splunk.Options(fields=True, max_field_sourcetypes=10)
    b = assemble(
        [{"id": "dev", "name": "dev", "kind": "splunkEnterprise"}],
        splunk.extract(FixtureTransport(RECORDED), "dev", opts),
    )
    fields = {e["id"]: e for e in b["entities"] if e["type"] == "field"}
    fw = {
        e["displayName"]: e for e in fields.values() if e["properties"]["sourcetype"] == "acme:fw"
    }
    # search-time knowledge applied: alias (src), calculated field, automatic lookup output
    assert {"action", "src", "vendor_product", "owner"} <= set(fw)
    assert "sourcetype" not in fw and "date_hour" not in fw
    assert fw["dest_port"]["properties"]["numeric"] is True
    assert 0 < fw["owner"]["properties"]["observed"]["coverage"] < 1
    assert ("dev:sourcetype:acme:fw", "contains", fw["action"]["id"]) in edges(
        b, frm="dev:sourcetype:acme:fw", type_="contains"
    )


def test_field_sampling_failures_are_partial_not_fatal():
    opts = splunk.Options(fields=True, max_field_sourcetypes=30)  # only 10 were recorded
    result = splunk.extract(FixtureTransport(RECORDED), "dev", opts, only=None)
    report = next(r for r in result.reports if r["connector"] == "splunk.fields")
    assert report["status"] == "partial"
    assert report["counts"]["entities"] > 0
    assert "could not be sampled" in report["message"]
