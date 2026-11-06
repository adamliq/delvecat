"""``delvecat-ingest`` command line."""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from . import __version__
from .annotations import AnnotationError, apply_annotations, load_annotations
from .bundle import assemble, load_bundle, validate, write_bundle
from .connectors import db_connect, deployment_server, splunk, splunk_cloud_acs, stream
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


PRODUCTS = {"deploymentServer", "dbConnect", "stream"}


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
    # --only narrows the run to the named platform extractors unless products are asked for.
    chosen = args.products or ("none" if only else "all")
    products = PRODUCTS if chosen == "all" else set(filter(None, chosen.split(",")))
    if unknown := products - PRODUCTS - {"none"}:
        print(f"error: unknown product(s): {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2
    if "deploymentServer" in products:
        apps_dir = Path(args.deployment_apps_dir) if args.deployment_apps_dir else None
        result.extend(deployment_server.extract(transport, args.instance, apps_dir))
    if "dbConnect" in products:
        result.extend(db_connect.extract(transport, args.instance))
    if "stream" in products:
        result.extend(stream.extract(transport, args.instance))

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
    if args.annotations and (code := _annotate_into(bundle, args)) is not None:
        return code

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


def _annotation_source(args: argparse.Namespace) -> dict[str, str] | None:
    if not args.annotation_repo:
        return None
    return {
        "repoUrl": args.annotation_repo.rstrip("/"),
        "branch": args.annotation_branch,
        "path": Path(args.annotations).name if args.annotations else "annotations",
    }


def _annotate_into(bundle: dict[str, Any], args: argparse.Namespace) -> int | None:
    """Apply annotations; return an exit code on failure, None on success."""
    try:
        annotations = load_annotations(Path(args.annotations))
    except AnnotationError as exc:
        print("invalid annotations:", *exc.problems, sep="\n  ", file=sys.stderr)
        return 4
    report = apply_annotations(bundle, annotations, _annotation_source(args))
    if report["status"] != "ok" and args.strict:
        print(f"annotations: {report.get('message')}", file=sys.stderr)
        return 3
    return None


def _annotate(args: argparse.Namespace) -> int:
    if not args.annotations:
        print("error: annotate requires --annotations DIR", file=sys.stderr)
        return 2
    bundle = load_bundle(Path(args.bundle))
    if (code := _annotate_into(bundle, args)) is not None:
        return code
    problems = validate(bundle)
    if problems:
        print("bundle failed validation:", *problems[:50], sep="\n  ", file=sys.stderr)
        return 1
    files = write_bundle(bundle, Path(args.out), shard=args.shard, pretty=args.pretty)
    r = bundle["ingestionReport"][-1]
    print(f"  annotations {r['status']} {r['counts']} {r.get('message', '')}".rstrip())
    print(f"wrote {files[0]}")
    return 0


def _lint_annotations(args: argparse.Namespace) -> int:
    try:
        annotations = load_annotations(Path(args.annotations))
    except AnnotationError as exc:
        print(*exc.problems, sep="\n", file=sys.stderr)
        return 4
    print(
        f"{args.annotations}: {annotations.files} file(s), {len(annotations.entries)} "
        f"entries, {len(annotations.glossary)} glossary terms"
    )
    if args.bundle:
        report = apply_annotations(load_bundle(Path(args.bundle)), annotations)
        print(f"against {args.bundle}: {report['counts']}")
        if report.get("message"):
            print(report["message"], file=sys.stderr)
            return 3
    return 0


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

    def annotation_args(p: argparse.ArgumentParser) -> None:
        g = p.add_argument_group("annotations")
        g.add_argument("--annotations", help="directory of annotation YAML files to merge")
        g.add_argument(
            "--annotation-repo",
            help="repository URL holding the annotations, for 'suggest an edit' links",
        )
        g.add_argument("--annotation-branch", default="main")

    annotation_args(b)
    prod = b.add_argument_group("Splunk products")
    prod.add_argument(
        "--products",
        help="comma-separated: deploymentServer,dbConnect,stream, 'all' (the default "
        "without --only) or 'none'. Each is skipped when not installed.",
    )
    prod.add_argument(
        "--deployment-apps-dir",
        help="Deployment Server's deployment-apps folder, to catalogue the "
        "inputs each app pushes to forwarders",
    )
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

    a = sub.add_parser("annotate", help="merge annotations into an existing bundle")
    a.add_argument("bundle", help="bundle file, manifest or directory")
    annotation_args(a)
    a.add_argument("--out", required=True)
    a.add_argument("--shard", action="store_true")
    a.add_argument("--pretty", action="store_true")
    a.add_argument(
        "--strict",
        action="store_true",
        help="exit 3 if an entry matches nothing or a term is undefined",
    )
    a.set_defaults(func=_annotate)

    la = sub.add_parser("lint-annotations", help="validate annotation files")
    la.add_argument("annotations", help="annotations directory")
    la.add_argument("--bundle", help="also check that every entry matches an entity")
    la.set_defaults(func=_lint_annotations)

    lst = sub.add_parser("extractors", help="list available extractors")
    lst.set_defaults(func=lambda _: print("\n".join(splunk.EXTRACTORS)) or 0)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
