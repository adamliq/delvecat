import json

import pytest

from delvecat_ingest.bundle import (
    apply_versions,
    assemble,
    content_hash,
    load_bundle,
    merge_entities,
    validate,
    write_bundle,
)
from delvecat_ingest.model import ExtractResult, entity, fqn

INSTANCE = [{"id": "i", "name": "i", "kind": "splunkEnterprise"}]


def idx(name, **observed):
    return entity(
        id=fqn("i", "index", name),
        type="index",
        name=name,
        instance="i",
        properties={"datatype": "event"},
        observed=observed or None,
    )


def test_fqn_scheme():
    assert fqn("i", "index", "web") == "i:index:web"
    assert fqn("i", "macro", "m", app="a", owner="admin", sharing="app") == "i:macro:a/m"
    assert (
        fqn("i", "savedSearch", "s", app="a", owner="jlee", sharing="user")
        == "i:savedSearch:a/@jlee/s"
    )


def test_merge_combines_sources():
    a = entity(
        id="i:sourcetype:st",
        type="sourcetype",
        name="st",
        instance="i",
        app="ta",
        properties={"definedIn": ["ta"], "parsing": {"TZ": "UTC"}},
    )
    b = entity(
        id="i:sourcetype:st",
        type="sourcetype",
        name="st",
        instance="i",
        properties={"definedIn": ["other"]},
        observed={"eventCount": 5},
    )
    (m,) = merge_entities([a, b])
    assert m["app"] == "ta"
    assert m["properties"]["definedIn"] == ["ta", "other"]
    assert m["properties"]["parsing"] == {"TZ": "UTC"}
    assert m["properties"]["observed"] == {"eventCount": 5}


def test_content_hash_ignores_observed_measurements():
    assert content_hash(idx("web", totalEventCount=1)) == content_hash(
        idx("web", totalEventCount=9)
    )
    changed = idx("web")
    changed["properties"]["datatype"] = "metric"
    assert content_hash(changed) != content_hash(idx("web"))


def test_versioning_across_runs():
    first = [idx("web"), idx("fw")]
    assert apply_versions(first, "2026-01-01T00:00:00Z", None) is None
    prev = {"generatedAt": "2026-01-01T00:00:00Z", "entities": first}

    second = [idx("web", totalEventCount=10), idx("fw"), idx("new")]
    second[1]["properties"]["datatype"] = "metric"
    second = [e for e in second]
    prev["entities"] = [e for e in first if e["name"] != "gone"] + [
        {**idx("gone"), "version": 1, "firstSeenAt": "2025-12-01T00:00:00Z", "contentHash": "x"}
    ]
    changes = apply_versions(second, "2026-01-02T00:00:00Z", prev)
    by = {e["name"]: e for e in second}
    assert by["web"]["version"] == 1 and by["web"]["firstSeenAt"] == "2026-01-01T00:00:00Z"
    assert by["fw"]["version"] == 2
    assert by["new"]["version"] == 1 and by["new"]["firstSeenAt"] == "2026-01-02T00:00:00Z"
    assert changes["added"] == ["i:index:new"]
    assert changes["modified"] == ["i:index:fw"]
    assert changes["removed"] == [{"id": "i:index:gone", "type": "index", "name": "gone"}]


def test_assemble_drops_dangling_and_duplicate_edges():
    r = ExtractResult(
        entities=[idx("web")],
        edges=[
            {"from": "i:app:none", "to": "i:index:web", "type": "contains"},
        ],
    )
    b = assemble(INSTANCE, r)
    assert b["edges"] == []
    assert validate(b) == []


def test_shard_roundtrip_and_integrity(tmp_path):
    r = ExtractResult(
        entities=[idx("web"), entity(id="i:app:a", type="app", name="a", instance="i")],
        edges=[{"from": "i:app:a", "to": "i:index:web", "type": "contains"}],
    )
    bundle = assemble(INSTANCE, r)
    files = write_bundle(bundle, tmp_path / "out", shard=True)
    manifest = json.loads(files[0].read_text())
    assert manifest["entities"] == [] and manifest["edges"] == []
    assert {s["path"] for s in manifest["shards"]} == {
        "entities/app.json",
        "entities/index.json",
        "edges.json",
    }
    assert validate(manifest) == []
    loaded = load_bundle(tmp_path / "out")
    assert loaded["entities"] == bundle["entities"] and loaded["edges"] == bundle["edges"]

    (tmp_path / "out" / "edges.json").write_text('{"edges": []}\n')
    with pytest.raises(ValueError, match="sha256"):
        load_bundle(tmp_path / "out")


def test_epoch_updated_time_is_dropped():
    e = entity(
        id="i:macro:a/m",
        type="macro",
        name="m",
        instance="i",
        updatedAt="1970-01-01T00:00:00+00:00",
    )
    assert "updatedAt" not in e
