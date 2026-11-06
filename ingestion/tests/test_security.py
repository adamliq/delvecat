"""Enterprise Security (live recording), SOAR and UEBA (documented API shapes) together."""

import json
from collections import defaultdict
from pathlib import Path

import pytest

from delvecat_ingest.bundle import assemble, validate
from delvecat_ingest.connectors import enterprise_security, soar, splunk, ueba
from delvecat_ingest.connectors.splunk.security import detection_properties, soar_targets
from delvecat_ingest.transport import FixtureTransport

HERE = Path(__file__).parent
DET = "dev:correlationSearch:"
BRUTE = DET + "DA-ESS-ContentUpdate/ESCU - Brute Force Access Behavior Detected"


@pytest.fixture(scope="module")
def bundle():
    t = FixtureTransport(HERE / "fixtures" / "splunk-9.4-dev")
    r = splunk.extract(t, "dev")
    r.extend(enterprise_security.extract(t, "dev"))
    s = soar.extract(FixtureTransport(HERE / "fixtures" / "soar-sample"), "soar")
    u = ueba.extract(FixtureTransport(HERE / "fixtures" / "ueba-sample"), "uba")
    s.instance_facts = u.instance_facts = {}
    r.extend(s)
    r.extend(u)
    return assemble(
        [
            {"id": "dev", "name": "dev", "kind": "splunkEnterprise"},
            {"id": "soar", "name": "soar", "kind": "soar"},
            {"id": "uba", "name": "uba", "kind": "uba"},
        ],
        r,
    )


@pytest.fixture(scope="module")
def by_id(bundle):
    return {e["id"]: e for e in bundle["entities"]}


def out(bundle, frm, type_=None):
    return sorted(
        (e["type"], e["to"])
        for e in bundle["edges"]
        if e["from"] == frm and (type_ is None or e["type"] == type_)
    )


def downstream(bundle, node, depth=6):
    fwd = {"feeds", "writes", "triggers", "deploys"}
    rev = {"reads", "uses", "mapsTo"}
    down = defaultdict(set)
    for e in bundle["edges"]:
        if e["type"] in fwd:
            down[e["from"]].add(e["to"])
        elif e["type"] in rev:
            down[e["to"]].add(e["from"])
    seen, frontier = {node}, [node]
    for _ in range(depth):
        frontier = [d for n in frontier for d in down[n] if d not in seen and not seen.add(d)]
    seen.discard(node)
    return seen


def test_valid(bundle):
    assert validate(bundle) == []
    statuses = {
        r["connector"]: r["status"]
        for r in bundle["ingestionReport"]
        if r["connector"].split(".")[0] in ("enterpriseSecurity", "soar", "ueba")
    }
    assert set(statuses.values()) == {"ok"}, statuses


def test_detections_carry_es_metadata(by_id):
    d = by_id[BRUTE]
    assert d["type"] == "correlationSearch" and d["product"] == "enterpriseSecurity"
    p = d["properties"]
    assert p["mitreAttack"] == ["T1110", "T1110.001"]
    assert p["analyticStories"] == ["Credential Access via Brute Force"]
    assert p["securityDomain"] == "access" and p["severity"] == "high"
    assert p["createsNotable"] and p["createsRisk"]
    assert p["riskObjects"] == [{"field": "src", "type": "system", "score": 40}]
    assert p["soarLabels"] == ["brute_force"]
    disabled = by_id[DET + "SplunkEnterpriseSecuritySuite/Access - Excessive Failed Logins - Rule"]
    assert disabled["disabled"] is True


def test_detection_lineage_and_actions(bundle):
    edges = out(bundle, BRUTE)
    assert ("reads", "dev:dataModel:Splunk_SA_CIM/Authentication") in edges
    assert ("writes", "dev:index:notable") in edges and ("writes", "dev:index:risk") in edges
    assert ("triggers", "dev:adaptiveResponseAction:sendtophantom") in edges
    assert ("contains", BRUTE) in out(bundle, "dev:analyticStory:Credential Access via Brute Force")


