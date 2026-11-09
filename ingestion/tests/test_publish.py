"""Publishing to the DelveCat Splunk app: the one write DelveCat makes."""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
from datetime import datetime
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from delvecat_ingest.compat import UTC
from delvecat_ingest.publish import (
    PublishError,
    encode,
    publish,
    publish_bundle,
    read_published,
    save_doc,
)
from delvecat_ingest.transport import (
    HttpTransport,
    WriteAttemptError,
    check_read_only,
    publish_allowlist,
)

DATA = "/servicesNS/nobody/delvecat/storage/collections/data/delvecat_catalog"
BUNDLE = {
    "schemaVersion": "0.1.0",
    "generatedAt": "2026-01-01T00:00:00Z",
    "instances": [{"id": "prod"}],
    "entities": [{"id": f"splunk:index:prod:i{n}", "name": f"i{n}"} for n in range(500)],
    "edges": [],
}


def matches(doc: dict, q: dict) -> bool:
    """The few KV store query operators publish uses."""
    for key, cond in q.items():
        if key == "$and":
            if not all(matches(doc, c) for c in cond):
                return False
        elif isinstance(cond, dict):
            if "$ne" in cond and doc.get(key) == cond["$ne"]:
                return False
            if "$gte" in cond and not (key in doc and doc[key] >= cond["$gte"]):
                return False
        elif doc.get(key) != cond:
            return False
    return True


class FakeKV:
    """The KV store collection behind Splunk's REST API, as an httpx transport."""

    def __init__(self, status: int | None = None):
        self.docs: dict[str, dict] = {}
        self.status = status
        self.requests: list[tuple[str, str]] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        url = urlparse(str(req.url))
        self.requests.append((req.method, url.path))
        if self.status:
            return httpx.Response(self.status)
        if not url.path.startswith(DATA):
            return httpx.Response(404)
        query = parse_qs(url.query)
        if req.method == "GET":
            docs = list(self.docs.values())
            key = url.path[len(DATA) + 1 :]
            if key:
                return (
                    httpx.Response(200, json=self.docs[key])
                    if key in self.docs
                    else (httpx.Response(404))
                )
            if "query" in query:
                docs = [d for d in docs if matches(d, json.loads(query["query"][0]))]
            return httpx.Response(200, json=docs)
        if req.method == "POST" and url.path.endswith("/batch_save"):
            for d in json.loads(req.content):
                self.docs[d["_key"]] = d
            return httpx.Response(200, json=[])
        if req.method == "DELETE":
            q = json.loads(query["query"][0])
            self.docs = {k: d for k, d in self.docs.items() if not matches(d, q)}
            return httpx.Response(200)
        return httpx.Response(400)


def transport(kv: FakeKV, writes: bool = True) -> HttpTransport:
    return HttpTransport(
        "https://sh:8089",
        "tok",
        backoff=0,
        http_transport=httpx.MockTransport(kv),
        allowed_writes=publish_allowlist("delvecat", "delvecat_catalog") if writes else (),
    )


@pytest.fixture
def bundle_file(tmp_path):
    p = tmp_path / "catalog.json"
    p.write_text(json.dumps(BUNDLE))
    return p


def read_back(kv: FakeKV) -> dict:
    ptr = kv.docs["current"]
    text = "".join(kv.docs[f"{ptr['generation']}-{n}"]["data"] for n in range(ptr["parts"]))
    packed = base64.b64decode(text)
    assert hashlib.sha256(packed).hexdigest() == ptr["sha256"]
    return json.loads(gzip.decompress(packed))


