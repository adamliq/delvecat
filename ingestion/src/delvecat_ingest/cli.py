"""``delvecat-ingest`` command line."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from . import __version__
from .bundle import assemble, load_bundle, validate, write_bundle
from .connectors import splunk, splunk_cloud_acs
from .connectors.splunk import Options
from .model import merge_facts
from .transport import FixtureTransport, HttpTransport, RecordingTransport, Transport


def _token(env: str) -> str | None:
    token = os.environ.get(env)
    if not token:
        print(f"error: set {env} to an auth token", file=sys.stderr)
    return token


def _verify(args: argparse.Namespace) -> bool | str:
    if args.insecure:
        return False
    return args.ca_bundle or True


def _build(args: argparse.Namespace) -> int:
    transport: Transport
    if args.fixtures:
        transport = FixtureTransport(Path(args.fixtures))
    else:
        if not (token := _token(args.token_env)):
            return 2
        transport = HttpTransport(args.url, token, verify=_verify(args))
    if args.record:
        transport = RecordingTransport(transport, Path(args.record))

    options = Options(
        inventory_window=args.inventory_window,
        max_hosts=args.max_hosts,
        max_sources=args.max_sources,
        fields=args.fields,
        max_field_sourcetypes=args.max_field_sourcetypes,
    )
    only = set(args.only.split(",")) if args.only else None
    if only and (unknown := only - set(splunk.EXTRACTORS)):
        print(f"error: unknown extractor(s): {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2
    result = splunk.extract(transport, args.instance, options, only)

    if args.acs_fixtures or args.acs_stack:
        if args.acs_fixtures:
            acs: Transport = FixtureTransport(Path(args.acs_fixtures))
        else:
            if not (acs_token := _token(args.acs_token_env)):
                return 2
            acs = HttpTransport(
                splunk_cloud_acs.ACS_BASE.format(stack=args.acs_stack),
                acs_token,
                verify=_verify(args),
                splunk_json=False,
            )
            if args.record:
                acs = RecordingTransport(acs, Path(args.record) / "__acs__")
        result.extend(splunk_cloud_acs.extract(acs, args.instance))

    instance: dict[str, Any] = {
        "id": args.instance,
        "name": args.instance_name or args.instance,
        "kind": "splunkEnterprise",
    }
    merge_facts(instance, result.instance_facts)
    if args.kind:
        instance["kind"] = args.kind
    if args.web_url:
        instance["webUrl"] = args.web_url
    if isinstance(instance.get("properties"), dict):
        instance["properties"] = {k: v for k, v in instance["properties"].items() if v is not None}

    previous = None
    if args.previous:
        prev_path = Path(args.previous)
        if prev_path.exists():
            previous = load_bundle(prev_path)
        else:
            print(f"note: previous bundle {prev_path} not found; starting fresh", file=sys.stderr)

    generated_at = datetime.fromisoformat(args.generated_at) if args.generated_at else None
    bundle = assemble([instance], result, generated_at, previous)

    problems = validate(bundle)
    if problems:
        print("bundle failed validation:", *problems[:50], sep="\n  ", file=sys.stderr)
        return 1
    files = write_bundle(bundle, Path(args.out), shard=args.shard, pretty=args.pretty)

    for r in bundle["ingestionReport"]:
        detail = r.get("counts") or ""
        print(f"  {r['connector']:<26} {r['status']:<8} {detail} {r.get('message', '')}".rstrip())
    if ch := bundle.get("changes"):
        print(
            f"changes since {ch['previousGeneratedAt']}: +{len(ch['added'])} "
            f"-{len(ch['removed'])} ~{len(ch['modified'])}"
        )
    print(
        f"wrote {files[0]}{f' (+{len(files) - 1} shards)' if args.shard else ''}: "
        f"{len(bundle['entities'])} entities, {len(bundle['edges'])} edges"
    )
    failed = [r for r in bundle["ingestionReport"] if r["status"] == "failed"]
    return 3 if failed and args.strict else 0


def _validate(args: argparse.Namespace) -> int:
    bundle = load_bundle(Path(args.bundle))
    problems = validate(bundle)
    if problems:
        print(*problems, sep="\n", file=sys.stderr)
        return 1
    print(
        f"{args.bundle}: valid ({len(bundle['entities'])} entities, {len(bundle['edges'])} edges)"
    )
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
        "--kind",
        choices=["splunkEnterprise", "splunkCloud"],
        help="override auto-detected instance kind",
    )
    b.add_argument("--web-url", help="Splunk Web URL for deep links")
    b.add_argument("--token-env", default="DELVECAT_SPLUNK_TOKEN")
    b.add_argument("--ca-bundle", help="CA bundle for TLS verification")
    b.add_argument("--insecure", action="store_true", help="skip TLS verification (dev only)")

    cloud = b.add_argument_group("Splunk Cloud (ACS)")
    cloud.add_argument("--acs-stack", help="Splunk Cloud stack name, enables the ACS connector")
    cloud.add_argument("--acs-token-env", default="DELVECAT_ACS_TOKEN")
    cloud.add_argument("--acs-fixtures", help="directory of recorded ACS responses")

    inv = b.add_argument_group("data inventory")
    inv.add_argument(
        "--inventory-window",
        default="-7d",
        help="time window for observed sourcetypes/hosts/sources (default -7d)",
    )
    inv.add_argument("--max-hosts", type=int, default=5000)
    inv.add_argument("--max-sources", type=int, default=5000)
    inv.add_argument(
        "--fields",
        action="store_true",
        help="sample events per sourcetype to discover fields (slower)",
    )
    inv.add_argument("--max-field-sourcetypes", type=int, default=100)

    b.add_argument("--only", help="comma-separated extractor names to run")
    b.add_argument("--record", help="save every response under this directory as fixtures")
    b.add_argument("--previous", help="previous bundle (file or directory) for versioning")
    b.add_argument(
        "--shard",
        action="store_true",
        help="write --out as a directory: catalog.json manifest + per-type shards",
    )
    b.add_argument("--generated-at", help="fixed ISO timestamp for reproducible builds")
    b.add_argument("--pretty", action="store_true")
    b.add_argument("--strict", action="store_true", help="exit 3 if any extractor failed")
    b.add_argument("--out", required=True)
    b.set_defaults(func=_build)

    v = sub.add_parser("validate", help="validate a bundle (file, manifest or directory)")
    v.add_argument("bundle")
    v.set_defaults(func=_validate)

    lst = sub.add_parser("extractors", help="list available extractors")
    lst.set_defaults(func=lambda _: print("\n".join(splunk.EXTRACTORS)) or 0)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
