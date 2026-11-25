"""Knowledge objects whose owner no longer exists."""

from __future__ import annotations

import copy
from pathlib import Path

from delvecat_ingest.inapp import build_here
from delvecat_ingest.transport import FixtureTransport

FIXTURE = Path(__file__).parent / "fixtures" / "splunk-9.4-dev"
USERS = "/services/authentication/users"
SAVED = "/servicesNS/-/-/saved/searches"


class Gone(FixtureTransport):
    """jlee has left (no longer a user), and a scheduled search belongs to "ghost"."""

    def get(self, path, params=None):
        body = super().get(path, params)
        if path == USERS:
            body = copy.deepcopy(body)
            body["entry"] = [e for e in body["entry"] if e["name"] != "jlee"]
            body["paging"] = {**body.get("paging", {}), "total": len(body["entry"])}
        elif path == SAVED:
            body = copy.deepcopy(body)
            for e in body["entry"]:
                if e["name"] == "Web - Hourly Status Summary":
                    e["acl"]["owner"] = "ghost"
                    e["author"] = "ghost"
        return body


def _orphan(e):
    return next(
        (c for c in (e.get("health") or {}).get("checks", []) if c["check"] == "orphaned"), None
    )


def test_objects_of_a_removed_user_are_orphaned():
    bundle = build_here(Gone(FIXTURE), "acme")
    by_name = {(e["type"], e["name"]): e for e in bundle["entities"]}
    private = _orphan(by_name[("savedSearch", "Windows - Failed Logons by User")])
    assert private["status"] == "warning" and "jlee" in private["message"]
    assert "private" in private["message"]
    assert _orphan(by_name[("spl2Module", "web_errors")])["status"] == "warning"
    # Tokens have their own check (tokenNoOwner), not this one.
    assert not any(_orphan(e) for e in bundle["entities"] if e["type"] == "authToken")


def test_a_scheduled_search_of_a_removed_user_does_not_run():
    bundle = build_here(Gone(FIXTURE), "acme")
    s = next(e for e in bundle["entities"] if e["name"] == "Web - Hourly Status Summary")
    c = _orphan(s)
    assert c["status"] == "critical" and "does not run" in c["message"]


def test_nothing_is_orphaned_when_users_were_not_read():
    bundle = build_here(Gone(FIXTURE), "acme", parts={"savedSearches", "apps"})
    assert not any(_orphan(e) for e in bundle["entities"])
