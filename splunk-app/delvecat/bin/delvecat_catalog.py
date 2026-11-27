"""REST endpoint /services/delvecat/catalog: read the published catalog from scripts.

GET (output_mode=json), read-only:
  ?type=index,sourcetype&instance=&app=&name=<part of the name>&limit=100&offset=0
      objects, a page at a time (fields=full for whole objects)
  ?id=<object id>             one object with its incoming and outgoing relationships
  ?upstream=<id>&depth=3      what it depends on (a search: its macros, indexes, ...)
  ?downstream=<id>&depth=3    what depends on it (an index: the searches reading it, ...)
The catalog is read with the caller's own session, so the app's collection permissions
decide who may use this (as for the app's page). The decoded catalog is kept in this
process for the current generation; the pointer is read again on every request.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
sys.path.insert(0, HERE)

from delvecat_connectivity import _reply  # noqa: E402
from splunk.persistconn.application import PersistentServerConnectionApplication  # noqa: E402

from delvecat_ingest.publish import data_path, read_published  # noqa: E402
from delvecat_ingest.query import CatalogIndex, QueryError  # noqa: E402
from delvecat_ingest.transport import (  # noqa: E402
    EndpointForbidden,
    EndpointNotFound,
    HttpTransport,
)

APP = "delvecat"
COLLECTION = "delvecat_catalog"
_cache = {"key": None, "index": None}


def _params(request):
    q = request.get("query") or []
    if isinstance(q, dict):
        return {str(k): str(v) for k, v in q.items()}
    return {str(k): str(v) for k, v in q if k != "output_mode"}


class CatalogHandler(PersistentServerConnectionApplication):
    def __init__(self, command_line, command_arg):
        PersistentServerConnectionApplication.__init__(self)

    def handle(self, in_string):
        try:
            request = json.loads(in_string)
        except ValueError:
            return _reply(400, {"error": "Bad request."})
        if request.get("method") != "GET":
            return _reply(405, {"error": "Use GET."})
        session = request.get("session") or {}
        rest_uri = (request.get("server") or {}).get("rest_uri", "https://127.0.0.1:8089")
        local = HttpTransport(
            rest_uri,
            session.get("authtoken", ""),
            auth_prefix="Splunk ",
            verify=False,  # this splunkd, on its own address
            trust_env=False,
            timeout=600,
            allowed_writes=(),  # read-only
        )
        try:
            pointer = local.get(data_path(APP, COLLECTION) + "/current")
        except (EndpointNotFound, EndpointForbidden):
            return _reply(
                403,
                {"error": "No catalog you may read: ask an admin for the delvecat_user role."},
            )
        except Exception as exc:  # noqa: BLE001
            return _reply(502, {"error": f"Could not read the catalog: {type(exc).__name__}"})
        key = (pointer.get("generation"), pointer.get("sha256"))
        if _cache["key"] != key:
            try:
                bundle = read_published(local, APP, COLLECTION)
            except Exception as exc:  # noqa: BLE001
                return _reply(502, {"error": f"Could not read the catalog: {type(exc).__name__}"})
            if bundle is None:
                return _reply(409, {"error": "The catalog changed while it was read: try again."})
            _cache["key"], _cache["index"] = key, CatalogIndex(bundle)
        try:
            result = _cache["index"].query(_params(request))
        except QueryError as exc:
            return _reply(400, {"error": str(exc)})
        return _reply(
            200,
            {
                "generation": pointer.get("generation"),
                "generatedAt": pointer.get("generatedAt"),
                **result,
            },
        )