def test_detection_to_soar_playbook_chain(bundle, by_id):
    """Phase 5 exit criterion: detection → SOAR label → playbook."""
    assert ("triggers", "soar:soarLabel:brute_force") in out(bundle, BRUTE)
    assert out(bundle, "soar:soarLabel:brute_force") == [
        ("triggers", "soar:soarPlaybook:brute_force_response")
    ]
    assert "soar:soarPlaybook:brute_force_response" in downstream(bundle, BRUTE)
    # the malware detection reaches its playbook too, even though it is blind
    blind = DET + "DA-ESS-ContentUpdate/ESCU - Suspicious PowerShell Execution"
    assert "soar:soarPlaybook:malware_triage" in downstream(bundle, blind)
    assert by_id[blind]["lineage"]["unresolved"] == ["dataModel:Endpoint"]


def test_soar_objects_without_secrets(bundle, by_id):
    assert by_id["soar:soarPlaybook:enrich_everything"]["disabled"] is True
    assert out(bundle, "soar:soarAsset:edge_firewall") == [
        ("uses", "soar:soarApp:Palo Alto Networks Firewall")
    ]
    assert by_id["soar:soarAsset:es_search_head"]["properties"]["configured"] is True
    assert not any(e["to"].startswith("soar:soarPlaybook:enrich") for e in bundle["edges"])
    text = json.dumps(bundle)
    assert "SHOULD-NEVER-APPEAR" not in text and "soar_svc" not in text


def test_ueba_chain_from_index_to_es(bundle, by_id):
    chain = downstream(bundle, "dev:index:wineventlog")
    assert {
        "uba:uebaDataSource:Windows Security (Splunk Direct)",
        "uba:uebaModel:Unusual Logon Activity",
        "uba:uebaAnomalyType:Excessive Failed Logins",
        "uba:uebaThreatRule:Compromised Account",
        "uba:uebaOutputConnector:Enterprise Security",
        "dev:index:notable",
    } <= chain
    assert by_id["uba:uebaDataSource:Legacy Proxy"]["disabled"] is True


def test_product_attribution(by_id):
    assert by_id["dev:app:SA-ThreatIntelligence"]["product"] == "enterpriseSecurity"
    assert by_id["dev:adaptiveResponseAction:notable"]["product"] == "enterpriseSecurity"
    assert by_id["dev:adaptiveResponseAction:sendtophantom"]["product"] == "soar"
    assert by_id["dev:dataModel:Splunk_SA_CIM/Authentication"]["product"] == "splunk"  # CIM


def test_threat_intel_and_identity_sources(bundle, by_id):
    phish = by_id["dev:threatIntelSource:open_phish"]
    assert phish["disabled"] is True
    assert phish["properties"]["url"] == "https://feeds.example.org/phish.csv"  # creds stripped
    assert out(bundle, "dev:assetIdentitySource:acme_assets") == [
        ("reads", "dev:lookup:TA-acme-firewall/asset_owners")
    ]


def test_escu_style_keys_and_soar_params():
    props = detection_properties(
        {
            "action.escu.mappings": json.dumps({"mitre_attack": ["t1003.001", "not-an-id"]}),
            "action.escu.analytic_story": json.dumps(["Credential Dumping"]),
            "action.escu.data_models": json.dumps(["Endpoint"]),
            "action.risk.param._risk_object": "dest",
            "action.risk.param._risk_score": "60",
        }
    )
    assert props["mitreAttack"] == ["T1003.001"]
    assert props["analyticStories"] == ["Credential Dumping"]
    assert props["dataModels"] == ["Endpoint"]
    assert props["riskObjects"][0]["field"] == "dest"
    labels, playbooks = soar_targets(
        {
            "action.sendtophantom.param.label": "a, b",
            "action.runplaybook.param.playbook_name": "p1",
            "action.email.param.label": "ignored",
        },
        ["sendtophantom", "runplaybook", "email"],
    )
    assert labels == ["a", "b"] and playbooks == ["p1"]
