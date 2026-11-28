"""Building the catalog inside Splunk: what the Licoryx Delvecat app's ``| delvecatbuild``
command runs, on the search head, with the session of the person who started it.

It reads the Splunk it runs on (and the products installed there), like
``delvecat-ingest build --url``. The catalog shows what that person can see.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from .bundle import assemble
from .connectors import (
    db_connect,
    deployment_server,
    enterprise_security,
    splunk,
    splunkbase,
    stream,
)
from .connectors.splunk import Options, data
from .governance import apply_governance
from .model import ExtractResult, merge_facts
from .parser_assist import parser_assist
from .redaction import load_profile, redact_bundle

PRODUCTS: dict[str, Callable[[Any, str], Any]] = {
    "deploymentServer": deployment_server.extract,
    "dbConnect": db_connect.extract,
    "stream": stream.extract,
    "enterpriseSecurity": enterprise_security.extract,
    "splunkbase": splunkbase.extract,
}
INSTANCE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
# Every part a build can run: the Splunk platform extractors, then the products.
PARTS = [*splunk.EXTRACTORS, *PRODUCTS]
# Parts that need another one's results.
NEEDS = {"fields": "inventory", "indexTimeRules": "transforms", "capabilities": "roles"}


def resolve_parts(parts: set[str] | None) -> set[str]:
    """The parts to run: all of them when none are named, plus what the named ones need."""
    if parts is None:
        return set(PARTS)
    if unknown := parts - set(PARTS):
        raise ValueError(f"unknown part(s): {', '.join(sorted(unknown))}")
    return parts | {NEEDS[p] for p in parts if p in NEEDS}


def default_instance_id(transport: Any) -> str:
    """This Splunk's server name, made into an instance id."""
    try:
        name = transport.get("/services/server/info")["entry"][0]["content"].get("serverName")
    except Exception:  # noqa: BLE001 - any failure falls back to a fixed id
        name = None
    return re.sub(r"[^A-Za-z0-9_-]+", "-", str(name or "splunk")).strip("-") or "splunk"


# Memory a build needs from here on, per object (measured: 1.56 GB for 301,405 objects
# and 2 million relationships in Splunk 10.4's Python, building and publishing).
BYTES_PER_OBJECT = 5300


class NotEnoughMemory(RuntimeError):
    pass


def memory_available() -> int | None:
    """Bytes this process can still use: the machine's available memory, or the
    container's limit if lower. None where it cannot be told (not Linux)."""
    free = None
    try:
        with open("/proc/meminfo", encoding="ascii") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    free = int(line.split()[1]) * 1024
                    break
    except (OSError, ValueError):
        return None
    try:  # cgroup v2 limit (Splunk in a container)
        with open("/sys/fs/cgroup/memory.max", encoding="ascii") as f:
            limit = f.read().strip()
        with open("/sys/fs/cgroup/memory.current", encoding="ascii") as f:
            used = int(f.read().strip())
        if limit != "max" and free is not None:
            free = min(free, int(limit) - used)
    except (OSError, ValueError):
        pass
    return free


def check_memory(objects: int, available: int | None = None) -> None:
    """Stop before the memory-heavy part of a build when the search head cannot hold it,
    with a message saying what to do, instead of being killed half way."""
    need = objects * BYTES_PER_OBJECT
    free = memory_available() if available is None else available
    if free is None or need < 256 * 1024 * 1024 or free >= need:
        return
    gb = 1024**3
    raise NotEnoughMemory(
        f"Not enough free memory on this search head to build a catalog of {objects:,} objects: "
        f"it needs about {need / gb:.1f} GB, and {max(free, 0) / gb:.1f} GB is available. Build "
        "fewer parts, build when the search head is less busy, or build outside Splunk with "
        "delvecat-ingest and publish the result."
    )


def build_here(
    transport: Any,
    instance_id: str | None = None,
    instance_name: str | None = None,
    web_url: str | None = None,
    fields: bool = False,
    usage: bool = True,
    redact: str | None = None,
    previous: dict[str, Any] | None = None,
    progress: Callable[[str], None] | None = None,
    parts: set[str] | None = None,
    field_indexes: str | None = None,
) -> dict[str, Any]:
    """Extract this Splunk into a catalog bundle (not written anywhere).

    ``parts`` names the parts to run (see PARTS); None runs them all, with field
    discovery and usage as ``fields`` and ``usage`` say."""
    say = progress or (lambda _: None)
    instance_id = instance_id or default_instance_id(transport)
    if not INSTANCE_ID.match(instance_id):
        raise ValueError(f"invalid instance id {instance_id!r} (letters, digits, - and _)")
    if redact not in (None, "none", "internal"):
        # public needs a secret salt for stable pseudonyms, which the app does not hold.
        raise ValueError("redact must be none or internal here (build public catalogs outside)")

    if parts is not None:
        chosen = resolve_parts(parts)
        fields, usage = "fields" in chosen, True  # the chosen parts say it all
    else:
        chosen = set(PARTS)
    platform = {p for p in chosen if p in splunk.EXTRACTORS}
    options = Options(
        fields=fields,
        usage=usage,
        progress=say,
        field_indexes=data.parse_index_list(field_indexes),  # field discovery only there
    )
    result = (
        splunk.extract(transport, instance_id, options, platform) if platform else ExtractResult()
    )
    for name, extract in PRODUCTS.items():
        if name in chosen:
            say(f"products.{name}")
            result.extend(extract(transport, instance_id))
    if platform and options.parser_assist:
        say("asking Splunk to parse searches the analyser cannot follow")
        result.reports.append(
            {"connector": "splunk.parserAssist", "status": "ok",
             "counts": parser_assist(transport, result.entities, options.parser_assist)}
        )  # fmt: skip

    instance: dict[str, Any] = {
        "id": instance_id,
        "name": instance_name or instance_id,
        "kind": "splunkEnterprise",
    }
    merge_facts(instance, result.instance_facts)
    if web_url:
        instance["webUrl"] = web_url
    if isinstance(instance.get("properties"), dict):
        instance["properties"] = {k: v for k, v in instance["properties"].items() if v is not None}

    check_memory(len(result.entities))
    say("assemble")
    bundle = assemble([instance], result, None, previous)
    say("governance")
    apply_governance(bundle)
    if redact == "internal":
        say("redaction")
        redact_bundle(bundle, load_profile("internal"))
    return bundle
