import pytest

from delvecat_ingest.transport import (
    EndpointNotFound,
    FixtureTransport,
    WriteAttemptError,
    check_read_only,
)


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/servicesNS/-/-/saved/searches"),
        ("HEAD", "/services/server/info"),
        ("POST", "/services/search/jobs"),
        ("POST", "/servicesNS/admin/search/search/v2/jobs"),
        ("POST", "/services/search/parser"),
    ],
)
def test_read_only_allows(method, path):
    check_read_only(method, path)


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/servicesNS/nobody/search/saved/searches"),
        ("POST", "/services/search/jobs/1234/control"),
        ("DELETE", "/services/data/indexes/main"),
        ("PUT", "/services/apps/local/search"),
        ("PATCH", "/services/search/jobs"),
    ],
)
def test_read_only_refuses(method, path):
    with pytest.raises(WriteAttemptError):
        check_read_only(method, path)


def test_fixture_transport_missing_endpoint(tmp_path):
    with pytest.raises(EndpointNotFound):
        FixtureTransport(tmp_path).get("/services/nope")
