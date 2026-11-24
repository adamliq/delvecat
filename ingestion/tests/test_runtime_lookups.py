"""Lookups searches create when they run, and sourcetypes with no data, are not broken
references."""

from __future__ import annotations

from delvecat_ingest.bundle import assemble
from delvecat_ingest.model import ExtractResult


def search(name, spl, app="ds"):
    return {"id": f"i:savedSearch:{app}/{name}", "type": "savedSearch", "name": name,
            "instance": "i", "app": app, "properties": {"search": spl}}  # fmt: skip


def build(*entities):
    instance = {"id": "i", "name": "i", "kind": "splunkEnterprise"}
    return assemble([instance], ExtractResult(entities=list(entities)))


def test_a_lookup_one_search_writes_and_another_reads_is_linked_not_broken():
    writer = search(
        "Create agents", "index=_internal | stats count by host | outputlookup agents.csv"
    )
    reader = search("Clients", "| inputlookup agents.csv | stats count")
    bundle = build(writer, reader)
    by_id = {e["id"]: e for e in bundle["entities"]}
    lk = by_id["i:lookup:ds/agents.csv"]
    assert lk["properties"] == {"kind": "runtime", "createdBy": [writer["id"]]}
    edges = {(x["from"], x["type"], x["to"]) for x in bundle["edges"]}
    assert (writer["id"], "writes", lk["id"]) in edges
    assert (reader["id"], "reads", lk["id"]) in edges
    assert "unresolved" not in (by_id[reader["id"]].get("lineage") or {})
    assert not (lk.get("usage") or {}).get("unused")


def test_reading_a_lookup_nothing_creates_is_still_broken():
    reader = search("Clients", "| inputlookup nowhere.csv | stats count")
    bundle = build(reader)
    lineage = next(e for e in bundle["entities"] if e["id"] == reader["id"])["lineage"]
    assert lineage["unresolved"] == ["lookup:nowhere.csv"]


def test_sourcetypes_with_no_data_are_noted_not_broken():
    s = search("Telemetry", "sourcetype=upgrade_script | stats count")
    bundle = build(s)
    lineage = next(e for e in bundle["entities"] if e["id"] == s["id"])["lineage"]
    assert lineage["noData"] == ["upgrade_script"]
    assert "unresolved" not in lineage


def test_earlier_builds_changes_are_kept_newest_first():
    import json

    from delvecat_ingest.bundle import HISTORY_BUILDS

    a = search("A", "index=web | stats count")
    first = build(a)
    previous = first
    gens = []
    for n in range(HISTORY_BUILDS + 3):
        changed = dict(a, properties={"search": f"index=web | head {n + 1}"})
        instance = {"id": "i", "name": "i", "kind": "splunkEnterprise"}
        from datetime import datetime, timedelta, timezone

        when = datetime(2026, 11, 1, tzinfo=timezone.utc) + timedelta(days=n + 1)
        nxt = assemble([instance], ExtractResult(entities=[json.loads(json.dumps(changed))]),
                       when, previous)  # fmt: skip
        gens.append(nxt["generatedAt"])
        previous = nxt
    hist = previous["changeHistory"]
    assert len(hist) == HISTORY_BUILDS
    assert [h["generatedAt"] for h in hist] == gens[-2::-1][:HISTORY_BUILDS]  # newest first
    assert all(a["id"] in h["modified"] for h in hist)
    assert previous["changes"]["modified"] == [a["id"]]
