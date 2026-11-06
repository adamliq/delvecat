"""Compile MITRE ATT&CK STIX data into web/public/reference/attack-enterprise.json.

    BASE=https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master
    curl -sSLo /tmp/attack/enterprise-attack.json $BASE/enterprise-attack/enterprise-attack.json
    python3 -I tools/compile_attack.py /tmp/attack/enterprise-attack.json \\
        ../web/public/reference/attack-enterprise.json
"""

import json
import sys

src, dst = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as fh:
    objs = json.load(fh)["objects"]


def ext_id(o):
    for r in o.get("external_references", []):
        if r.get("source_name") == "mitre-attack":
            return r.get("external_id")


live = [o for o in objs if not o.get("revoked") and not o.get("x_mitre_deprecated")]
matrix = next(o for o in live if o["type"] == "x-mitre-matrix")
tactic_by_ref = {o["id"]: o for o in live if o["type"] == "x-mitre-tactic"}
tactics = [
    {
        "id": ext_id(tactic_by_ref[r]),
        "shortname": tactic_by_ref[r]["x_mitre_shortname"],
        "name": tactic_by_ref[r]["name"],
    }
    for r in matrix["tactic_refs"]
]
techniques = []
for o in live:
    if o["type"] != "attack-pattern":
        continue
    tid = ext_id(o)
    if not tid:
        continue
    techniques.append(
        {
            "id": tid,
            "name": o["name"],
            "tactics": [
                k["phase_name"]
                for k in o.get("kill_chain_phases", [])
                if k.get("kill_chain_name") == "mitre-attack"
            ],
            **({"parent": tid.split(".")[0]} if o.get("x_mitre_is_subtechnique") else {}),
        }
    )
techniques.sort(key=lambda t: t["id"])
coll = next((o for o in live if o["type"] == "x-mitre-collection"), {})
out = {
    "source": "MITRE ATT&CK Enterprise (attack-stix-data)",
    "version": coll.get("x_mitre_version"),
    "attribution": "© The MITRE Corporation. This work is reproduced and distributed with the "
    "permission of The MITRE Corporation. https://attack.mitre.org",
    "tactics": tactics,
    "techniques": techniques,
}
with open(dst, "w", encoding="utf-8") as fh:
    json.dump(out, fh, separators=(",", ":"), ensure_ascii=False)
print(
    out["version"],
    len(tactics),
    "tactics,",
    len(techniques),
    "techniques,",
    sum(1 for t in techniques if "parent" not in t),
    "top-level",
)
