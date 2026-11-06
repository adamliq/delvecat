"""Connect machines seen by different products to the ``host`` values in the data.

A deployment client, a forwarder seen by the indexers, and a Stream forwarder
are the same machine as the ``host`` its events carry (Splunk's default). This
step adds ``<machine> feeds host`` edges by hostname, which lets lineage answer
"which forwarders send data into index X" through ``host feeds index``.
Matching is case-insensitive and accepts a short name against an FQDN.
"""

from __future__ import annotations

from typing import Any

MACHINE_TYPES = ("deploymentClient", "forwarder", "streamForwarder")


def _keys(name: str) -> set[str]:
    n = name.strip().lower()
    return {n, n.split(".")[0]} if n else set()


def link_hosts(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    hosts: dict[str, list[dict[str, Any]]] = {}
    for e in entities:
        if e["type"] == "host":
            for k in _keys(e["name"]):
                hosts.setdefault(k, []).append(e)
    edges, seen = [], set()
    for m in entities:
        if m["type"] not in MACHINE_TYPES:
            continue
        hostname = (m.get("properties") or {}).get("hostname") or m["name"]
        matches = hosts.get(hostname.lower()) or hosts.get(hostname.lower().split(".")[0]) or []
        for h in matches:
            key = (m["id"], h["id"])
            if key not in seen:
                seen.add(key)
                edges.append(
                    {"from": m["id"], "to": h["id"], "type": "feeds", "origin": "connector"}
                )
    return edges
