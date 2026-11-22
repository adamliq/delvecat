"""Test the connection from this Splunk to another stack that has the app installed.

Each step says what it checked, how long it took and, when it fails, the likely
cause: the name resolves, the management port answers, TLS is trusted, the token is
accepted, the app is installed (and which version), and the other stack has a
published catalog. Every request is a GET to a fixed Splunk REST path; redirects
are not followed. The token is used for these requests only: it is never stored,
logged or returned.
"""

from __future__ import annotations

import http.client
import json
import socket
import ssl
import time
from collections.abc import Callable
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from .compat import UTC

APP = "delvecat"
COLLECTION = "delvecat_catalog"
MAX_BODY = 1_000_000
DEFAULT_PORT = 8089

Step = dict[str, Any]


class Target:
    def __init__(self, host: str, port: int):
        self.host, self.port = host, port

    def __str__(self) -> str:
        return f"{self.host}:{self.port}"


def parse_target(url: str) -> Target:
    """``https://host[:port]`` (the management port, 8089 by default). Anything else
    (http, a path, credentials in the URL) is refused."""
    text = (url or "").strip()
    if "://" not in text:
        text = f"https://{text}"
    parts = urlsplit(text)
    if parts.scheme != "https":
        raise ValueError("Use https:// and the management port (usually 8089).")
    if parts.username or parts.password:
        raise ValueError("Leave credentials out of the address; give a token instead.")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        raise ValueError("Give only the address and port, e.g. https://sh.example.com:8089.")
    if not parts.hostname:
        raise ValueError("No host name in the address.")
    try:
        port = parts.port or DEFAULT_PORT
    except ValueError:
        raise ValueError("The port is not a number.") from None
    return Target(parts.hostname, port)


def _ms(start: float) -> int:
    return round((time.monotonic() - start) * 1000)


def _step(
    id_: str, title: str, status: str, message: str, start: float | None = None, **extra: Any
) -> Step:
    s: Step = {"step": id_, "title": title, "status": status, "message": message}
    if start is not None:
        s["ms"] = _ms(start)
    s.update({k: v for k, v in extra.items() if v is not None})
    return s


def _context(verify: bool) -> ssl.SSLContext:
    if verify:
        return ssl.create_default_context()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _cert_summary(cert: dict[str, Any] | None, now: datetime) -> tuple[str, int | None]:
    if not cert:
        return "", None
    subject = dict(x[0] for x in cert.get("subject", ()) if x)
    issuer = dict(x[0] for x in cert.get("issuer", ()) if x)
    days = None
    if cert.get("notAfter"):
        expires = datetime.fromtimestamp(ssl.cert_time_to_seconds(cert["notAfter"]), UTC)
        days = (expires - now).days
    by = issuer.get("commonName", issuer.get("organizationName", "?"))
    text = f"certificate for {subject.get('commonName', '?')}, issued by {by}"
    if days is not None:
        text += f", expires in {days} days"
    return text, days


Get = Callable[[str], tuple[int, Any]]


def _getter(target: Target, token: str, ctx: ssl.SSLContext, timeout: float) -> Get:
    def get(path: str) -> tuple[int, Any]:
        conn = http.client.HTTPSConnection(target.host, target.port, context=ctx, timeout=timeout)
        try:
            sep = "&" if "?" in path else "?"
            conn.request(
                "GET", f"{path}{sep}output_mode=json", headers={"Authorization": f"Bearer {token}"}
            )
            resp = conn.getresponse()
            body = resp.read(MAX_BODY)
            try:
                data = json.loads(body or b"null")
            except ValueError:
                data = None
            return resp.status, data
        finally:
            conn.close()

    return get


def _entry(data: Any) -> dict[str, Any]:
    entries = (data or {}).get("entry") if isinstance(data, dict) else None
    return (entries[0].get("content") or {}) if entries else {}


