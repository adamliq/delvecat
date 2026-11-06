"""Optional: run against a live Splunk seeded with deploy/seed_dev_splunk.py.

DELVECAT_LIVE_URL=https://localhost:8089 DELVECAT_SPLUNK_TOKEN=... uv run pytest -k live
"""

import os

import pytest

from delvecat_ingest.bundle import assemble, validate
from delvecat_ingest.connectors import splunk
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
    bundle = assemble([{"id": "live", "name": "live", "kind": "splunkEnterprise"}], result)
    assert validate(bundle) == []
    failed = [r for r in bundle["ingestionReport"] if r["status"] == "failed"]
    assert failed == []
    ids = {e["id"] for e in bundle["entities"]}
    assert [i for i in seed_ids("live") if i not in ids] == []
    assert any(e["type"] == "field" for e in bundle["entities"])
