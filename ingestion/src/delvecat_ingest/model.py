"""Entity / edge construction helpers shared by connectors."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .redact import redact

# Types whose FQN is not scoped by app/owner.
GLOBAL_TYPES = frozenset(
    {
        "app",
        "index",
        "sourcetype",
        "source",
        "host",
        "role",
        "user",
        "tag",
        "forwarder",
        "field",
        # Product objects whose names are unique within their product on an instance.
        "serverClass",
        "deploymentApp",
        "deploymentClient",
        "dbConnection",
        "dbIdentity",
        "dbInput",
        "dbOutput",
        "dbLookup",
        "externalTable",
        "streamDefinition",
        "streamGroup",
        "streamForwarder",
        "adaptiveResponseAction",
        "analyticStory",
        "threatIntelSource",
        "assetIdentitySource",
        "soarPlaybook",
        "soarCustomFunction",
        "soarApp",
        "soarAsset",
        "soarLabel",
        "uebaDataSource",
        "uebaModel",
        "uebaAnomalyType",
        "uebaThreatRule",
        "uebaOutputConnector",
    }
)


def fqn(
    instance: str,
    type_: str,
    name: str,
    app: str | None = None,
    owner: str | None = None,
    sharing: str | None = None,
) -> str:
    """Fully qualified name, mirroring how Splunk itself makes names unique.

    - Global objects (indexes, roles, apps): ``inst:type:name``
    - Shared knowledge objects (sharing app/global/system): ``inst:type:app/name``
    - Private knowledge objects (sharing user): ``inst:type:app/@owner/name``

    The owner of a shared object is only metadata (it can be reassigned), so it is
    not part of the identity.
    """
    if app is None:
        return f"{instance}:{type_}:{name}"
    if sharing == "user" and owner:
        return f"{instance}:{type_}:{app}/@{owner}/{name}"
    return f"{instance}:{type_}:{app}/{name}"


def entity(
    *,
    id: str,
    type: str,
    name: str,
    instance: str,
    product: str = "splunk",
    properties: dict[str, Any] | None = None,
    observed: dict[str, Any] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """Build an entity dict.

    ``observed`` holds measurements that change on every run (event counts,
    sizes, last-seen times). They are stored under ``properties.observed`` and
    excluded from change detection.
    """
    out: dict[str, Any] = {
        "id": id,
        "type": type,
        "name": name,
        "product": product,
        "instance": instance,
    }
    out.update({k: v for k, v in extra.items() if v is not None and v != "" and v != []})
    # Splunk reports the Unix epoch for config objects with no real modification time.
    if str(out.get("updatedAt", "")).startswith("1970-01-01"):
        del out["updatedAt"]
    props = {k: v for k, v in (properties or {}).items() if v is not None and v != ""}
    obs = {k: v for k, v in (observed or {}).items() if v is not None and v != ""}
    if obs:
        props["observed"] = obs
    if props:
        out["properties"] = redact(props)
    return out


def edge(from_: str, to: str, type_: str, origin: str = "config") -> dict[str, Any]:
    return {"from": from_, "to": to, "type": type_, "origin": origin}


@dataclass(frozen=True)
class Target:
    """An entity referenced by name, resolved once all entities are known."""

    type: str
    name: str
    app: str | None = None  # preferred app scope for knowledge objects
    pattern: bool = False  # name is a Splunk wildcard pattern (e.g. "web*")
    # Only match objects Splunk would let a search in ``app`` see (same app or shared
    # globally; private objects only for their owner). Used for SPL references.
    visible_only: bool = False
    owner: str | None = None


@dataclass(frozen=True)
class Ref:
    """A pending edge between a known entity id and a :class:`Target`."""

    known: str
    target: Target
    edge_type: str
    known_is_from: bool = True
    origin: str = "config"


@dataclass
class ExtractResult:
    entities: list[dict[str, Any]] = field(default_factory=list)
    edges: list[dict[str, Any]] = field(default_factory=list)
    refs: list[Ref] = field(default_factory=list)
    reports: list[dict[str, Any]] = field(default_factory=list)
    instance_facts: dict[str, Any] = field(default_factory=dict)

    def extend(self, other: ExtractResult) -> None:
        self.entities.extend(other.entities)
        self.edges.extend(other.edges)
        self.refs.extend(other.refs)
        self.reports.extend(other.reports)
        merge_facts(self.instance_facts, other.instance_facts)


def merge_facts(into: dict[str, Any], new: dict[str, Any]) -> None:
    """Merge instance facts; nested ``properties`` dicts are combined, not replaced."""
    for k, v in new.items():
        if k == "properties" and isinstance(into.get(k), dict):
            into[k].update(v)
        elif v not in (None, "", []):
            into[k] = v
