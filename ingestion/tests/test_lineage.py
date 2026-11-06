"""SPL lineage over the recorded Splunk 9.4 fixture (cases seeded by deploy/seed_dev_splunk.py)."""

from pathlib import Path

import pytest

from delvecat_ingest.bundle import apply_versions, assemble, validate
from delvecat_ingest.connectors import splunk
from delvecat_ingest.lineage import MacroLibrary, derive
from delvecat_ingest.model import entity
from delvecat_ingest.transport import FixtureTransport

RECORDED = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
SS = "dev:savedSearch:"


@pytest.fixture(scope="module")
def bundle():
    result = splunk.extract(FixtureTransport(RECORDED), "dev")
    return assemble([{"id": "dev", "name": "dev", "kind": "splunkEnterprise"}], result)


@pytest.fixture(scope="module")
def by_id(bundle):
    return {e["id"]: e for e in bundle["entities"]}


def spl_edges(bundle, frm):
    return sorted(
        (e["type"], e["to"])
        for e in bundle["edges"]
        if e["from"] == frm and e.get("origin") == "spl"
    )


def test_bundle_valid(bundle):
    assert validate(bundle) == []
    report = next(r for r in bundle["ingestionReport"] if r["connector"] == "lineage")
    assert report["counts"]["brokenReferences"] >= 4


def test_search_through_macro_and_summary_index(bundle):
    assert spl_edges(bundle, SS + "acme_web/Web - Hourly Status Summary") == [
        ("reads", "dev:index:web"),
        ("reads", "dev:sourcetype:access_combined"),
        ("uses", "dev:macro:acme_web/web_status_buckets"),
    ]
    assert spl_edges(bundle, SS + "acme_web/Web - Top Error Pages") == [
        ("reads", "dev:index:summary_web")
    ]


def test_macro_with_arguments_resolves_to_its_arity(bundle):
    assert ("uses", "dev:macro:acme_secops/rare_port_threshold(1)") in spl_edges(
        bundle, SS + "acme_secops/Firewall - Denied Outbound to Rare Ports"
    )


def test_globally_shared_lookup_from_another_app(bundle):
    edges = spl_edges(bundle, SS + "acme_web/Web - Error Owners")
    assert ("uses", "dev:lookup:TA-acme-firewall/asset_owners") in edges
    # the CSV it writes does not exist until the search runs: not reported as broken
    assert (
        "lineage"
        not in {e["id"]: e for e in bundle["entities"]}[SS + "acme_web/Web - Error Owners"]
    )


def test_tags_eventtypes_and_data_models(bundle):
    assert spl_edges(bundle, SS + "acme_secops/Auth - Failures by Tag") == [
        ("uses", "dev:tag:authentication"),
        ("uses", "dev:tag:failure"),
    ]
    assert spl_edges(bundle, SS + "acme_secops/@jlee/Windows - Failed Logons by User") == [
        ("uses", "dev:eventtype:acme_secops/acme_failed_login")
    ]
    assert spl_edges(bundle, "dev:eventtype:acme_secops/acme_failed_login") == [
        ("reads", "dev:index:wineventlog")
    ]
    assert spl_edges(bundle, SS + "acme_web/Web - Requests by Status (Data Model)") == [
        ("reads", "dev:dataModel:acme_web/Acme_Web")
    ]
    assert spl_edges(bundle, "dev:dataModel:acme_web/Acme_Web") == [
        ("reads", "dev:index:web"),
        ("reads", "dev:sourcetype:access_combined"),
    ]


def test_subsearch_and_kv_lookup_read_and_write(bundle):
    assert spl_edges(bundle, SS + "acme_secops/SOC - Blocked Threat Hosts") == [
        ("reads", "dev:index:firewall"),
        ("reads", "dev:lookup:acme_secops/threat_hosts_lookup"),
        ("writes", "dev:lookup:acme_secops/threat_hosts_lookup"),
    ]


def test_dashboards(bundle, by_id):
    assert spl_edges(bundle, "dev:dashboard:acme_web/storefront_health") == [
        ("reads", SS + "acme_web/Web - Top Error Pages")
    ]
    assert spl_edges(bundle, "dev:dashboard:acme_secops/soc_overview") == [
        ("reads", "dev:index:firewall")
    ]
    explorer = by_id["dev:dashboard:acme_web/web_explorer"]
    assert spl_edges(bundle, explorer["id"]) == [
        ("reads", "dev:index:web"),
        ("reads", SS + "acme_web/Web - Error Owners"),
        ("reads", "dev:sourcetype:access_combined"),
    ]
    assert explorer["lineage"] == {"dynamic": True}
    kinds = sorted(s["kind"] for s in explorer["properties"]["searches"])
    assert kinds == ["inline", "inline", "inline", "postProcess", "savedSearch"]


def test_broken_references_are_diagnosed(by_id):
    legacy = by_id[SS + "search/Legacy - Proxy Categories"]["lineage"]
    assert sorted(legacy["unresolved"]) == [
        "index:legacy_proxy",
        "lookup:proxy_categories",
        "macro:proxy_filter",
    ]
    soc = by_id[SS + "acme_web/Web - Uses SOC Macro"]["lineage"]
    assert soc["unresolved"] == ["macro:secops_only_filter"]
    assert soc["warnings"] == [
        "macro secops_only_filter exists in acme_secops but is not shared with acme_web"
    ]
    anywhere = by_id[SS + "acme_web/Errors Anywhere"]["lineage"]
    assert anywhere["implicitIndex"] is True


def test_lineage_never_changes_versions(bundle):
    import copy

    prev = copy.deepcopy(bundle)
    apply_versions(prev["entities"], prev["generatedAt"], None)
    current = copy.deepcopy(bundle)
    for e in current["entities"]:
        e.pop("lineage", None)
    changes = apply_versions(current["entities"], "2030-01-01T00:00:00Z", prev)
    assert changes["modified"] == []


def test_macro_visibility_rules():
    def macro(app, name, sharing, owner="nobody"):
        return entity(
            id=f"i:macro:{app}/{name}",
            type="macro",
            name=name,
            instance="i",
            app=app,
            sharing=sharing,
            owner=owner,
            properties={"definition": f"index={app}"},
        )

    lib = MacroLibrary(
        [macro("a", "m", "app"), macro("b", "m", "global"), macro("c", "p", "user", owner="jo")]
    )
    assert lib.visible("m", "a")["app"] == "a"  # same app wins
    assert lib.visible("m", "z")["app"] == "b"  # then globally shared
    assert lib.visible("p", "c", owner="jo") is not None
    assert lib.visible("p", "c", owner="someone") is None  # private to jo
    assert lib.visible("p", "z", owner="jo") is None


def test_unparseable_dashboard_xml_keeps_its_warning():
    d = entity(
        id="i:dashboard:a/x",
        type="dashboard",
        name="x",
        instance="i",
        app="a",
        properties={"searches": []},
    )
    d["lineage"] = {"warnings": ["could not parse dashboard XML: ParseError"]}
    derive([d])
    assert d["lineage"]["warnings"] == ["could not parse dashboard XML: ParseError"]
