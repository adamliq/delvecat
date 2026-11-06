"""``delvecat-ingest`` command line."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

from . import __version__
from .bundle import assemble, validate
from .connectors import splunk_platform
from .transport import FixtureTransport, HttpTransport, Transport


def _build(args: argparse.Namespace) -> int:
    transport: Transport
    if args.fixtures:
        transport = FixtureTransport(Path(args.fixtures))
        kind = "splunkEnterprise"
    else:
        token = os.environ.get(args.token_env)
        if not token:
            print(f"error: set {args.token_env} to a Splunk auth token", file=sys.stderr)
            return 2
        transport = HttpTransport(args.url, token, verify=not args.insecure)
        kind = args.kind

    instance = {"id": args.instance, "name": args.instance_name or args.instance, "kind": kind}
    if args.web_url:
        instance["webUrl"] = args.web_url
    result = splunk_platform.extract(transport, args.instance)
    generated_at = datetime.fromisoformat(args.generated_at) if args.generated_at else None
    bundle = assemble([instance], result, generated_at)

    problems = validate(bundle)
    if problems:
        print("bundle failed validation:", *problems, sep="\n  ", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(bundle, indent=2 if args.pretty else None) + "\n", encoding="utf-8")
    for r in result.reports:
        print(f"  {r['connector']:<24} {r['status']:<8} {r.get('counts') or r.get('message', '')}")
    print(f"wrote {out} ({len(bundle['entities'])} entities, {len(bundle['edges'])} edges)")
    return 0


def _validate(args: argparse.Namespace) -> int:
    bundle = json.loads(Path(args.bundle).read_text(encoding="utf-8"))
    problems = validate(bundle)
    if problems:
        print(*problems, sep="\n", file=sys.stderr)
        return 1
    print(f"{args.bundle}: valid")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="delvecat-ingest")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="extract metadata and write a catalog bundle")
    src = b.add_mutually_exclusive_group(required=True)
    src.add_argument("--fixtures", help="directory of recorded REST responses")
    src.add_argument("--url", help="Splunk management URL, e.g. https://splunk:8089")
    b.add_argument("--instance", required=True, help="short instance id used in FQNs")
    b.add_argument("--instance-name")
    b.add_argument(
        "--kind", default="splunkEnterprise", choices=["splunkEnterprise", "splunkCloud"]
    )
    b.add_argument("--web-url", help="Splunk Web URL for deep links")
    b.add_argument("--token-env", default="DELVECAT_SPLUNK_TOKEN")
    b.add_argument("--insecure", action="store_true", help="skip TLS verification (dev only)")
    b.add_argument("--generated-at", help="fixed ISO timestamp for reproducible builds")
    b.add_argument("--pretty", action="store_true")
    b.add_argument("--out", required=True)
    b.set_defaults(func=_build)

    v = sub.add_parser("validate", help="validate a bundle against the schema")
    v.add_argument("bundle")
    v.set_defaults(func=_validate)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
