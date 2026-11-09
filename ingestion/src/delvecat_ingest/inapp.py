"""Building the catalog inside Splunk: what the DelveCat app's ``| delvecatbuild``
command runs, on the search head, with the session of the person who started it.

It reads the Splunk it runs on (and the products installed there), like
``delvecat-ingest build --url``. The catalog shows what that person can see.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any

from .bundle import assemble
from .connectors import db_connect, deployment_server, enterprise_security, splunk, stream
from .connectors.splunk import Options
from .governance import apply_governance
from .model import ExtractResult, merge_facts
from .redaction import load_profile, redact_bundle

PRODUCTS: dict[str, Callable[[Any, str], Any]] = {
    "deploymentServer": deployment_server.extract,
    "dbConnect": db_connect.extract,
    "stream": stream.extract,
    "enterpriseSecurity": enterprise_security.extract,
}
INSTANCE_ID = re.compile(r"^[A-Za-z0-9_-]+$")
# Every part a build can run: the Splunk platform extractors, then the products.
PARTS = [*splunk.EXTRACTORS, *PRODUCTS]
# Parts that need another one's results.
NEEDS = {"fields": "inventory"}


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
    options = Options(fields=fields, usage=usage, progress=say)
    result = (
        splunk.extract(transport, instance_id, options, platform) if platform else ExtractResult()
    )
    for name, extract in PRODUCTS.items():
        if name in chosen:
            say(f"products.{name}")
            result.extend(extract(transport, instance_id))

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

    say("assemble")
    bundle = assemble([instance], result, None, previous)
    say("governance")
    apply_governance(bundle)
    if redact == "internal":
        say("redaction")
        redact_bundle(bundle, load_profile("internal"))
    return bundle
