import json
from pathlib import Path

from delvecat_ingest.bundle import assemble, validate
from delvecat_ingest.cli import main
from delvecat_ingest.connectors import splunk_platform
from delvecat_ingest.transport import FixtureTransport

FIXTURES = Path(__file__).parent / "fixtures" / "acme"


def build():
    result = splunk_platform.extract(FixtureTransport(FIXTURES), "acme")
    return assemble([{"id": "acme", "name": "acme", "kind": "splunkEnterprise"}], result)


def test_fixture_bundle_is_valid():
    bundle = build()
    assert validate(bundle) == []
    assert all(r["status"] == "ok" for r in bundle["ingestionReport"])


def test_entity_counts_and_fqns():
    entities = {e["id"]: e for e in build()["entities"]}
    by_type = {}
    for e in entities.values():
        by_type[e["type"]] = by_type.get(e["type"], 0) + 1
    assert by_type == {"app": 4, "index": 7, "savedSearch": 5, "dashboard": 2, "macro": 2}

    alert = entities["acme:savedSearch:acme_secops/nobody/Firewall - Denied Outbound to Rare Ports"]
    assert alert["properties"]["kind"] == "alert"
    assert alert["properties"]["actions"] == ["email", "webhook"]
    private = entities["acme:savedSearch:acme_secops/jlee/Windows - Failed Logons by User"]
    assert private["sharing"] == "user"
    studio = entities["acme:dashboard:acme_secops/nobody/soc_overview"]
    assert studio["properties"]["framework"] == "dashboardStudio"
    assert entities["acme:index:legacy_proxy"]["disabled"] is True


def test_app_contains_edges_only_reference_known_entities():
    bundle = build()
    ids = {e["id"] for e in bundle["entities"]}
    assert bundle["edges"], "expected app→object edges"
    for edge in bundle["edges"]:
        assert edge["from"] in ids and edge["to"] in ids
        assert edge["type"] == "contains"


def test_missing_endpoint_is_reported_as_skipped(tmp_path):
    result = splunk_platform.extract(FixtureTransport(tmp_path), "empty")
    assert {r["status"] for r in result.reports} == {"skipped"}


def test_validate_catches_bad_entity():
    bundle = build()
    bundle["entities"].append(dict(bundle["entities"][0]))  # duplicate id
    bundle["entities"].append(
        {"id": "x", "type": "notAType", "name": "x", "product": "splunk", "instance": "acme"}
    )
    problems = validate(bundle)
    assert any("duplicate entity id" in p for p in problems)
    assert any("notAType" in p for p in problems)


def test_cli_build_and_validate(tmp_path, capsys):
    out = tmp_path / "catalog.json"
    rc = main(
        [
            "build",
            "--fixtures",
            str(FIXTURES),
            "--instance",
            "acme",
            "--generated-at",
            "2026-11-01T00:00:00+00:00",
            "--out",
            str(out),
        ]
    )
    assert rc == 0
    bundle = json.loads(out.read_text())
    assert bundle["generatedAt"] == "2026-11-01T00:00:00Z"
    assert main(["validate", str(out)]) == 0
