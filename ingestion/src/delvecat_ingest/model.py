"""Entity / edge construction helpers shared by connectors."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .redact import redact


def fqn(
    instance: str, type_: str, name: str, app: str | None = None, owner: str | None = None
) -> str:
    """Fully qualified name.

    Knowledge objects are scoped by app and owner: ``inst:type:app/owner/name``.
    Global objects (indexes, roles, apps): ``inst:type:name``.
    """
    if app is None:
        return f"{instance}:{type_}:{name}"
    return f"{instance}:{type_}:{app}/{owner or 'nobody'}/{name}"


def entity(
    *,
    id: str,
    type: str,
    name: str,
    instance: str,
    product: str = "splunk",
    properties: dict[str, Any] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": id,
        "type": type,
        "name": name,
        "product": product,
        "instance": instance,
    }
    out.update({k: v for k, v in extra.items() if v is not None and v != ""})
    if properties:
        out["properties"] = redact({k: v for k, v in properties.items() if v is not None})
    return out


@dataclass
class ExtractResult:
    entities: list[dict[str, Any]] = field(default_factory=list)
    edges: list[dict[str, Any]] = field(default_factory=list)
    reports: list[dict[str, Any]] = field(default_factory=list)

    def extend(self, other: ExtractResult) -> None:
        self.entities.extend(other.entities)
        self.edges.extend(other.edges)
        self.reports.extend(other.reports)
