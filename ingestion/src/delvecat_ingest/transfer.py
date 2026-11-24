"""Move a catalog between stacks: read it (from a file, or from another stack's app),
then combine it with this stack's catalog or replace it, and publish.

Combining keeps this stack's instances and takes the imported ones; an instance in
both (a stack exported again) is replaced by the imported copy, so importing the
same stack every day refreshes it. The other stack is only read (its published
catalog, GETs only); the token is used for those reads and never stored.
"""

from __future__ import annotations

import base64
import gzip
import io
import json
from datetime import datetime
from typing import Any

from .compat import UTC
from .merge import MergeError, merge_bundles
from .publish import PublishError, publish_bundle, read_published

MAX_UNCOMPRESSED = 1_500_000_000  # a catalog this big would not load in a browser anyway


class TransferError(ValueError):
    pass


def parse_catalog(data: bytes) -> dict[str, Any]:
    """A catalog file: JSON, or JSON gzipped (as Export downloads it)."""
    if data[:2] == b"\x1f\x8b":
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(data)) as f:
                data = f.read(MAX_UNCOMPRESSED + 1)
        except (OSError, EOFError) as exc:
            raise TransferError(f"Not a valid gzip file: {exc}.") from None
        if len(data) > MAX_UNCOMPRESSED:
            raise TransferError("The catalog is too large to import.")
    try:
        bundle = json.loads(data)
    except ValueError:
        raise TransferError("Not a catalog: the file is not JSON.") from None
    check_catalog(bundle)
    return bundle


def check_catalog(bundle: Any) -> None:
    if not isinstance(bundle, dict) or not str(bundle.get("schemaVersion", "")).startswith("0.1."):
        raise TransferError("Not a Licoryx Delvecat catalog (no supported schemaVersion).")
    if bundle.get("shards"):
        raise TransferError(
            "This catalog is split into shard files: export it from the app, or build it "
            "without --shard."
        )
    for key in ("instances", "entities", "edges"):
        if not isinstance(bundle.get(key), list):
            raise TransferError(f"Not a catalog: no {key} list.")
    if not bundle["instances"]:
        raise TransferError("The catalog has no instances.")


def decode_upload(text: str) -> bytes:
    try:
        return base64.b64decode(text, validate=True)
    except ValueError:
        raise TransferError("The upload is not valid base64.") from None


def without_instances(bundle: dict[str, Any], ids: set[str]) -> dict[str, Any]:
    """The bundle less the objects, relationships and reports of these instances."""
    out = dict(bundle)
    gone = {e["id"] for e in bundle["entities"] if e.get("instance") in ids}
    out["instances"] = [i for i in bundle["instances"] if i["id"] not in ids]
    out["entities"] = [e for e in bundle["entities"] if e["id"] not in gone]
    out["edges"] = [x for x in bundle["edges"] if x["from"] not in gone and x["to"] not in gone]
    out["ingestionReport"] = [
        r for r in bundle.get("ingestionReport", []) if r.get("instance") not in ids
    ]
    out.pop("mergedFrom", None)
    return out


