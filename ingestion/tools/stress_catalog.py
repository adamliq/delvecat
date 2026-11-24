"""Make a synthetic catalog look like a troubled large estate, to measure the Health,
Findings and cleanup views at their worst: findings on most indexes, sourcetypes,
searches, forwarders, inputs and tokens; half the knowledge objects unused; daily
series; a 60-build trend; 3,000 resolved findings. Edits the catalog in place.

    cd ingestion && uv run delvecat-ingest synth --scale 1 --out ../web/.large --shard
    python3 tools/stress_catalog.py ../web/.large
"""

from __future__ import annotations

import hashlib
import json
import random
import sys
from pathlib import Path


def _load(path):
    return json.loads(Path(path).read_text())


def _dump(data, path):
    Path(path).write_text(json.dumps(data))


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


root = sys.argv[1]
random.seed(7)
m = _load(f"{root}/catalog.json")
CHECKS = {
    "index": ["freshness", "volume", "retentionBySize", "ingestDelay"],
    "sourcetype": ["freshness", "volume", "parsing", "ingestDelay"],
    "savedSearch": ["skipped", "failed", "runtime", "notRunning", "alertNoisy"],
    "correlationSearch": ["skipped", "notRunning", "alertNoisy"],
    "forwarder": ["silent"],
    "input": ["hecRejected", "hecErrors"],
    "authToken": ["tokenStale", "tokenNoExpiry", "tokenExpired"],
}
UNUSED = {"savedSearch", "dashboard", "macro", "lookup", "eventtype", "user", "index"}
GEN = m["generatedAt"]
nf = nu = 0
for sh in m["shards"]:
    if sh["kind"] != "entities":
        continue
    p = f"{root}/{sh['path']}"
    d = _load(p)
    ents = d if isinstance(d, list) else d["entities"]
    for e in ents:
        t = e["type"]
        if t in CHECKS and random.random() < 0.6:
            cs = random.sample(CHECKS[t], k=min(len(CHECKS[t]), random.choice([1, 1, 2, 3])))
            checks = [
                {
                    "check": c,
                    "status": random.choice(["warning", "warning", "critical"]),
                    "message": f"{c} problem on {e['name']}: details of the finding",
                    "since": random.choice([GEN, "2026-10-01T00:00:00Z"]),
                }
                for c in cs
            ]
            e["health"] = {
                "status": "critical"
                if any(c["status"] == "critical" for c in checks)
                else "warning",
                "checks": checks,
            }
            nf += len(checks)
            if t in ("savedSearch", "correlationSearch"):
                u = e.setdefault("usage", {})
                u.setdefault("scheduler", {"total": 100})["daily"] = {
                    "start": "2026-10-25",
                    "runs": [10] * 30,
                    "problems": [random.randint(0, 5) for _ in range(30)],
                }
                u["alertDaily"] = {
                    "start": "2026-10-25",
                    "counts": [random.randint(0, 60) for _ in range(30)],
                }
            if t in ("index", "sourcetype"):
                e.setdefault("properties", {}).setdefault("observed", {})["dailyEvents"] = {
                    "start": "2026-10-25",
                    "counts": [random.randint(0, 10**6) for _ in range(30)],
                }
        if t in UNUSED and random.random() < 0.5:
            u = e.setdefault("usage", {})
            u["unused"] = True
            u["reason"] = "Not used in the window"
            nu += 1
    _dump(d, p)
    # shard hashes: recompute
    sh["sha256"] = _sha(p)
m["healthHistory"] = [
    {
        "at": f"2026-09-{(i % 28) + 1:02d}T00:00:00Z",
        "critical": random.randint(3000, 5000),
        "warning": random.randint(8000, 12000),
        "findings": 20000,
        "unused": 15000,
        "documented": 9000,
        "described": 3000 + i * 20,
        "owned": 2000 + i * 30,
    }
    for i in range(59)
] + [
    {
        "at": GEN,
        "critical": 4000,
        "warning": 10000,
        "findings": nf,
        "unused": nu,
        "documented": 9000,
        "described": 4200,
        "owned": 3800,
    }
]
m["resolvedFindings"] = [
    {
        "id": f"x:index:gone{i}",
        "type": "index",
        "name": f"gone{i}",
        "check": "freshness",
        "status": "warning",
        "message": "stale",
        "how": "fixed",
    }
    for i in range(3000)
]
m.setdefault("ingestionReport", []).append(
    {"connector": "health", "status": "ok", "message": f"as of {GEN}", "counts": {}}
)
_dump(m, f"{root}/catalog.json")
print("findings", nf, "unused", nu)
