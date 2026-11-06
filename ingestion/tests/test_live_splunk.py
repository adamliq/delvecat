"""Optional: run against a live Splunk seeded with deploy/seed_dev_splunk.py.

DELVECAT_LIVE_URL=https://localhost:8089 DELVECAT_SPLUNK_TOKEN=... uv run pytest -k live
"""

import os
from pathlib import Path

import pytest

from delvecat_ingest.bundle import assemble, validate
from delvecat_ingest.connectors import (
    db_connect,
    deployment_server,
    enterprise_security,
    splunk,
    stream,
)
from delvecat_ingest.transport import HttpTransport

from .test_splunk_connector import seed_ids

URL = os.environ.get("DELVECAT_LIVE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="DELVECAT_LIVE_URL not set")


def test_live_instance_is_fully_catalogued():
    transport = HttpTransport(
        URL,
        os.environ["DELVECAT_SPLUNK_TOKEN"],
        verify=os.environ.get("DELVECAT_LIVE_VERIFY", "0") == "1",
    )
    result = splunk.extract(transport, "live", splunk.Options(fields=True, max_field_sourcetypes=5))
    apps = Path(__file__).parents[2] / "deploy" / "deployment-apps"
    result.extend(deployment_server.extract(transport, "live", apps))
    result.extend(db_connect.extract(transport, "live"))
    result.extend(stream.extract(transport, "live"))
    result.extend(enterprise_security.extract(transport, "live"))
    bundle = assemble([{"id": "live", "name": "live", "kind": "splunkEnterprise"}], result)
    assert validate(bundle) == []
    failed = [r for r in bundle["ingestionReport"] if r["status"] == "failed"]
    assert failed == []
    ids = {e["id"] for e in bundle["entities"]}
    assert [i for i in seed_ids("live") if i not in ids] == []
    assert any(e["type"] == "field" for e in bundle["entities"])


def test_local_macro_expansion_matches_splunks_parser():
    """For every seeded saved search, analyzing our macro expansion must find the same
    references as analyzing the expansion done by Splunk's own /search/parser."""
    from urllib.parse import quote

    from delvecat_ingest.lineage import MacroLibrary
    from delvecat_ingest.spl import analyze

    transport = HttpTransport(
        URL,
        os.environ["DELVECAT_SPLUNK_TOKEN"],
        verify=os.environ.get("DELVECAT_LIVE_VERIFY", "0") == "1",
    )
    result = splunk.extract(transport, "live", only={"macros", "savedSearches"})
    macros = MacroLibrary(result.entities)
    apps = {"acme_web", "acme_secops", "TA-acme-firewall"}
    checked = 0
    for e in result.entities:
        if e["type"] != "savedSearch" or e.get("app") not in apps:
            continue
        spl = e["properties"]["search"]
        owner = e["owner"] if e.get("sharing") == "user" else "nobody"
        resp = transport.request(
            "POST",
            f"/servicesNS/{quote(owner)}/{quote(e['app'])}/search/parser",
            data={
                "q": spl if spl.lstrip().startswith("|") else f"search {spl}",
                "parse_only": "t",
                "output_mode": "json",
            },
        )
        if resp.status_code != 200:
            continue  # Splunk cannot parse it either (e.g. a macro that is not visible)
        commands = resp.json()["commands"]
        splunk_spl = " | ".join(f"{c['command']} {c.get('rawargs', '')}" for c in commands)
        if commands and commands[0]["command"] != "search":
            splunk_spl = "| " + splunk_spl  # a generating command such as tstats
        ours = analyze(spl, macros.resolver(e["app"], e.get("owner")))
        theirs = analyze(splunk_spl)
        strip = {r for r in ours.refs if r[1] == "macro"}  # Splunk's text has no macros left
        assert ours.refs - strip == theirs.refs, e["name"]
        checked += 1
    assert checked >= 8
