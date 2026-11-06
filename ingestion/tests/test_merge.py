import copy
import json
from pathlib import Path

import pytest

from delvecat_ingest.bundle import load_bundle, validate
from delvecat_ingest.cli import main
from delvecat_ingest.connectors import splunk
from delvecat_ingest.merge import MergeError, merge_bundles

HERE = Path(__file__).parent
RECORDED = HERE / "fixtures" / "splunk-9.4-dev"
APPS = HERE.parents[1] / "deploy" / "deployment-apps"
BRUTE = "acme:correlationSearch:DA-ESS-ContentUpdate/ESCU - Brute Force Access Behavior Detected"
HOURLY = "acme:savedSearch:acme_web/Web - Hourly Status Summary"


def build(out: Path, *args: str) -> Path:
    assert main(["build", "--out", str(out), *args]) == 0
    return out


@pytest.fixture(scope="module")
def parts(tmp_path_factory):
    d = tmp_path_factory.mktemp("parts")
    no_indexes = ",".join(n for n in splunk.EXTRACTORS if n not in ("indexes", "fields"))
    return {
        # a search head without the indexes: they are configured on the indexers
        "sh": build(
            d / "sh.json",
            "--fixtures",
            str(RECORDED),
            "--instance",
            "acme",
            "--only",
            no_indexes,
            "--products",
            "dbConnect,stream,enterpriseSecurity",
        ),
        "idx": build(
            d / "idx",
            "--fixtures",
            str(RECORDED),
            "--instance",
            "acme-idx",
            "--only",
            "serverInfo,indexes",
            "--products",
            "none",
            "--shard",
        ),
        "ds": build(
            d / "ds.json",
            "--fixtures",
            str(RECORDED),
            "--instance",
            "acme-ds",
            "--only",
            "serverInfo",
            "--products",
            "deploymentServer",
            "--deployment-apps-dir",
            str(APPS),
        ),
        "soar": build(
            d / "soar.json",
            "--instance",
            "soar",
            "--soar-fixtures",
            str(HERE / "fixtures" / "soar-sample"),
        ),
    }


@pytest.fixture(scope="module")
def merged(parts, tmp_path_factory):
    d = tmp_path_factory.mktemp("m")
    ann = d / "annotations"
    ann.mkdir()
    # annotation ids include the instance: the web index now lives on the indexers
    (ann / "pii.yaml").write_text(
        "annotations:\n  - id: acme-idx:index:web\n    classifications: [PII.IPAddress]\n"
    )
    out = d / "merged.json"
    assert (
        main(
            [
                "merge",
                *(str(p) for p in parts.values()),
                "--annotations",
                str(ann),
                "--strict",
                "--out",
                str(out),
            ]
        )
        == 0
    )
    return json.loads(out.read_text())


def edges(b, frm=None, to=None):
    return {
        (e["from"], e["type"], e["to"])
        for e in b["edges"]
        if (frm is None or e["from"] == frm) and (to is None or e["to"] == to)
    }


def test_parts_alone(parts):
    sh = {e["id"]: e for e in load_bundle(parts["sh"])["entities"]}
    stub = sh["acme:index:web"]  # seen by the search head's tstats and license searches
    assert set(stub["properties"]) == {"observed"}
    ds = load_bundle(parts["ds"])
    assert {r["target"]["name"] for r in ds["references"]} >= {"os", "web"}


def test_merged_bundle_is_valid_and_reports(merged):
    assert validate(merged) == []
    assert [i["id"] for i in merged["instances"]] == ["acme", "acme-idx", "acme-ds", "soar"]
    assert [m["source"] for m in merged["mergedFrom"]] == ["sh.json", "idx", "ds.json", "soar.json"]
    report = next(r for r in merged["ingestionReport"] if r["connector"] == "merge")
    assert report["counts"]["crossInstanceEdges"] > 10
    assert report["counts"]["foldedIndexes"] >= 5
    assert {
        r.get("instance") for r in merged["ingestionReport"] if r["connector"].startswith("splunk.")
    } == {"acme", "acme-idx", "acme-ds"}


def test_search_head_stubs_fold_into_indexer_indexes(merged):
    by = {e["id"]: e for e in merged["entities"]}
    assert "acme:index:web" not in by
    web = by["acme-idx:index:web"]
    assert web["properties"]["datatype"] == "event"  # configuration from the indexer
    assert web["properties"]["observed"]["dailyEvents"]  # observation from the search head
    assert (HOURLY, "reads", "acme-idx:index:web") in edges(merged, frm=HOURLY)
    assert (HOURLY, "writes", "acme-idx:index:summary_web") in edges(merged, frm=HOURLY)
    legacy = by["acme:savedSearch:search/Legacy - Proxy Categories"]
    assert "index:legacy_proxy" in legacy["lineage"]["unresolved"]  # still truly missing


def test_role_patterns_cover_remote_indexes_and_governance(merged):
    granted = {
        t
        for _, _, t in edges(merged, frm="acme:role:acme_web_analyst")
        if t.startswith("acme-idx:index:")
    }
    assert {"acme-idx:index:web", "acme-idx:index:summary_web"} <= granted
    web = next(e for e in merged["entities"] if e["id"] == "acme-idx:index:web")
    assert "acme:user:mpatel" in web["governance"]["access"]["users"]


