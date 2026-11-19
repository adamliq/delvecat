"""Index-time routing, filtering and masking (props/transforms), and federated search."""

from __future__ import annotations

import json
from pathlib import Path

from delvecat_ingest.connectors.splunk.knowledge import index_time_actions
from delvecat_ingest.inapp import build_here
from delvecat_ingest.redaction import load_profile, redact_bundle
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
FW = "acme:sourcetype:acme:fw"
T = "acme:transform:TA-acme-firewall/"


def _build(parts=None):
    bundle = build_here(FixtureTransport(FIXTURE), "acme", parts=parts)
    edges = {(x["from"], x["to"], x["type"]) for x in bundle["edges"]}
    return bundle, {e["id"]: e for e in bundle["entities"]}, edges


def test_transform_actions():
    assert index_time_actions({"DEST_KEY": "queue", "FORMAT": "nullQueue"}) == [{"action": "drop"}]
    assert index_time_actions({"DEST_KEY": "queue", "FORMAT": "indexQueue"}) == [{"action": "keep"}]
    assert index_time_actions({"DEST_KEY": "_MetaData:Index", "FORMAT": "risk"}) == [
        {"action": "routeToIndex", "targets": ["risk"]}
    ]
    assert index_time_actions(
        {"DEST_KEY": "MetaData:Sourcetype", "FORMAT": "sourcetype::fw:new"}
    ) == [{"action": "setSourcetype", "targets": ["fw:new"]}]
    # A target taken from the event is not a known name.
    assert index_time_actions({"DEST_KEY": "_MetaData:Index", "FORMAT": "$1"}) == [
        {"action": "routeToIndex"}
    ]
    assert index_time_actions({"DEST_KEY": "_raw", "FORMAT": "masked $1"}) == [
        {"action": "rewriteRaw"}
    ]
    # Search-time transforms do nothing at index time.
    assert index_time_actions({"REGEX": "(?<user>\\w+)", "FORMAT": "user::$1"}) == []
    actions = index_time_actions(
        {
            "INGEST_EVAL": 'index=if(match(_raw,"secret"),"main",index), '
            'queue=if(x,"nullQueue","indexQueue"), env="legacy"'
        }
    )
    assert actions[0] == {
        "action": "routeToIndex",
        "expression": 'if(match(_raw,"secret"),"main",index)',
        "targets": ["main"],
    }
    assert actions[1] == {"action": "drop", "conditional": True}
    assert actions[2]["action"] == "indexedField" and actions[2]["field"] == "env"


def test_sourcetype_routing_drops_forwarding_and_masking():
    _, by_id, edges = _build()
    summary = by_id[FW]["properties"]["indexTime"]
    by_rule = {(s["rule"], s.get("transform")): s for s in summary}
    assert by_rule[("TRANSFORMS-route", "fw_drop_heartbeat")]["actions"] == ["drop"]
    assert by_rule[("TRANSFORMS-route", "fw_threats_to_risk")]["targets"] == ["risk"]
    assert by_rule[("TRANSFORMS-fwd", "fw_copy_to_siem")]["targets"] == [
        "archive_group",
        "siem_group",
    ]
    assert by_rule[("SEDCMD-mask_cards", None)]["action"] == "mask"
    assert (FW, T + "fw_drop_heartbeat", "uses") in edges
    assert (T + "fw_threats_to_risk", "acme:index:risk", "writes") in edges
    assert (FW, "acme:index:risk", "feeds") in edges  # the sourcetype's data reaches risk
    # Search-time REPORT- rules are field extractions, not index-time rules.
    assert not any(s.get("transform") == "acme_fw_kv" for s in summary)


def test_source_and_host_rules_and_ingest_eval_only_transforms():
    _, by_id, edges = _build()
    audit = by_id[T + "fw_audit_to_os"]
    assert audit["properties"]["appliesTo"] == ["source::/var/log/acme/audit*.log"]
    assert (T + "fw_audit_to_os", "acme:index:os", "writes") in edges
    legacy = by_id[T + "legacy_ingest_eval"]  # only in transforms.conf (INGEST_EVAL)
    assert legacy["properties"]["appliesTo"] == ["host::legacy-*"]
    assert [a["action"] for a in legacy["properties"]["indexTime"]] == [
        "routeToIndex",
        "drop",
        "indexedField",
    ]


def test_rules_part_brings_transforms_with_it():
    bundle, by_id, _ = _build(parts={"indexTimeRules", "sourcetypes"})
    assert T + "fw_drop_heartbeat" in by_id
    assert by_id[FW]["properties"]["indexTime"]


def test_federated_providers_and_indexes():
    _, by_id, edges = _build()
    soc = by_id["acme:federatedProvider:remote_soc"]["properties"]
    assert soc["providerType"] == "splunk" and soc["mode"] == "standard"
    s3 = by_id["acme:federatedProvider:s3_archive"]["properties"]
    assert s3["providerType"] == "aws_s3" and s3["glueTablesAllowed"] == ["vpc_flow", "cloudtrail"]
    fi = "acme:federatedIndex:acme_secops/federated:soc_notables"
    assert by_id[fi]["displayName"] == "soc_notables"
    assert by_id[fi]["properties"] == {
        "provider": "remote_soc",
        "datasetType": "index",
        "dataset": "notable",
    }
    assert (fi, "acme:federatedProvider:remote_soc", "uses") in edges
    # A search on index=federated:<name> reads the federated index, not a local index.
    search = "acme:savedSearch:acme_secops/SOC - Remote Notables"
    assert (search, fi, "reads") in edges
    assert "unresolved" not in (by_id[search].get("lineage") or {})


def test_public_profile_hides_remote_locations_and_accounts():
    bundle, _, _ = _build()
    redact_bundle(bundle, load_profile("public"), salt="t")
    text = json.dumps([e for e in bundle["entities"] if e["type"] == "federatedProvider"])
    for secret in ("soc-sh.acme.example", "123456789012", "s3://acme-lake", "fed_svc"):
        assert secret not in text


def test_federated_index_is_not_also_an_index():
    # Splunk's index list includes federated indexes; they are catalogued once.
    bundle, by_id, _ = _build()
    assert "acme:index:federated:soc_notables" not in by_id
    assert not any(
        e["type"] == "index" and e["name"].startswith("federated:") for e in bundle["entities"]
    )


def test_role_grants_on_federated_patterns():
    from delvecat_ingest.model import Target
    from delvecat_ingest.resolve import Resolver

    _, by_id, _ = _build()
    resolver = Resolver(list(by_id.values()))
    found = resolver.candidates(Target("federatedIndex", "federated:*", pattern=True))
    assert {e["name"] for e in found} == {"federated:soc_notables", "federated:vpc_flow"}


def test_routing_to_a_missing_index_is_flagged():
    from delvecat_ingest.health import evaluate_health

    entities = [
        {"id": "i:index:main", "type": "index", "name": "main", "instance": "i"},
        {
            "id": "i:transform:a/t",
            "type": "transform",
            "name": "t",
            "instance": "i",
            "properties": {
                "indexTime": [{"action": "routeToIndex", "targets": ["main", "acme_errors"]}]
            },
        },
    ]
    evaluate_health(entities, "2026-11-06T00:00:00Z")
    check = entities[1]["health"]["checks"][0]
    assert check["check"] == "routeToMissingIndex" and "acme_errors" in check["message"]
    assert "main," not in check["message"]