def _messages(data: Any) -> str:
    msgs = (data or {}).get("messages") if isinstance(data, dict) else None
    return "; ".join(str(m.get("text", "")).strip() for m in msgs or [] if m.get("text"))[:300]


def check_stack(
    url: str,
    token: str | None,
    verify: bool = True,
    timeout: float = 10,
    local_version: str | None = None,
    now: datetime | None = None,
    get: Get | None = None,
) -> dict[str, Any]:
    """Run the checks in order; a failed network step skips the ones after it.
    ``get`` replaces the HTTPS requests (tests)."""
    now = now or datetime.now(UTC)
    steps: list[Step] = []
    try:
        target = parse_target(url)
    except ValueError as exc:
        return {
            "target": url,
            "ok": False,
            "steps": [_step("address", "Address", "failed", str(exc))],
        }

    def done(ok: bool) -> dict[str, Any]:
        return {
            "target": str(target),
            "ok": ok,
            "checkedAt": now.isoformat(timespec="seconds"),
            "steps": steps,
        }

    if get is None:
        # Name, port and TLS, one at a time, so a failure says which.
        start = time.monotonic()
        try:
            addresses = sorted(
                {
                    a[4][0]
                    for a in socket.getaddrinfo(target.host, target.port, type=socket.SOCK_STREAM)
                }
            )
            steps.append(_step("dns", "Name resolves", "ok", ", ".join(addresses[:4]), start))
        except OSError as exc:
            steps.append(
                _step(
                    "dns",
                    "Name resolves",
                    "failed",
                    f"{target.host} does not resolve ({exc.strerror or exc}). "
                    "Check the name, or this Splunk's DNS.",
                    start,
                )
            )
            return done(False)

        start = time.monotonic()
        try:
            sock = socket.create_connection((target.host, target.port), timeout=timeout)
            steps.append(
                _step(
                    "tcp",
                    "Management port answers",
                    "ok",
                    f"connected to port {target.port}",
                    start,
                )
            )
        except socket.timeout:
            steps.append(
                _step(
                    "tcp",
                    "Management port answers",
                    "failed",
                    f"No answer from port {target.port} in {timeout:g} s: a firewall drops it. "
                    "On Splunk Cloud, the other stack's "
                    "search-api allow list (ACS) must include this stack's outbound IP addresses.",
                    start,
                )
            )
            return done(False)
        except ConnectionRefusedError:
            steps.append(
                _step(
                    "tcp",
                    "Management port answers",
                    "failed",
                    f"Port {target.port} refused the connection: splunkd does not listen there "
                    "(another port, or the management port is off).",
                    start,
                )
            )
            return done(False)
        except OSError as exc:
            steps.append(
                _step(
                    "tcp",
                    "Management port answers",
                    "failed",
                    f"Cannot connect: {exc.strerror or exc}.",
                    start,
                )
            )
            return done(False)

        start = time.monotonic()
        ctx = _context(verify)
        try:
            with ctx.wrap_socket(sock, server_hostname=target.host) as tls:
                cert_text, days = _cert_summary(tls.getpeercert() if verify else None, now)
                detail = f"{tls.version()}" + (
                    f"; {cert_text}" if cert_text else "; certificate not checked"
                )
            status = "warning" if (not verify or (days is not None and days < 30)) else "ok"
            if not verify:
                detail += " (verification is off: use it for a test only)"
            elif days is not None and days < 30:
                detail += ": renew it soon"
            steps.append(_step("tls", "TLS", status, detail, start))
        except ssl.SSLCertVerificationError as exc:
            steps.append(
                _step(
                    "tls",
                    "TLS",
                    "failed",
                    f"The certificate is not trusted ({exc.verify_message or exc}). "
                    "Give this Splunk the CA that signed it, "
                    "or turn verification off for a test only.",
                    start,
                )
            )
            return done(False)
        except (ssl.SSLError, OSError) as exc:
            steps.append(_step("tls", "TLS", "failed", f"TLS handshake failed: {exc}.", start))
            return done(False)
        finally:
            sock.close()
        get = _getter(target, token or "", ctx, timeout)

    if not token:
        for id_, title in (
            ("auth", "Token accepted"),
            ("app", "App installed"),
            ("catalog", "Catalog published"),
        ):
            steps.append(
                _step(
                    id_,
                    title,
                    "skipped",
                    "Give a token of an account on the other stack to check this.",
                )
            )
        return done(all(s["status"] != "failed" for s in steps))

    start = time.monotonic()
    try:
        status, data = get("/services/server/info")
    except (OSError, http.client.HTTPException) as exc:
        steps.append(_step("auth", "Token accepted", "failed", f"Request failed: {exc}.", start))
        return done(False)
    if status in (401, 403):
        steps.append(
            _step(
                "auth",
                "Token accepted",
                "failed",
                "The token was refused: it may be expired, disabled, or for another stack; "
                "token authentication must be on there.",
                start,
            )
        )
        return done(False)
    if status != 200:
        steps.append(
            _step(
                "auth",
                "Token accepted",
                "failed",
                f"HTTP {status}: {_messages(data) or 'unexpected answer'}.",
                start,
            )
        )
        return done(False)
    info = _entry(data)
    remote = {
        "serverName": info.get("serverName"),
        "version": info.get("version"),
        "product": info.get("product_type") or info.get("instance_type"),
    }
    steps.append(
        _step(
            "auth",
            "Token accepted",
            "ok",
            f"{remote['serverName'] or '?'}: Splunk {remote['version'] or '?'}"
            + (" (Splunk Cloud)" if info.get("instance_type") == "cloud" else ""),
            start,
            remote=remote,
        )
    )

    start = time.monotonic()
    status, data = get(f"/services/apps/local/{APP}")
    if status == 404:
        steps.append(
            _step(
                "app",
                "App installed",
                "failed",
                "Licoryx Delvecat is not installed there, or this account cannot see it "
                "(it needs the delvecat_user or delvecat_publisher role).",
                start,
            )
        )
        return done(False)
    if status != 200:
        steps.append(
            _step(
                "app",
                "App installed",
                "failed",
                f"HTTP {status}: {_messages(data) or 'unexpected answer'}.",
                start,
            )
        )
        return done(False)
    app = _entry(data)
    version = str(app.get("version") or "")
    disabled = str(app.get("disabled")).lower() in ("1", "true")
    if disabled:
        steps.append(
            _step(
                "app",
                "App installed",
                "failed",
                f"Installed (version {version}) but disabled.",
                start,
                version=version,
            )
        )
        return done(False)
    same = not local_version or version == local_version
    steps.append(
        _step(
            "app",
            "App installed",
            "ok" if same else "warning",
            f"version {version}"
            + ("" if same else f"; this stack has {local_version}: upgrade one so they match"),
            start,
            version=version,
        )
    )

    start = time.monotonic()
    status, data = get(f"/servicesNS/nobody/{APP}/storage/collections/data/{COLLECTION}/current")
    if status == 404:
        steps.append(
            _step(
                "catalog",
                "Catalog published",
                "warning",
                "No catalog there yet (or this account lacks delvecat_user): "
                "build one on its Build page.",
                start,
            )
        )
        return done(True)
    if status != 200 or not isinstance(data, dict):
        steps.append(
            _step(
                "catalog",
                "Catalog published",
                "warning",
                f"HTTP {status}: {_messages(data) or 'unexpected answer'}.",
                start,
            )
        )
        return done(True)
    generated = data.get("generatedAt") or data.get("publishedAt")
    entities = data.get("entities")
    text = f"{entities:,} objects" if isinstance(entities, int) else "published"
    if generated:
        text += f", built {generated}"
    steps.append(
        _step(
            "catalog",
            "Catalog published",
            "ok",
            text,
            start,
            generatedAt=generated,
            publishedAt=data.get("publishedAt"),
            entities=entities,
        )
    )
    return done(True)
