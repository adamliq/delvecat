"""Enterprise Security metadata carried on saved searches (correlation searches / detections).

ES stores detections as saved searches with ``action.correlationsearch.*``,
``action.notable.*`` and ``action.risk.*`` keys; ESCU content adds
``action.escu.*``. Everything here reads those keys only.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ...splunk_rest import as_bool
from .common import split_list

_MITRE = re.compile(r"^T\d{4}(?:\.\d{3})?$")
# Alert actions that hand events to SOAR (App for SOAR Export, ES integrations).
_SOAR_ACTION = re.compile(r"phantom|soar|playbook", re.I)


def _json(value: Any) -> Any:
    if isinstance(value, str) and value.strip()[:1] in "[{":
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


def is_detection(c: dict[str, Any]) -> bool:
    return as_bool(c.get("action.correlationsearch.enabled", False)) or any(
        k.startswith("action.escu.") for k in c
    )


def detection_properties(c: dict[str, Any]) -> dict[str, Any]:
    ann = _json(c.get("action.correlationsearch.annotations")) or {}
    escu_map = _json(c.get("action.escu.mappings")) or {}
    if not isinstance(ann, dict):
        ann = {}
    if not isinstance(escu_map, dict):
        escu_map = {}

    def merged(*keys: str) -> list[str]:
        out: list[str] = []
        for source in (ann, escu_map):
            for k in keys:
                for v in source.get(k) or []:
                    if isinstance(v, str) and v not in out:
                        out.append(v)
        return out

    stories = merged("analytic_story")
    for s in _json(c.get("action.escu.analytic_story")) or []:
        if isinstance(s, str) and s not in stories:
            stories.append(s)
    risk = _json(c.get("action.risk.param._risk")) or []
    if isinstance(risk, dict):
        risk = [risk]
    if not risk and c.get("action.risk.param._risk_object"):
        risk = [
            {
                "risk_object_field": c.get("action.risk.param._risk_object"),
                "risk_object_type": c.get("action.risk.param._risk_object_type"),
                "risk_score": c.get("action.risk.param._risk_score"),
            }
        ]
    mitre = [t.upper() for t in merged("mitre_attack") if _MITRE.match(t.upper())]
    return {
        "detectionLabel": c.get("action.correlationsearch.label") or None,
        "mitreAttack": mitre,
        "killChainPhases": merged("kill_chain_phases"),
        "analyticStories": stories,
        "cis20": merged("cis20"),
        "nist": merged("nist"),
        "dataModels": [
            d for d in _json(c.get("action.escu.data_models")) or [] if isinstance(d, str)
        ],
        "securityDomain": c.get("action.notable.param.security_domain") or None,
        "severity": c.get("action.notable.param.severity") or None,
        "notableTitle": c.get("action.notable.param.rule_title") or None,
        "createsNotable": as_bool(c.get("action.notable", False)),
        "createsRisk": as_bool(c.get("action.risk", False)),
        "riskObjects": [
            {
                "field": r.get("risk_object_field"),
                "type": r.get("risk_object_type"),
                "score": r.get("risk_score"),
            }
            for r in risk
            if isinstance(r, dict)
        ],
        "recommendedActions": split_list(c.get("action.notable.param.recommended_actions")),
    }


def soar_targets(c: dict[str, Any], actions: list[str]) -> tuple[list[str], list[str]]:
    """(SOAR labels, SOAR playbooks) named by enabled SOAR-bound alert actions."""
    labels: list[str] = []
    playbooks: list[str] = []
    for action in actions:
        if not _SOAR_ACTION.search(action):
            continue
        prefix = f"action.{action}.param."
        for k, v in c.items():
            if not k.startswith(prefix) or not v:
                continue
            param = k[len(prefix) :].lower()
            if param.endswith("label"):
                labels.extend(x for x in split_list(v) if x not in labels)
            elif "playbook" in param:
                playbooks.extend(x for x in split_list(v) if x not in playbooks)
    return labels, playbooks
