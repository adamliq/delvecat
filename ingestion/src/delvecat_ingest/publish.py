"""Publish a catalog to the DelveCat Splunk app.

The app keeps the catalog in its own KV store collection: gzip-compressed JSON,
base64-encoded and split into parts (a KV store document is limited in size),
plus a pointer document ``current``. A new catalog is written as a new
generation first; the pointer then switches to it in one write, and only then
are older generations deleted. A page loading meanwhile sees either the old or
the new catalog, never a mix (the sha256 in the pointer checks this).

This is the only write DelveCat makes to Splunk, and only to that collection
(see ``transport.publish_allowlist``).
"""

from __future__ import annotations

import base64
import gzip
import hashlib
import json
import uuid
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from .bundle import load_bundle
from .compat import UTC
from .transport import EndpointForbidden, EndpointNotFound

ENCODING = "gzip+base64"
DEFAULT_PART_CHARS = 4 * 1024 * 1024  # well under the KV store's 16 MB document limit


class PublishError(RuntimeError):
    pass


def encode(
    bundle: dict[str, Any], part_chars: int = DEFAULT_PART_CHARS
) -> tuple[list[str], str, int]:
    """(base64 parts, sha256 of the compressed bytes, compressed size)."""
    raw = json.dumps(bundle, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    packed = gzip.compress(raw, compresslevel=9, mtime=0)
    text = base64.b64encode(packed).decode("ascii")
    parts = [text[i : i + part_chars] for i in range(0, len(text), part_chars)] or [""]
    return parts, hashlib.sha256(packed).hexdigest(), len(packed)


def data_path(app: str = "delvecat", collection: str = "delvecat_catalog") -> str:
    return f"/servicesNS/nobody/{app}/storage/collections/data/{collection}"


def _current(transport: Any, data: str, app: str, collection: str) -> dict[str, Any] | None:
    # Reading the data (not the collection's config, which needs more than the
    # publisher role) also checks access: Splunk answers 404 when it is not allowed.
    try:
        docs = transport.get(data, {"query": json.dumps({"_key": "current"})})
    except (EndpointNotFound, EndpointForbidden):
        raise PublishError(
            f"cannot reach the {collection} collection of the {app} app: install the app, "
            "and give this account the delvecat_publisher role"
        ) from None
    return docs[0] if docs else None


def read_published(
    transport: Any, app: str = "delvecat", collection: str = "delvecat_catalog"
) -> dict[str, Any] | None:
    """The catalog currently published to the app, or None (e.g. to use as --previous)."""
    data = data_path(app, collection)
    pointer = _current(transport, data, app, collection)
    if not pointer or pointer.get("encoding") != ENCODING:
        return None
    text = ""
    for n in range(int(pointer["parts"])):
        try:
            text += transport.get(f"{data}/{pointer['generation']}-{n}")["data"]
        except EndpointNotFound:
            return None  # replaced meanwhile
    packed = base64.b64decode(text)
    if hashlib.sha256(packed).hexdigest() != pointer["sha256"]:
        return None
    return json.loads(gzip.decompress(packed))


def save_doc(
    transport: Any,
    doc: dict[str, Any],
    app: str = "delvecat",
    collection: str = "delvecat_catalog",
) -> None:
    """Upsert one document of the collection (the app's build status)."""
    _post(transport, f"{data_path(app, collection)}/batch_save", [doc], doc.get("_key", "doc"))


def publish(
    path: Path,
    transport: Any,
    app: str = "delvecat",
    collection: str = "delvecat_catalog",
    part_chars: int = DEFAULT_PART_CHARS,
    now: datetime | None = None,
    dry_run: bool = False,
    force: bool = False,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Write the bundle at ``path`` to the app's collection; returns the new pointer."""
    data = data_path(app, collection)
    _current(transport, data, app, collection)  # access check before reading a big bundle
    return publish_bundle(
        load_bundle(path),
        transport,
        app=app,
        collection=collection,
        part_chars=part_chars,
        now=now,
        dry_run=dry_run,
        force=force,
        log=log,
    )


def publish_bundle(
    bundle: dict[str, Any],
    transport: Any,
    app: str = "delvecat",
    collection: str = "delvecat_catalog",
    part_chars: int = DEFAULT_PART_CHARS,
    now: datetime | None = None,
    dry_run: bool = False,
    force: bool = False,
    extra: dict[str, Any] | None = None,
    log: Callable[[str], None] = print,
) -> dict[str, Any]:
    """Write ``bundle`` to the app's collection; returns the new pointer."""
    data = data_path(app, collection)
    current = _current(transport, data, app, collection)
    parts, sha, size = encode(bundle, part_chars)
    now = now or datetime.now(UTC)
    # Unique even for the same catalog published twice in a second: a generation's
    # parts are never overwritten while a pointer may still name them.
    generation = f"g{now.strftime('%Y%m%dT%H%M%SZ')}-{sha[:8]}-{uuid.uuid4().hex[:6]}"
    pointer = {
        "_key": "current",
        "generation": generation,
        "parts": len(parts),
        "sha256": sha,
        "bytes": size,
        "encoding": ENCODING,
        "publishedAt": now.isoformat(timespec="seconds"),
        "schemaVersion": bundle.get("schemaVersion"),
        "generatedAt": bundle.get("generatedAt"),
        "entities": len(bundle.get("entities", [])),
        "edges": len(bundle.get("edges", [])),
        "instances": [i.get("id") for i in bundle.get("instances", [])],
        **(extra or {}),
    }
    log(
        f"{pointer['entities']:,} objects, {pointer['edges']:,} relationships: "
        f"{size / 1e6:.1f} MB compressed in {len(parts)} part(s), generation {generation}"
    )
    if dry_run:
        return pointer
    if current and current.get("sha256") == sha and not force:
        log("unchanged since the last publish; nothing written (use --force to rewrite)")
        return current

    for n, chunk in enumerate(parts):
        doc = {"_key": f"{generation}-{n}", "generation": generation, "part": n, "data": chunk}
        _post(transport, f"{data}/batch_save", [doc], f"part {n + 1} of {len(parts)}")
    # The switch: one write, after every part is stored.
    _post(transport, f"{data}/batch_save", [pointer], "pointer")
    # Parts of older generations (and of an interrupted publish); never the pointer or
    # the build status, which have no part number.
    stale = {"$and": [{"part": {"$gte": 0}}, {"generation": {"$ne": generation}}]}
    resp = transport.request("DELETE", data, params={"query": json.dumps(stale)})
    if resp.status_code >= 400:
        log(f"warning: could not delete older catalogs (HTTP {resp.status_code})")
    log(f"published to {app}/{collection}")
    return pointer


def _post(transport: Any, path: str, docs: list[dict[str, Any]], label: str) -> None:
    resp = transport.request(
        "POST",
        path,
        content=json.dumps(docs),
        headers={"Content-Type": "application/json"},
        params={"output_mode": "json"},
    )
    if resp.status_code in (401, 403):
        raise PublishError(
            f"not allowed to write {label} (HTTP {resp.status_code}): "
            "the account needs the delvecat_publisher role"
        )
    if resp.status_code >= 400:
        raise PublishError(f"writing {label} failed: HTTP {resp.status_code} {resp.text[:300]}")
