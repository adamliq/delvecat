"""Trim a recorded fixture directory to the objects of selected apps.

Instance-wide endpoints (server info, apps, indexes, users, roles, searches)
are kept whole; app-scoped collections keep only entries from --apps.

    uv run python tools/slim_fixtures.py tests/fixtures/splunk-9.4-dev \\
        --apps acme_web,acme_secops,TA-acme-firewall,splunk_httpinput
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

KEEP_WHOLE = (
    "services/server/info",
    "services/apps/local",
    "services/data/indexes",
    "services/deployment/server/serverclasses",
    "services/deployment/server/applications",
    "services/deployment/server/clients",
    "servicesNS/nobody/system/configs/conf-serverclass",
    "services/authentication/users",
    "services/authorization/roles",
)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("root", type=Path)
    ap.add_argument("--apps", required=True)
    args = ap.parse_args()
    apps = set(args.apps.split(","))
    for file in sorted(args.root.rglob("*.json")):
        rel = file.relative_to(args.root).with_suffix("").as_posix()
        if rel.startswith("__") or rel in KEEP_WHOLE:
            continue
        body = json.loads(file.read_text())
        if "entry" not in body:
            continue
        before = len(body["entry"])
        body["entry"] = [e for e in body["entry"] if (e.get("acl") or {}).get("app") in apps]
        body["paging"] = {"total": len(body["entry"]), "offset": 0}
        file.write_text(json.dumps(body, indent=1, sort_keys=True) + "\n")
        print(f"{rel}: {before} -> {len(body['entry'])}")


if __name__ == "__main__":
    main()