def test_deployment_and_soar_links(merged):
    assert ("acme-ds:deploymentClient:uf-linux-01", "feeds", "acme:host:uf-linux-01") in edges(
        merged, frm="acme-ds:deploymentClient:uf-linux-01"
    )
    feeding_os = {f for f, _, _ in edges(merged, to="acme-idx:index:os")}
    assert any(f.startswith("acme-ds:input:acme_linux_inputs") for f in feeding_os)
    assert (BRUTE, "triggers", "soar:soarLabel:brute_force") in edges(merged, frm=BRUTE)


def test_merge_then_redact(parts, tmp_path, monkeypatch):
    monkeypatch.setenv("DELVECAT_REDACT_SALT", "t")
    out = tmp_path / "pub.json"
    assert (
        main(
            [
                "merge",
                *(str(p) for p in parts.values()),
                "--redact-profile",
                "public",
                "--out",
                str(out),
            ]
        )
        == 0
    )
    text = out.read_text()
    assert "uf-linux-01" not in text and "mpatel" not in text
    assert "references" not in json.loads(text)
    # a redacted bundle cannot be merged again
    assert main(["merge", str(out), str(parts["soar"]), "--out", str(tmp_path / "x.json")]) == 2


def unit(instance, entities, edges=(), refs=()):
    return {
        "schemaVersion": "0.1.2",
        "generatedAt": "2026-01-01T00:00:00Z",
        "generator": {"name": "t", "version": "0"},
        "instances": [{"id": instance, "name": instance, "kind": "splunkEnterprise"}],
        "entities": entities,
        "edges": list(edges),
        "references": list(refs),
        "ingestionReport": [],
    }


def ent(eid, **kw):
    _, type_, name = eid.split(":", 2)
    return {
        "id": eid,
        "type": type_,
        "name": name,
        "product": "splunk",
        "instance": eid.split(":")[0],
        **kw,
    }


def ref(known, type_, name):
    return {
        "known": known,
        "edgeType": "reads",
        "target": {"type": type_, "name": name},
        "knownIsFrom": True,
        "origin": "spl",
    }


def test_broken_reference_fixed_by_another_instance():
    idx = unit("idx", [ent("idx:index:web", properties={"datatype": "event"})])
    sh = unit(
        "sh",
        [ent("sh:savedSearch:a/s", app="a", lineage={"unresolved": ["index:web", "lookup:gone"]})],
        refs=[ref("sh:savedSearch:a/s", "index", "web")],
    )
    m = merge_bundles([("idx", idx), ("sh", sh)])
    s = next(e for e in m["entities"] if e["id"] == "sh:savedSearch:a/s")
    assert s["lineage"] == {"unresolved": ["lookup:gone"]}
    assert ("sh:savedSearch:a/s", "reads", "idx:index:web") in edges(m)
    assert "references" not in m  # resolved, and not a pattern


def test_unused_cleared_when_another_instance_uses_it():
    idx = unit(
        "idx",
        [
            ent(
                "idx:index:web",
                properties={"datatype": "event"},
                usage={"unused": True, "reason": "x"},
            )
        ],
    )
    sh = unit(
        "sh", [ent("sh:savedSearch:a/s", app="a")], refs=[ref("sh:savedSearch:a/s", "index", "web")]
    )
    m = merge_bundles([("idx", idx), ("sh", sh)])
    web = next(e for e in m["entities"] if e["id"] == "idx:index:web")
    assert "unused" not in web["usage"]
    counts = next(r for r in m["ingestionReport"] if r["connector"] == "merge")["counts"]
    assert counts["noLongerUnused"] == 1


def test_ambiguous_stubs_are_left_alone():
    a = unit("a", [ent("a:index:web", properties={"datatype": "event"})])
    b = unit("b", [ent("b:index:web", properties={"datatype": "event"})])
    sh = unit("sh", [ent("sh:index:web", properties={"observed": {"eventCount": 1}})])
    m = merge_bundles([("a", a), ("b", b), ("sh", sh)])
    assert {e["id"] for e in m["entities"]} == {"a:index:web", "b:index:web", "sh:index:web"}


def test_merge_errors_and_versions():
    a = unit("a", [ent("a:index:x")])
    with pytest.raises(MergeError, match="at least two"):
        merge_bundles([("a", a)])
    with pytest.raises(MergeError, match="appears in both"):
        merge_bundles([("a", a), ("a2", copy.deepcopy(a))])
    red = unit("b", [ent("b:index:y")])
    red["redaction"] = {"profile": "public"}
    with pytest.raises(MergeError, match="redacted"):
        merge_bundles([("a", a), ("b", red)])
    b = unit("b", [ent("b:index:y")])
    first = merge_bundles([("a", copy.deepcopy(a)), ("b", copy.deepcopy(b))])
    b2 = unit("b", [ent("b:index:y", properties={"datatype": "metric"}), ent("b:index:z")])
    second = merge_bundles([("a", copy.deepcopy(a)), ("b", b2)], previous=first)
    assert second["changes"]["added"] == ["b:index:z"]
    assert second["changes"]["modified"] == ["b:index:y"]