def test_allowlist_is_only_the_catalog_collection():
    allowed = publish_allowlist("delvecat", "delvecat_catalog")
    check_read_only("POST", f"{DATA}/batch_save", allowed)
    check_read_only("DELETE", DATA, allowed)
    for method, path in [
        ("POST", "/servicesNS/nobody/delvecat/storage/collections/data/other/batch_save"),
        ("POST", "/servicesNS/nobody/search/storage/collections/data/delvecat_catalog"),
        ("POST", "/servicesNS/nobody/delvecat/storage/collections/config/delvecat_catalog"),
        ("DELETE", "/servicesNS/nobody/delvecat/storage/collections/config/delvecat_catalog"),
        ("POST", "/services/saved/searches"),
        ("PUT", f"{DATA}/batch_save"),
    ]:
        with pytest.raises(WriteAttemptError):
            check_read_only(method, path, allowed)
    # Without the allowlist (every other command) nothing may be written.
    with pytest.raises(WriteAttemptError):
        check_read_only("POST", f"{DATA}/batch_save")
    with pytest.raises(ValueError):
        publish_allowlist("delvecat/../search", "x")


def test_publish_round_trip_in_parts(bundle_file):
    kv = FakeKV()
    ptr = publish(bundle_file, transport(kv), part_chars=1000, log=lambda _: None)
    assert ptr["parts"] > 1 and ptr["entities"] == 500 and ptr["instances"] == ["prod"]
    assert read_back(kv) == BUNDLE
    # The pointer is written after every part, then older generations are deleted.
    writes = [m for m, _ in kv.requests if m != "GET"]
    assert writes == ["POST"] * (ptr["parts"] + 1) + ["DELETE"]


def test_republish_replaces_the_previous_generation(bundle_file, tmp_path):
    kv = FakeKV()
    publish(bundle_file, transport(kv), part_chars=1000, log=lambda _: None)
    changed = dict(BUNDLE, generatedAt="2026-02-01T00:00:00Z")
    other = tmp_path / "other.json"
    other.write_text(json.dumps(changed))
    publish(other, transport(kv), part_chars=5000, log=lambda _: None)
    assert read_back(kv) == changed
    gen = kv.docs["current"]["generation"]
    assert all(d["generation"] == gen for d in kv.docs.values())


def test_unchanged_catalog_is_not_rewritten(bundle_file):
    kv = FakeKV()
    first = publish(bundle_file, transport(kv), log=lambda _: None)
    kv.requests.clear()
    again = publish(bundle_file, transport(kv), log=lambda _: None)
    assert again["generation"] == first["generation"]
    assert not [m for m, _ in kv.requests if m != "GET"]
    forced = publish(bundle_file, transport(kv), force=True, log=lambda _: None)
    assert forced["generation"] != first["generation"]


def test_generations_are_unique_within_a_second(bundle_file):
    now = datetime(2026, 1, 1, tzinfo=UTC)
    kv = FakeKV()
    a = publish(bundle_file, transport(kv), now=now, force=True, log=lambda _: None)
    b = publish(bundle_file, transport(kv), now=now, force=True, log=lambda _: None)
    assert a["generation"] != b["generation"]


def test_dry_run_writes_nothing(bundle_file):
    kv = FakeKV()
    publish(bundle_file, transport(kv, writes=False), dry_run=True, log=lambda _: None)
    assert not [m for m, _ in kv.requests if m != "GET"] and not kv.docs


@pytest.mark.parametrize("status", [403, 404])
def test_missing_app_or_role_is_explained(bundle_file, status):
    with pytest.raises(PublishError, match="delvecat_publisher"):
        publish(bundle_file, transport(FakeKV(status)), log=lambda _: None)


def test_encode_is_deterministic():
    assert encode(BUNDLE) == encode(BUNDLE)


def test_status_doc_survives_and_catalog_reads_back(bundle_file):
    kv = FakeKV()
    t = transport(kv)
    save_doc(t, {"_key": "build", "state": "running"})
    publish(bundle_file, t, part_chars=1000, log=lambda _: None)
    publish_bundle(dict(BUNDLE, generatedAt="x"), t, part_chars=700, log=lambda _: None)
    assert kv.docs["build"]["state"] == "running"
    assert read_published(t)["generatedAt"] == "x"
    assert read_published(transport(FakeKV())) is None
