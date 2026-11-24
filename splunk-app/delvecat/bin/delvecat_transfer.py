"""REST endpoint /services/delvecat/transfer: import a catalog into this stack's app.

POST a JSON body:
  {"source": "file", "data": "<base64 of the .json or .json.gz>", "mode": "combine"}
  {"source": "stack", "url": "https://host:8089", "token": "...", "verify": true,
   "mode": "combine"}
{"action": "remove", "instance": "<id>"} publishes the catalog without an imported
instance.
mode "combine" keeps this stack's instances and takes the imported ones (an instance in
both is replaced); "replace" publishes the imported catalog alone. Only catalog
publishers and admins may call it. The other stack is only read; the token is used
for that and never stored, logged or returned.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
sys.path.insert(0, HERE)

from splunk.persistconn.application import PersistentServerConnectionApplication  # noqa: E402

from delvecat_connectivity import _reply, _roles, ALLOWED_ROLES  # noqa: E402
from delvecat_ingest.connectivity import parse_target  # noqa: E402
from delvecat_ingest.publish import data_path  # noqa: E402
from delvecat_ingest.transfer import (  # noqa: E402
    TransferError,
    decode_upload,
    fetch_remote,
    import_catalog,
    parse_catalog,
    remove_instance,
)
from delvecat_ingest.transport import EndpointNotFound, HttpTransport, publish_allowlist  # noqa: E402

APP = "delvecat"
COLLECTION = "delvecat_catalog"


def _local(rest_uri, session_key):
    return HttpTransport(
        rest_uri,
        session_key,
        auth_prefix="Splunk ",
        verify=False,  # this splunkd, on its own address
        trust_env=False,
        timeout=600,
        allowed_writes=publish_allowlist(APP, COLLECTION),
    )


class TransferHandler(PersistentServerConnectionApplication):
    def __init__(self, command_line, command_arg):
        PersistentServerConnectionApplication.__init__(self)

    def handle(self, in_string):
        try:
            request = json.loads(in_string)
        except ValueError:
            return _reply(400, {"error": "Bad request."})
        if request.get("method") != "POST":
            return _reply(405, {"error": "Use POST."})
        session = request.get("session") or {}
        rest_uri = (request.get("server") or {}).get("rest_uri", "https://127.0.0.1:8089")
        try:
            roles = _roles(rest_uri, session.get("authtoken", ""))
        except Exception:  # noqa: BLE001
            return _reply(403, {"error": "Could not check your roles."})
        if not roles & ALLOWED_ROLES:
            return _reply(403, {"error": "Only catalog publishers (delvecat_publisher) and admins can import catalogs."})
        try:
            body = json.loads(request.get("payload") or "{}")
        except ValueError:
            return _reply(400, {"error": "The body must be JSON."})
        local = _local(rest_uri, session.get("authtoken", ""))
        try:
            try:
                status = local.get(data_path(APP, COLLECTION) + "/build")
            except EndpointNotFound:
                status = None
            if (status or {}).get("state") == "running":
                return _reply(409, {"error": "A build is running on this stack: import when it has finished."})
            if body.get("action") == "remove":
                return _reply(200, remove_instance(local, str(body.get("instance") or ""), session.get("user") or "", APP, COLLECTION))
            source = body.get("source")
            if source == "file":
                bundle = parse_catalog(decode_upload(str(body.get("data") or "")))
                origin = "file " + str(body.get("filename") or "")[:120]
            elif source == "stack":
                target = parse_target(str(body.get("url") or ""))
                remote = HttpTransport(
                    "https://%s:%d" % (target.host, target.port),
                    str(body.get("token") or ""),
                    verify=body.get("verify", True) is not False,
                    trust_env=False,
                    timeout=300,
                    allowed_writes=(),
                )
                bundle = fetch_remote(remote, APP, COLLECTION)
                origin = "stack " + str(target)
            else:
                return _reply(400, {"error": "source must be file or stack."})
            summary = import_catalog(local, bundle, str(body.get("mode") or "combine"), session.get("user") or "", origin, APP, COLLECTION)
        except (TransferError, ValueError) as exc:
            return _reply(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 - errors name hosts and paths, never the token
            return _reply(502, {"error": "The import failed: %s: %s" % (type(exc).__name__, str(exc)[:300])})
        return _reply(200, summary)
