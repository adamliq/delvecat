"""Moving a catalog between stacks: read a file or another stack, combine or replace,
publish to this stack's app."""

from __future__ import annotations

import base64
import gzip
import json
from pathlib import Path

import pytest

from delvecat_ingest.inapp import build_here
from delvecat_ingest.publish import publish_bundle
from delvecat_ingest.transfer import (
    TransferError,
    combine,
    decode_upload,
    fetch_remote,
    import_catalog,
    parse_catalog,
    without_instances,
)
from delvecat_ingest.transport import FixtureTransport, WriteAttemptError

from .test_publish import FakeKV, read_back, transport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"


@pytest.fixture(scope="module")
def adhoc():
    return build_here(FixtureTransport(FIXTURE), "adhoc", "Ad hoc search head")


@pytest.fixture(scope="module")
def es():
    return build_here(FixtureTransport(FIXTURE), "es", "ES search head")


def test_reads_json_and_gzip_and_refuses_the_rest(adhoc):
    raw = json.dumps(adhoc).encode()
    assert parse_catalog(raw)["instances"][0]["id"] == "adhoc"
    assert parse_catalog(gzip.compress(raw))["instances"][0]["id"] == "adhoc"
    assert parse_catalog(decode_upload(base64.b64encode(gzip.compress(raw)).decode()))
    sharded = json.dumps({**adhoc, "shards": [{}]}).encode()
    cases = [(b"not json", "not JSON"), (b'{"a": 1}', "schemaVersion")]
    cases += [(b"\x1f\x8bnope", "gzip"), (sharded, "shard")]
    for bad, why in cases:
        with pytest.raises(TransferError, match=why):
            parse_catalog(bad)
    with pytest.raises(TransferError, match="base64"):
        decode_upload("%%%")


def test_combine_keeps_both_stacks(adhoc, es):
    result, summary = combine(adhoc, es)
    assert {i["id"] for i in result["instances"]} == {"adhoc", "es"}
    assert len(result["entities"]) == len(adhoc["entities"]) + len(es["entities"])
    assert summary["keptInstances"] == ["adhoc"] and summary["replacedInstances"] == []
    assert summary["before"] == len(adhoc["entities"]) and summary["after"] == len(
        result["entities"]
    )


def test_importing_the_same_stack_again_replaces_it(adhoc, es):
    both, _ = combine(adhoc, es)
    newer = json.loads(json.dumps(es))
    newer["entities"] = newer["entities"][:10]
    newer_ids = {e["id"] for e in newer["entities"]}
    newer["edges"] = [x for x in newer["edges"] if x["from"] in newer_ids and x["to"] in newer_ids]
    result, summary = combine(both, newer)
    assert summary["replacedInstances"] == ["es"]
    es_now = [e for e in result["entities"] if e["instance"] == "es"]
    assert {e["id"] for e in es_now} == newer_ids
    assert len([e for e in result["entities"] if e["instance"] == "adhoc"]) == len(
        adhoc["entities"]
    )
    # No relationship points at an object that is gone.
    ids = {e["id"] for e in result["entities"]}
    assert all(x["from"] in ids and x["to"] in ids for x in result["edges"])


def test_replace_and_first_import(adhoc, es):
    result, summary = combine(adhoc, es, "replace")
    assert [i["id"] for i in result["instances"]] == ["es"] and summary["mode"] == "replace"
    result, _ = combine(None, es)
    assert result is es
    with pytest.raises(TransferError, match="redacted"):
        combine(adhoc, {**es, "redaction": {"profile": "public"}})


def test_without_instances_drops_their_edges_and_reports(adhoc, es):
    both, _ = combine(adhoc, es)
    left = without_instances(both, {"es"})
    assert {i["id"] for i in left["instances"]} == {"adhoc"}
    assert all(e["instance"] == "adhoc" for e in left["entities"])
    assert all(r.get("instance") != "es" for r in left["ingestionReport"])


def test_import_publishes_to_this_stack(adhoc, es):
    kv = FakeKV()
    publish_bundle(adhoc, transport(kv), log=lambda _m: None)
    summary = import_catalog(transport(kv), es, "combine", "alice", "stack es:8089")
    back = read_back(kv)
    assert {i["id"] for i in back["instances"]} == {"adhoc", "es"}
    assert kv.docs["current"]["publishedBy"] == "alice"
    assert kv.docs["current"]["importedFrom"] == "stack es:8089"
    assert summary["after"] == len(back["entities"])


def test_reading_another_stack_only_reads(es):
    remote_kv = FakeKV()
    publish_bundle(es, transport(remote_kv), log=lambda _m: None)
    before = len(remote_kv.requests)
    got = fetch_remote(transport(remote_kv, writes=False))
    assert got["instances"][0]["id"] == "es"
    assert all(m == "GET" for m, _ in remote_kv.requests[before:])
    # The remote transport cannot write, even by mistake.
    with pytest.raises(WriteAttemptError):
        publish_bundle(
            {**es, "generatedAt": "2027-01-01T00:00:00Z"},
            transport(remote_kv, writes=False),
            log=lambda _m: None,
        )


def test_other_stack_without_catalog_or_access():
    with pytest.raises(TransferError, match="no published catalog"):
        fetch_remote(transport(FakeKV(), writes=False))
    with pytest.raises(TransferError, match="delvecat_user"):
        fetch_remote(transport(FakeKV(status=403), writes=False))


def test_imports_are_marked_so_builds_keep_only_them(adhoc, es):
    from delvecat_ingest.transfer import imported_instances

    kv = FakeKV()
    publish_bundle(adhoc, transport(kv), log=lambda _m: None)
    import_catalog(transport(kv), es, "combine", "alice", "file es.json.gz")
    back = read_back(kv)
    marks = {i["id"]: i.get("imported") for i in back["instances"]}
    assert marks["adhoc"] is None
    assert marks["es"]["from"] == "file es.json.gz" and marks["es"]["by"] == "alice"
    # A build on this stack (new instance id or not) keeps es, never its own old copy.
    assert imported_instances(back, {"adhoc-renamed"}) == {"es"}
    assert imported_instances(back, {"es"}) == set()


def test_remove_an_imported_stack(adhoc, es):
    from delvecat_ingest.transfer import remove_instance

    kv = FakeKV()
    publish_bundle(adhoc, transport(kv), log=lambda _m: None)
    import_catalog(transport(kv), es, "combine", "alice", "file es.json.gz")
    out = remove_instance(transport(kv), "es", "bob")
    assert out["removed"] == "es" and [i["id"] for i in out["instances"]] == ["adhoc"]
    assert {i["id"] for i in read_back(kv)["instances"]} == {"adhoc"}
    assert kv.docs["current"]["removedInstance"] == "es"
    # Only imported stacks can be removed, and never the last one.
    with pytest.raises(TransferError, match="built here"):
        remove_instance(transport(kv), "adhoc", "bob")
    with pytest.raises(TransferError, match="No instance"):
        remove_instance(transport(kv), "nope", "bob")
