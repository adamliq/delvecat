"""Redaction profiles: prepare a bundle for a wider audience (e.g. public GitHub Pages).

Profiles say what to do with each kind of personal or infrastructure detail:

- ``realNames``: user display names (``drop`` / ``keep``)
- ``users``: user names, object owners (``pseudonymize`` / ``keep``)
- ``hosts``: hosts, forwarders, deployment clients, Stream forwarders, server
  names (``pseudonymize`` / ``keep``)
- ``sources``: source paths (``pseudonymize`` / ``keep``)
- ``ips``: IPv4/IPv6 addresses anywhere in the bundle (``mask`` / ``keep``)
- ``urls``: internal URLs such as instance web URLs, threat-intel feeds, DB hosts
  (``drop`` / ``keep``); curated annotation links are kept
- ``emails``: addresses email alert actions send to and from (``keep`` /
  ``domain``: only the part after ``@`` / ``drop``); ``$tokens$`` are kept

Pseudonyms are keyed hashes (HMAC-SHA256). With a stable secret salt
(``DELVECAT_REDACT_SALT``) the same user gets the same pseudonym in every build;
without one a random salt is used and pseudonyms change each run.

Known limits: names inside SPL text and free-text descriptions are not rewritten
(IP addresses are, with ``ips: mask``).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

import yaml

HOST_TYPES = ("host", "forwarder", "deploymentClient", "streamForwarder")
HOST_PROPS = ("hostname", "dns", "host", "serverName")
URL_PROPS = ("url", "webUrl", "linkUri")
USER_PROPS = ("creator", "createdBy", "updatedBy")
DB_HOST_PROPS = ("host", "port")
IPV4 = re.compile(r"\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b")
IPV6 = re.compile(r"\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b")


@dataclass
class Profile:
    name: str
    realNames: str = "keep"  # noqa: N815 (profile keys mirror the YAML)
    users: str = "keep"
    hosts: str = "keep"
    sources: str = "keep"
    ips: str = "keep"
    urls: str = "keep"
    emails: str = "keep"


PROFILES = {
    # The part of an address before "@" is usually a person's name.
    "internal": Profile("internal", realNames="drop", emails="domain"),
    "public": Profile(
        "public",
        realNames="drop",
        users="pseudonymize",
        hosts="pseudonymize",
        sources="pseudonymize",
        ips="mask",
        urls="drop",
        emails="drop",
    ),
}
ALLOWED = {
    "realNames": {"keep", "drop"},
    "users": {"keep", "pseudonymize"},
    "hosts": {"keep", "pseudonymize"},
    "sources": {"keep", "pseudonymize"},
    "ips": {"keep", "mask"},
    "urls": {"keep", "drop"},
    "emails": {"keep", "domain", "drop"},
}


def load_profile(name: str | None = None, file: Path | None = None) -> Profile:
    if file:
        data = yaml.safe_load(file.read_text(encoding="utf-8")) or {}
        base = PROFILES.get(data.pop("extends", "") or "", Profile(file.stem))
        values = {f.name: getattr(base, f.name) for f in fields(Profile)}
        values["name"] = data.pop("name", file.stem)
        for key, value in data.items():
            if key not in ALLOWED or value not in ALLOWED[key]:
                raise ValueError(f"{file}: invalid setting {key}: {value!r}")
            values[key] = value
        return Profile(**values)
    if name not in PROFILES:
        raise ValueError(f"unknown redaction profile {name!r} (choose {', '.join(PROFILES)})")
    return PROFILES[name]


class _Pseudonyms:
    def __init__(self, salt: bytes):
        self.salt = salt
        self.map: dict[tuple[str, str], str] = {}

    def __call__(self, kind: str, value: str) -> str:
        key = (kind, value)
        if key not in self.map:
            digest = hmac.new(self.salt, f"{kind}:{value}".encode(), hashlib.sha256).hexdigest()
            self.map[key] = f"{kind}-{digest[:8]}"
        return self.map[key]


def _mask_ips(value: Any) -> Any:
    if isinstance(value, str):
        return IPV6.sub("<ip>", IPV4.sub("<ip>", value))
    if isinstance(value, list):
        return [_mask_ips(v) for v in value]
    if isinstance(value, dict):  # ids are rewritten consistently elsewhere, never masked
        return {k: (v if k == "id" else _mask_ips(v)) for k, v in value.items()}
    return value


def _redact_emails(props: dict[str, Any], mode: str) -> int:
    """Email alert recipients and senders: keep only the domain, or drop them."""
    n = 0

    def domain(address: str) -> str:
        if address.startswith("$") and address.endswith("$"):
            return address  # filled in when the alert fires: not an address yet
        return "*@" + address.rsplit("@", 1)[1] if "@" in address else address

    for key in ("alertRecipients", "defaultRecipients"):
        if not (rec := props.get(key)):
            continue
        n += sum(len(v) if isinstance(v, list) else 1 for v in rec.values())
        if mode == "drop":
            props.pop(key)
        else:
            props[key] = {
                k: (list(dict.fromkeys(domain(a) for a in v)) if isinstance(v, list) else domain(v))
                for k, v in rec.items()
            }
    if props.get("sender"):
        n += 1
        if mode == "drop":
            props.pop("sender")
        else:
            props["sender"] = domain(props["sender"])
    return n


def _renamed(type_: str, name: str, profile: Profile, rename: Any) -> str:
    """The name an object of this type gets under the profile (for lists that name
    objects outside the entities: removed objects, resolved findings)."""
    if type_ == "user" and profile.users == "pseudonymize":
        return str(rename("user", name))
    if type_ in HOST_TYPES and profile.hosts == "pseudonymize":
        return str(rename("host", name))
    if type_ == "source" and profile.sources == "pseudonymize":
        return str(rename("source", name))
    return name


def redact_bundle(
    bundle: dict[str, Any], profile: Profile, salt: str | None = None
) -> dict[str, Any]:
    """Redact ``bundle`` in place according to ``profile``; return counts of what changed."""
    salt = salt if salt is not None else os.environ.get("DELVECAT_REDACT_SALT")
    stable = bool(salt)
    pseudo = _Pseudonyms((salt or secrets.token_hex(16)).encode())
    entities = bundle["entities"]
    counts = {"users": 0, "hosts": 0, "sources": 0, "realNames": 0, "urls": 0, "emails": 0}

    users = {e["name"] for e in entities if e["type"] == "user"} | {
        e["owner"] for e in entities if e.get("owner") and e["owner"] != "nobody"
    }
    hosts = {e["name"] for e in entities if e["type"] in HOST_TYPES}
    for e in entities:
        props = e.get("properties") or {}
        hosts.update(str(props[k]) for k in ("hostname", "dns") if props.get(k))

    def rename(kind: str, value: str) -> str:
        return pseudo(kind, value)

    id_map: dict[str, str] = {}
    for e in entities:
        old_id = e["id"]
        instance, type_, rest = old_id.split(":", 2)
        new_rest = rest
        if type_ == "user" and profile.users == "pseudonymize":
            new_rest = rename("user", rest)
        elif type_ in HOST_TYPES and profile.hosts == "pseudonymize":
            new_rest = rename("host", rest)
        elif type_ == "source" and profile.sources == "pseudonymize":
            new_rest = rename("source", rest)
        elif profile.users == "pseudonymize" and "/@" in rest:  # private knowledge object
            app, _, tail = rest.partition("/@")
            owner, _, name = tail.partition("/")
            new_rest = f"{app}/@{rename('user', owner)}/{name}"
        if new_rest != rest:
            id_map[old_id] = f"{instance}:{type_}:{new_rest}"

    for e in entities:
        props = e.get("properties") or {}
        if e["type"] == "user":
            if profile.realNames == "drop" and e.get("displayName"):
                e.pop("displayName")
                counts["realNames"] += 1
            if profile.users == "pseudonymize":
                e["name"] = rename("user", e["name"])
                counts["users"] += 1
        if e["type"] in HOST_TYPES and profile.hosts == "pseudonymize":
            e["name"] = rename("host", e["name"])
            e.pop("displayName", None)
            counts["hosts"] += 1
        if e["type"] == "source" and profile.sources == "pseudonymize":
            e["name"] = rename("source", e["name"])
            counts["sources"] += 1
        if profile.users == "pseudonymize" and e.get("owner") in users:
            e["owner"] = rename("user", e["owner"])
        if profile.users == "pseudonymize":
            # Who created or changed an object (response plans, catalog objects...).
            for k in USER_PROPS:
                if props.get(k) and props[k] not in ("nobody", "system"):
                    props[k] = rename("user", str(props[k]))
        if profile.users == "pseudonymize" and e["type"] == "authToken":
            for k in ("user", "issuedBy"):
                if props.get(k):
                    props[k] = rename("user", str(props[k]))
        if profile.hosts == "pseudonymize":
            for k in HOST_PROPS:
                if props.get(k) and str(props[k]) in hosts:
                    props[k] = rename("host", str(props[k]))
        if e["type"] in ("spl2Connection", "spl2Dataset") and profile.urls == "drop":
            # Where external data is, and the tenant it is in, identify the customer.
            for k in (
                "host",
                "azureTenantId",
                "storageAccount",
                "container",
                "directory",
                "bucket",
                "database",
                "warehouse",
            ):
                if props.pop(k, None):
                    counts["urls"] += 1
        if (
            e["type"] == "spl2Connection"
            and profile.users == "pseudonymize"
            and props.get("account")
        ):
            props["account"] = rename("user", str(props["account"]))
        if e["type"] == "federatedProvider":
            # Where the remote data is and the account used to read it.
            if profile.urls == "drop":
                for k in ("hostPort", "awsAccountId", "s3PathsAllowed"):
                    if props.pop(k, None):
                        counts["urls"] += 1
            if profile.users == "pseudonymize" and props.get("serviceAccount"):
                props["serviceAccount"] = rename("user", str(props["serviceAccount"]))
        if profile.urls == "drop" and e["type"] == "input" and (ms := props.get("microsoft")):
            # Tenant, subscription and workspace ids identify the customer.
            for k in ("subscription_id", "tenant_id", "workspace_id"):
                if (ms.get("settings") or {}).pop(k, None):
                    counts["urls"] += 1
        if profile.urls == "drop" and e["type"] == "outputGroup":
            # Where data is sent: receiving hosts, HEC URI, cluster manager, S3 paths.
            for k in ("servers", "uri", "clusterManager", "path", "bucket", "storageAccount"):
                if props.pop(k, None):
                    counts["urls"] += 1
        if profile.urls == "drop" and e["type"] == "addOnAccount":
            for k in ("tenantId", "clientId", "tenantSubdomain"):
                if props.pop(k, None):
                    counts["urls"] += 1
        if profile.urls == "drop" and e["type"] == "index":
            # Object-store locations (SmartStore remote path, Splunk Cloud Self Storage
            # bucket) name the customer's cloud account.
            if props.pop("remotePath", None):
                counts["urls"] += 1
            for tier in (props.get("storage") or {}).get("tiers") or []:
                if "://" in str(tier.get("path") or "") or tier.get("remote") or tier.get("bucket"):
                    for k in ("path", "bucket", "storageAccount"):
                        if tier.pop(k, None):
                            counts["urls"] += 1
        if profile.urls == "drop":
            for k in URL_PROPS:
                if props.pop(k, None) is not None:
                    counts["urls"] += 1
            if e["type"] == "dbConnection":
                for k in DB_HOST_PROPS:
                    props.pop(k, None)
            if e["type"] == "deploymentClient":
                props.pop("dns", None)
        if profile.ips == "mask":
            props.pop("ip", None)
        if profile.emails != "keep":
            counts["emails"] += _redact_emails(props, profile.emails)
        if e["id"] in id_map:
            e["id"] = id_map[e["id"]]

    for edge in bundle["edges"]:
        edge["from"] = id_map.get(edge["from"], edge["from"])
        edge["to"] = id_map.get(edge["to"], edge["to"])
    if ch := bundle.get("changes"):
        for k in ("added", "modified"):
            ch[k] = [id_map.get(i, i) for i in ch[k]]
        for r in ch["removed"]:
            r["id"] = id_map.get(r["id"], r["id"])
            r["name"] = _renamed(r["type"], r["name"], profile, rename)
    for r in bundle.get("resolvedFindings", []):
        r["id"] = id_map.get(r["id"], r["id"])
        r["name"] = _renamed(r["type"], r["name"], profile, rename)

    def remap_ids(value: Any) -> Any:
        """Ids embedded in derived data (governance, annotations sources stay as-is)."""
        if isinstance(value, str):
            return id_map.get(value, value)
        if isinstance(value, list):
            return [remap_ids(v) for v in value]
        if isinstance(value, dict):
            return {k: remap_ids(v) for k, v in value.items()}
        return value

    for e in entities:
        if "governance" in e:
            e["governance"] = remap_ids(e["governance"])

    for inst in bundle.get("instances", []):
        if profile.urls == "drop":
            inst.pop("webUrl", None)
        props = inst.get("properties") or {}
        if profile.hosts == "pseudonymize" and props.get("serverName"):
            props["serverName"] = rename("host", str(props["serverName"]))

    if profile.ips == "mask":
        bundle["entities"] = _mask_ips(bundle["entities"])
        if "resolvedFindings" in bundle:
            bundle["resolvedFindings"] = _mask_ips(bundle["resolvedFindings"])
        bundle["instances"] = _mask_ips(bundle["instances"])

    # Kept only so `merge` can link instances; they hold raw names, and a redacted bundle
    # cannot be merged anyway.
    bundle.pop("references", None)
    bundle["redaction"] = {"profile": profile.name, "stablePseudonyms": stable, "counts": counts}
    return counts
