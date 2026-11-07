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
from .connectors import (
    db_connect,
    deployment_server,
    enterprise_security,
    soar,
    splunk,
    splunk_cloud_acs,
    stream,
    ueba,
)
from .connectors.splunk import Options
from .governance import apply_governance
from .merge import MergeError, merge_bundles
from .model import ExtractResult, merge_facts
from .redaction import load_profile, redact_bundle
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


PRODUCTS = {"deploymentServer", "dbConnect", "stream", "enterpriseSecurity"}


def _build(args: argparse.Namespace) -> int:
    # A bundle can come from a Splunk instance, or only from SOAR / UBA servers.
    splunk_source = bool(args.fixtures or args.url)
    if not splunk_source and not any(
        getattr(args, k) for k in ("soar_url", "soar_fixtures", "ueba_url", "ueba_fixtures")
    ):
        print("error: give --url or --fixtures (or a SOAR / UBA source)", file=sys.stderr)
        return 2
    transport: Transport
    if args.fixtures:
        transport = FixtureTransport(Path(args.fixtures))
    elif args.url:
        if not (token := _token(args.token_env)):
            return 2
        transport = HttpTransport(args.url, token, verify=_verify(args))
    else:
        transport = FixtureTransport(Path("/nonexistent-delvecat"))  # never queried
    if args.record and splunk_source:
        transport = RecordingTransport(transport, Path(args.record))

    options = Options(
        inventory_window=args.inventory_window,
        max_hosts=args.max_hosts,
        max_sources=args.max_sources,
        fields=args.fields,
        max_field_sourcetypes=args.max_field_sourcetypes,
        usage=not args.no_usage,
        usage_window=args.usage_window,
        health_window=args.health_window,
    )
    only = set(args.only.split(",")) if args.only else None
    if only and (unknown := only - set(splunk.EXTRACTORS)):
        print(f"error: unknown extractor(s): {', '.join(sorted(unknown))}", file=sys.stderr)
        return 2
    result = (
        splunk.extract(transport, args.instance, options, only)
        if splunk_source
        else ExtractResult()
    )
    # --only narrows the run to the named platform extractors unless products are asked for.
    chosen = args.products or ("none" if only else "all")
    products = PRODUCTS if chosen == "all" else set(filter(None, chosen.split(",")))
    if not splunk_source:
        products = set()
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
    if "enterpriseSecurity" in products:
        result.extend(enterprise_security.extract(transport, args.instance))

    # SOAR and UBA are separate servers: each becomes its own instance in the bundle.
    extra_instances: list[dict[str, Any]] = []
    for kind, label in (("soar", "SOAR"), ("ueba", "UBA")):
        fixtures, url = getattr(args, f"{kind}_fixtures"), getattr(args, f"{kind}_url")
        if not (fixtures or url):
            continue
        if fixtures:
            server: Transport = FixtureTransport(Path(fixtures))
        else:
            if not (server_token := _token(getattr(args, f"{kind}_token_env"))):
                return 2
            header = ("ph-auth-token", "") if kind == "soar" else ("Authorization", "Bearer ")
            server = HttpTransport(
                url,
                server_token,
                verify=_verify(args),
                splunk_json=False,
                auth_header=header[0],
                auth_prefix=header[1],
            )
            if args.record:
                server = RecordingTransport(server, Path(args.record) / f"__{kind}__")
        inst_id = getattr(args, f"{kind}_instance")
        if kind == "soar":
            sub = soar.extract(server, inst_id)
        else:
            paths = dict(p.split("=", 1) for p in args.ueba_path or [])
            sub = ueba.extract(server, inst_id, paths)
        facts, sub.instance_facts = sub.instance_facts, {}
        extra_instances.append(
            {
                "id": inst_id,
                "name": f"{label} ({inst_id})",
                "kind": facts.get("kind", "soar" if kind == "soar" else "uba"),
                **({"version": facts["version"]} if facts.get("version") else {}),
                **({"webUrl": url} if url else {}),
            }
        )
        result.extend(sub)

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

    instances = [instance, *extra_instances] if splunk_source else extra_instances

    previous = None
    if args.previous:
        prev_path = Path(args.previous)
        if prev_path.exists():
            previous = load_bundle(prev_path)
        else:
            print(f"note: previous bundle {prev_path} not found; starting fresh", file=sys.stderr)

    generated_at = datetime.fromisoformat(args.generated_at) if args.generated_at else None
    bundle = assemble(instances, result, generated_at, previous)
    if args.annotations and (code := _annotate_into(bundle, args)) is not None:
        return code

    if not args.annotations:
        apply_governance(bundle)  # access facts are useful even without classifications
    if (code := _redact_into(bundle, args)) is not None:
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


