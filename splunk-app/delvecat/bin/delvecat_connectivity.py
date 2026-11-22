"""REST endpoint /services/delvecat/connectivity: test the connection from this Splunk
to another stack that has the app installed (see delvecat_ingest.connectivity).

POST a JSON body {"url": "https://host:8089", "token": "...", "verify": true}. Only
catalog publishers and admins may call it. The token is used for the test's
requests to the other stack and is never stored, logged or returned.
"""

import json
import os
import ssl
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))

from splunk.persistconn.application import PersistentServerConnectionApplication  # noqa: E402

from delvecat_ingest.connectivity import check_stack  # noqa: E402

ALLOWED_ROLES = {"admin", "sc_admin", "delvecat_publisher"}


def _app_version():
    for name in ("local", "default"):
        path = os.path.join(HERE, "..", name, "app.conf")
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    key, _, value = line.partition("=")
                    if key.strip() == "version" and value.strip():
                        return value.strip()
        except OSError:
            continue
    return None


def _roles(rest_uri, session_key):
    """The caller's roles, asked of this splunkd with the caller's own session."""
    req = urllib.request.Request(
        rest_uri.rstrip("/") + "/services/authentication/current-context?output_mode=json",
        headers={"Authorization": "Splunk " + session_key},
    )
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # this splunkd, on its own address
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        data = json.loads(resp.read())
    return set(data["entry"][0]["content"].get("roles") or [])


def _reply(status, body):
    return {"status": status, "payload": json.dumps(body), "headers": {"Content-Type": "application/json"}}


class ConnectivityHandler(PersistentServerConnectionApplication):
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
        server = request.get("server") or {}
        try:
            roles = _roles(server.get("rest_uri", "https://127.0.0.1:8089"), session.get("authtoken", ""))
        except Exception:  # noqa: BLE001 - answer without details
            return _reply(403, {"error": "Could not check your roles."})
        if not roles & ALLOWED_ROLES:
            return _reply(403, {"error": "Only catalog publishers (delvecat_publisher) and admins can test connections."})
        try:
            body = json.loads(request.get("payload") or "{}")
        except ValueError:
            return _reply(400, {"error": "The body must be JSON."})
        try:
            timeout = min(30.0, max(2.0, float(body.get("timeout") or 10)))
        except (TypeError, ValueError):
            timeout = 10.0
        result = check_stack(
            str(body.get("url") or ""),
            str(body.get("token") or "") or None,
            verify=body.get("verify", True) is not False,
            timeout=timeout,
            local_version=_app_version(),
        )
        return _reply(200, result)
