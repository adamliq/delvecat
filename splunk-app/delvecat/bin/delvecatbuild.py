"""| delvecatbuild: build the DelveCat catalog of this Splunk, on demand, and publish
it to the app's KV store collection.

It runs on the search head as the person who starts it (their session, no token),
so the catalog shows what they can see. It reads Splunk over the REST API, as the
command-line delvecat-ingest does, and writes nothing but the app's own collection
(the catalog and the "build" status document the app's Build page shows).
"""

import contextlib
import os
import sys
import time
import traceback
from datetime import datetime, timezone
from urllib.parse import urlparse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))

from splunklib.searchcommands import (  # noqa: E402
    Configuration,
    GeneratingCommand,
    Option,
    dispatch,
    validators,
)

from delvecat_ingest.inapp import PARTS, build_here, resolve_parts  # noqa: E402
from delvecat_ingest.publish import (  # noqa: E402
    PublishError,
    publish_bundle,
    read_published,
    save_doc,
)
from delvecat_ingest.transport import EndpointNotFound, HttpTransport, publish_allowlist  # noqa: E402

APP = "delvecat"
COLLECTION = "delvecat_catalog"
STALE_SECONDS = 15 * 60  # a "running" status older than this is a build that died
DATA = f"/servicesNS/nobody/{APP}/storage/collections/data/{COLLECTION}"
SMALLER = 0.5  # a catalog under half the size of the current one is not published unasked


class MuchSmaller(RuntimeError):
    pass


class Superseded(RuntimeError):
    """A newer build took over (this one was cancelled, or ran too long)."""


def _objects(bundle):
    """Objects other than discovered fields, which come and go with fields=true."""
    return sum(1 for e in bundle["entities"] if e["type"] != "field")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@Configuration(distributed=False)