def _redact_into(bundle: dict[str, Any], args: argparse.Namespace) -> int | None:
    if not (args.redact_profile or args.redact_profile_file):
        return None
    try:
        profile = load_profile(
            args.redact_profile,
            Path(args.redact_profile_file) if args.redact_profile_file else None,
        )
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    counts = redact_bundle(bundle, profile)
    if not bundle["redaction"]["stablePseudonyms"] and profile.users == "pseudonymize":
        print(
            "note: DELVECAT_REDACT_SALT is not set, so pseudonyms change on every build",
            file=sys.stderr,
        )
    print(f"  redaction ({profile.name}): {counts}")
    return None


def _redact(args: argparse.Namespace) -> int:
    bundle = load_bundle(Path(args.bundle))
    if (code := _redact_into(bundle, args)) is not None:
        return code
    if "redaction" not in bundle:
        print("error: redact requires --redact-profile or --redact-profile-file", file=sys.stderr)
        return 2
    problems = validate(bundle)
    if problems:
        print("bundle failed validation:", *problems[:50], sep="\n  ", file=sys.stderr)
        return 1
    files = write_bundle(bundle, Path(args.out), shard=args.shard, pretty=args.pretty)
    print(f"wrote {files[0]}")
    return 0


def _merge(args: argparse.Namespace) -> int:
    try:
        inputs = [(path, load_bundle(Path(path))) for path in args.bundles]
        previous = (
            load_bundle(Path(args.previous))
            if args.previous and Path(args.previous).exists()
            else None
        )
        generated_at = datetime.fromisoformat(args.generated_at) if args.generated_at else None
        bundle = merge_bundles(inputs, generated_at, previous)
    except (MergeError, FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if args.annotations and (code := _annotate_into(bundle, args)) is not None:
        return code
    if (code := _redact_into(bundle, args)) is not None:
        return code
    problems = validate(bundle)
    if problems:
        print("merged bundle failed validation:", *problems[:50], sep="\n  ", file=sys.stderr)
        return 1
    files = write_bundle(bundle, Path(args.out), shard=args.shard, pretty=args.pretty)
    report = next(r for r in bundle["ingestionReport"] if r["connector"] == "merge")
    print(f"  merge {report['counts']}")
    print(
        f"wrote {files[0]}: {len(bundle['entities'])} entities, {len(bundle['edges'])} edges "
        f"from {len(bundle['instances'])} instances"
    )
    return 0


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
        notes = [n for n in (report.get("message") or "").split(" | ") if n]
        if notes:
            print(*notes, sep="\n", file=sys.stderr)
        # Missing required properties are a coverage gap, not a broken annotation.
        if any(not n.startswith("objects missing required") for n in notes):
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


def _synth(args: argparse.Namespace) -> int:
    import time

    from .synth import build

    print(f"synthetic catalog, scale {args.scale}, seed {args.seed}")
    bundle = build(args.scale, args.seed)
    if args.validate:
        t = time.perf_counter()
        problems = validate(bundle)
        print(f"  validate      {time.perf_counter() - t:6.1f}s  {len(problems)} problems")
        if problems:
            print(*problems[:20], sep="\n", file=sys.stderr)
            return 1
    t = time.perf_counter()
    write_bundle(bundle, Path(args.out), shard=args.shard)
    print(f"  write         {time.perf_counter() - t:6.1f}s  {args.out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="delvecat-ingest")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="extract metadata and write a catalog bundle")
    src = b.add_mutually_exclusive_group()
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
    use = b.add_argument_group("usage and health")
    use.add_argument(
        "--no-usage",
        action="store_true",
        help="skip usage and health searches over _audit and _internal",
    )
    use.add_argument(
        "--usage-window",
        default="-30d",
        help="time range for audit usage, dashboard views, license (default -30d)",
    )
    use.add_argument(
        "--health-window",
        default="-7d",
        help="time range for scheduler and parsing checks (default -7d)",
    )

    def annotation_args(p: argparse.ArgumentParser) -> None:
        g = p.add_argument_group("annotations")
        g.add_argument("--annotations", help="directory of annotation YAML files to merge")
        g.add_argument(
            "--annotation-repo",
            help="repository URL holding the annotations, for 'suggest an edit' links",
        )
        g.add_argument("--annotation-branch", default="main")

    annotation_args(b)

    def redaction_args(p: argparse.ArgumentParser) -> None:
        g = p.add_argument_group("redaction (for publishing)")
        g.add_argument(
            "--redact-profile",
            choices=["internal", "public"],
            help="internal: drop personal names; public: also pseudonymize users, "
            "hosts and sources, mask IPs, drop internal URLs",
        )
        g.add_argument("--redact-profile-file", help="YAML profile (see redaction.py)")

    redaction_args(b)
    prod = b.add_argument_group("Splunk products")
    prod.add_argument(
        "--products",
        help="comma-separated: deploymentServer,dbConnect,stream,enterpriseSecurity; 'all' "
        "(the default without --only) or 'none'. Each is skipped when not installed.",
    )
    for kind, label, env in (
        ("soar", "Splunk SOAR", "DELVECAT_SOAR_TOKEN"),
        ("ueba", "Splunk UBA", "DELVECAT_UEBA_TOKEN"),
    ):
        g = b.add_argument_group(label)
        g.add_argument(f"--{kind}-url", help=f"{label} base URL, e.g. https://{kind}.example.com")
        g.add_argument(f"--{kind}-token-env", default=env)
        g.add_argument(f"--{kind}-fixtures", help=f"directory of recorded {label} responses")
        g.add_argument(
            f"--{kind}-instance",
            default="soar" if kind == "soar" else "uba",
            help="instance id for its objects",
        )
    b.add_argument(
        "--ueba-path",
        action="append",
        metavar="KIND=/PATH",
        help="override a UBA endpoint (dataSources, models, threatRules, "
        "outputConnectors); unverified defaults otherwise",
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

    mg = sub.add_parser("merge", help="combine bundles from several instances into one catalog")
    mg.add_argument("bundles", nargs="+", help="bundle files, manifests or directories")
    annotation_args(mg)
    redaction_args(mg)
    mg.add_argument("--previous", help="previous merged bundle, for versions and changes")
    mg.add_argument("--generated-at")
    mg.add_argument(
        "--strict",
        action="store_true",
        help="exit 3 if annotations match nothing (with --annotations)",
    )
    mg.add_argument("--out", required=True)
    mg.add_argument("--shard", action="store_true")
    mg.add_argument("--pretty", action="store_true")
    mg.set_defaults(func=_merge)

    rd = sub.add_parser("redact", help="redact an existing bundle for publishing")
    rd.add_argument("bundle", help="bundle file, manifest or directory")
    redaction_args(rd)
    rd.add_argument("--out", required=True)
    rd.add_argument("--shard", action="store_true")
    rd.add_argument("--pretty", action="store_true")
    rd.set_defaults(func=_redact)

    la = sub.add_parser("lint-annotations", help="validate annotation files")
    la.add_argument("annotations", help="annotations directory")
    la.add_argument("--bundle", help="also check that every entry matches an entity")
    la.set_defaults(func=_lint_annotations)

    sy = sub.add_parser("synth", help="generate a large synthetic catalog for performance testing")
    sy.add_argument("--scale", type=float, default=1.0, help="1.0 is about 100,000 objects")
    sy.add_argument("--seed", type=int, default=7)
    sy.add_argument("--out", required=True)
    sy.add_argument("--shard", action="store_true", help="write a manifest plus per-type shards")
    sy.add_argument("--validate", action="store_true", help="also validate against the schema")
    sy.set_defaults(func=_synth)

    lst = sub.add_parser("extractors", help="list available extractors")
    lst.set_defaults(func=lambda _: print("\n".join(splunk.EXTRACTORS)) or 0)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