def combine(
    current: dict[str, Any] | None,
    imported: dict[str, Any],
    mode: str = "combine",
    now: datetime | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """The catalog to publish, and what happened (for the page)."""
    if mode not in ("combine", "replace"):
        raise TransferError("Mode must be combine or replace.")
    new_ids = {i["id"] for i in imported["instances"]}
    summary: dict[str, Any] = {
        "mode": mode,
        "importedInstances": sorted(new_ids),
        "before": len((current or {}).get("entities", [])),
    }
    if mode == "replace" or not current:
        result = imported
    else:
        if imported.get("redaction") or current.get("redaction"):
            raise TransferError(
                "A redacted catalog cannot be combined (names are pseudonymised): "
                "replace instead, or export catalogs built without redaction."
            )
        kept = without_instances(current, new_ids)
        summary["replacedInstances"] = sorted(new_ids & {i["id"] for i in current["instances"]})
        summary["keptInstances"] = sorted(i["id"] for i in kept["instances"])
        if not kept["instances"]:
            result = imported
        else:
            try:
                result = merge_bundles(
                    [("this stack", kept), ("imported", imported)],
                    generated_at=now or datetime.now(UTC),
                    previous=current,
                )
            except MergeError as exc:
                raise TransferError(f"Cannot combine the catalogs: {exc}.") from None
    summary["after"] = len(result["entities"])
    summary["instances"] = [
        {"id": i["id"], "name": i.get("name") or i["id"]} for i in result["instances"]
    ]
    return result, summary


def import_catalog(
    local: Any,
    imported: dict[str, Any],
    mode: str,
    user: str,
    source: str,
    app: str = "delvecat",
    collection: str = "delvecat_catalog",
) -> dict[str, Any]:
    """Combine or replace, then publish to this stack's app (``local`` is a transport
    allowed to write the app's collection only)."""
    check_catalog(imported)
    # Mark the imported instances, so a build on this stack keeps them (and only them).
    at = datetime.now(UTC).isoformat(timespec="seconds")
    imported = {
        **imported,
        "instances": [
            {**i, "imported": {"from": source[:200], "at": at, "by": user}}
            for i in imported["instances"]
        ],
    }
    try:
        current = read_published(local, app, collection)
    except PublishError as exc:
        raise TransferError(str(exc)) from None
    result, summary = combine(current, imported, mode)
    pointer = publish_bundle(
        result,
        local,
        app,
        collection,
        extra={"publishedBy": user, "importedFrom": source[:200]},
        log=lambda _msg: None,
    )
    summary["generation"] = pointer.get("generation")
    summary["source"] = source
    return summary


def fetch_remote(
    remote: Any, app: str = "delvecat", collection: str = "delvecat_catalog"
) -> dict[str, Any]:
    """The catalog published on another stack (``remote`` is a read-only transport)."""
    try:
        bundle = read_published(remote, app, collection)
    except PublishError:
        raise TransferError(
            "Cannot read the other stack's catalog: install Licoryx Delvecat there, and use "
            "a token of an account with the delvecat_user or delvecat_publisher role."
        ) from None
    if bundle is None:
        raise TransferError(
            "The other stack has no published catalog (or it changed while reading): "
            "build one there first."
        )
    check_catalog(bundle)
    return bundle


def imported_instances(bundle: dict[str, Any] | None, own: set[str]) -> set[str]:
    """Instances a build here keeps: those marked as imported, other than its own."""
    return {
        i["id"]
        for i in (bundle or {}).get("instances", [])
        if i.get("imported") and i["id"] not in own
    }


def remove_instance(
    local: Any,
    instance_id: str,
    user: str,
    app: str = "delvecat",
    collection: str = "delvecat_catalog",
) -> dict[str, Any]:
    """Publish this stack's catalog without an imported instance."""
    try:
        current = read_published(local, app, collection)
    except PublishError as exc:
        raise TransferError(str(exc)) from None
    if not current:
        raise TransferError("No catalog is published here.")
    inst = next((i for i in current["instances"] if i["id"] == instance_id), None)
    if inst is None:
        raise TransferError(f"No instance {instance_id} in this catalog.")
    if not inst.get("imported"):
        raise TransferError(
            f"{inst.get('name') or instance_id} was built here, not imported: build again instead."
        )
    rest = without_instances(current, {instance_id})
    if not rest["instances"]:
        raise TransferError("That is the only instance in the catalog: nothing would be left.")
    pointer = publish_bundle(
        rest, local, app, collection,
        extra={"publishedBy": user, "removedInstance": instance_id}, log=lambda _m: None,
    )  # fmt: skip
    return {
        "removed": instance_id,
        "before": len(current["entities"]),
        "after": len(rest["entities"]),
        "instances": [{"id": i["id"], "name": i.get("name") or i["id"]} for i in rest["instances"]],
        "generation": pointer.get("generation"),
    }