class DelveCatBuild(GeneratingCommand):
    fields = Option(require=False, validate=validators.Boolean(), default=False)
    usage = Option(require=False, validate=validators.Boolean(), default=True)
    redact = Option(require=False, validate=validators.Set("none", "internal"), default="none")
    instance = Option(require=False, validate=validators.Match("instance", r"^[A-Za-z0-9_-]+$"))
    instancename = Option(require=False)
    weburl = Option(require=False, validate=validators.Match("weburl", r"^https?://\S+$"))
    dryrun = Option(require=False, validate=validators.Boolean(), default=False)
    # Publish even if the new catalog is much smaller than the current one.
    replacesmaller = Option(require=False, validate=validators.Boolean(), default=False)
    # Comma-separated parts to run (see inapp.PARTS); all of them when not given.
    parts = Option(require=False, validate=validators.Match("parts", r"^[A-Za-z, ]*$"))
    # Seconds a single search may run before it is cancelled; 0 for no limit.
    searchtimeout = Option(
        require=False, validate=validators.Integer(minimum=0, maximum=86400), default=300
    )

    def generate(self):
        info = self._metadata.searchinfo
        host = urlparse(info.splunkd_uri).hostname or ""
        transport = HttpTransport(
            info.splunkd_uri,
            info.session_key,
            auth_prefix="Splunk ",
            # splunkd on this machine: its certificate is not issued for 127.0.0.1.
            verify=host not in ("127.0.0.1", "localhost", "::1"),
            trust_env=False,
            timeout=600,
            allowed_writes=publish_allowlist(APP, COLLECTION),
            search_timeout=self.searchtimeout or None,
        )
        parts = (
            {p.strip() for p in self.parts.split(",") if p.strip()}
            if self.parts is not None
            else None
        )
        status = {
            "_key": "build",
            "state": "running",
            "sid": info.sid,
            "user": info.username,
            "startedAt": _now(),
            "updatedAt": _now(),
            "step": "starting",
            "options": {
                "fields": bool(self.fields),
                "usage": bool(self.usage),
                "redact": self.redact,
                "instance": self.instance,
                "parts": sorted(parts) if parts is not None else None,
                "searchTimeout": self.searchtimeout,
            },
        }
        self._claim(transport, status)
        last = [0.0]

        def progress(step):
            status["step"] = step
            status["updatedAt"] = _now()
            if time.time() - last[0] > 2:  # at most one status write every 2 seconds
                last[0] = time.time()
                self._save_own(transport, status)

        try:
            progress("reading the published catalog")
            previous = read_published(transport, APP, COLLECTION)
            try:
                published_by = transport.get(f"{DATA}/current").get("publishedBy")
            except EndpointNotFound:
                published_by = None
            bundle = build_here(
                transport,
                instance_id=self.instance,
                instance_name=self.instancename,
                web_url=self.weburl,
                fields=bool(self.fields),
                usage=bool(self.usage),
                redact=self.redact,
                previous=previous,
                progress=progress,
                parts=parts,
            )
            # Fields left out (fields=false) are not "seeing less": compare everything else.
            before = _objects(previous) if previous else 0
            after = _objects(bundle)
            if before and after < before * SMALLER and not self.replacesmaller:
                # Usually a selection of parts, or someone who sees less of Splunk than
                # whoever built it last.
                some = parts is not None and resolve_parts(parts) | {"fields"} != set(PARTS)
                status.update(entities=after, previousEntities=before, partial=some)
                why = (
                    "only some parts were selected, and the catalog holds only what they read"
                    if some
                    else "you may see less of this Splunk than "
                    + (published_by or "whoever built it")
                )
                raise MuchSmaller(
                    f"the new catalog has {after:,} objects (not counting fields), "
                    f"the current one {before:,}: {why}. Nothing was published. "
                    "Replace it anyway with replacesmaller=true."
                )
            progress("publishing")
            pointer = publish_bundle(
                bundle,
                transport,
                APP,
                COLLECTION,
                dry_run=bool(self.dryrun),
                force=True,
                extra={"publishedBy": info.username, "builtBy": "delvecatbuild", "sid": info.sid},
                log=lambda m: None,
            )
            problems = [r for r in bundle["ingestionReport"] if r["status"] not in ("ok",)]
            status.update(
                state="done",
                step="done",
                finishedAt=_now(),
                updatedAt=_now(),
                dryRun=bool(self.dryrun),
                generation=pointer["generation"],
                entities=pointer["entities"],
                edges=pointer["edges"],
                instance=bundle["instances"][0]["id"],
                problems=[
                    {
                        "connector": r["connector"],
                        "status": r["status"],
                        "message": r.get("message", ""),
                    }
                    for r in problems
                ][:50],
            )
            self._save_own(transport, status)
        except Superseded:
            raise  # the status belongs to the newer build now: leave it alone
        except Exception as exc:
            status.update(
                state="failed",
                finishedAt=_now(),
                updatedAt=_now(),
                message=str(exc)[:2000],
                reason="smaller" if isinstance(exc, MuchSmaller) else "error",
            )
            with contextlib.suppress(Exception):  # report the original error, not this one
                self._save_own(transport, status)
            self.logger.error("delvecatbuild failed: %s", traceback.format_exc())
            raise
        yield {
            "_time": time.time(),
            "status": status["state"],
            "instance": status["instance"],
            "entities": status["entities"],
            "edges": status["edges"],
            "generation": status["generation"],
            "dry_run": int(bool(self.dryrun)),
            "problems": len(status["problems"]),
        }

    def _claim(self, transport, status):
        """Only one build at a time: refuse while another one is running."""
        path = f"{DATA}/build"
        try:
            current = transport.get(path)
        except EndpointNotFound:
            current = None
        except Exception as exc:  # noqa: BLE001
            raise PublishError(
                f"cannot use the {COLLECTION} collection: "
                f"you need the delvecat_publisher role ({exc})"
            ) from None
        if current and current.get("state") == "running" and current.get("sid") != status["sid"]:
            try:
                age = time.time() - datetime.fromisoformat(current["updatedAt"]).timestamp()
            except (KeyError, ValueError):
                age = STALE_SECONDS + 1
            if age < STALE_SECONDS and self._job_alive(transport, current.get("sid")):
                raise RuntimeError(
                    f"a build started by {current.get('user')} is still running "
                    f"(search {current.get('sid')}); wait for it or cancel that search"
                )
        save_doc(transport, status, APP, COLLECTION)

    @staticmethod
    def _save_own(transport, status):
        """Write the status, unless a newer build has claimed it: a cancelled search keeps
        running for a few seconds and must not overwrite the build that replaced it."""
        try:
            sid = transport.get(f"{DATA}/build").get("sid")
        except EndpointNotFound:
            sid = None
        if sid not in (None, status["sid"]):
            raise Superseded(f"build {status['sid']} was replaced by build {sid}; stopping")
        save_doc(transport, status, APP, COLLECTION)

    @staticmethod
    def _job_alive(transport, sid):
        """Whether the search of an earlier build is still running (not cancelled or dead)."""
        if not sid:
            return False
        try:
            job = transport.get(f"/services/search/jobs/{sid}")["entry"][0]["content"]
        except EndpointNotFound:
            return False
        except Exception:  # noqa: BLE001 - cannot tell: assume it runs
            return True
        return job.get("dispatchState") not in ("DONE", "FAILED", "FINALIZING") and not job.get(
            "isFailed"
        )


dispatch(DelveCatBuild, sys.argv, sys.stdin, sys.stdout, __name__)
