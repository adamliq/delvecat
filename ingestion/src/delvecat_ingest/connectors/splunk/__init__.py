"""Splunk platform connector (Enterprise and Cloud, via the REST API on 8089)."""

from __future__ import annotations

from collections.abc import Callable

from ...model import ExtractResult
from ...transport import EndpointForbidden, EndpointNotFound, SearchTimeout, Transport
from . import access, data, knowledge, server, usage
from .common import Ctx, Options

# An extractor returns its entity count, or (count, message) when it only partly succeeded.
Extractor = Callable[[Ctx, ExtractResult], "int | tuple[int, str]"]

# Order matters only where an extractor reads earlier results (fields uses inventory).
EXTRACTORS: dict[str, Extractor] = {
    "serverInfo": server.extract_server_info,
    "apps": access.extract_apps,
    "users": access.extract_users,
    "roles": access.extract_roles,
    "indexes": data.extract_indexes,
    "sourcetypes": knowledge.extract_sourcetype_definitions,
    "inventory": data.extract_inventory,
    "hosts": data.extract_hosts,
    "sources": data.extract_sources,
    "inputs": data.extract_inputs,
    "forwarders": data.extract_forwarders,
    "alertActions": knowledge.extract_alert_actions,
    "savedSearches": knowledge.extract_saved_searches,
    "dashboards": knowledge.extract_dashboards,
    "macros": knowledge.extract_macros,
    "eventtypes": knowledge.extract_eventtypes,
    "tags": knowledge.extract_tags,
    "fieldExtractions": knowledge.extract_field_extractions,
    "fieldAliases": knowledge.extract_field_aliases,
    "calculatedFields": knowledge.extract_calculated_fields,
    "automaticLookups": knowledge.extract_automatic_lookups,
    "transforms": knowledge.extract_transforms,
    "lookupFiles": knowledge.extract_lookup_files,
    "lookupDefinitions": knowledge.extract_lookup_definitions,
    "kvCollections": knowledge.extract_kv_collections,
    "dataModels": knowledge.extract_data_models,
    "workflowActions": knowledge.extract_workflow_actions,
    "fields": data.extract_fields,
    **usage.USAGE_EXTRACTORS,
}


def run_extractors(
    ctx: Ctx, extractors: dict[str, Extractor], prefix: str, out: ExtractResult
) -> None:
    """Run each extractor, recording ok/skipped/failed without aborting the run."""
    for name, fn in extractors.items():
        connector = f"{prefix}.{name}"
        if ctx.options.progress:
            ctx.options.progress(connector)
        try:
            result = fn(ctx, out)
            if isinstance(result, tuple):
                count, message = result
                out.reports.append(
                    {
                        "connector": connector,
                        "status": "partial",
                        "counts": {"entities": count},
                        "message": message,
                    }
                )
            else:
                out.reports.append(
                    {"connector": connector, "status": "ok", "counts": {"entities": result}}
                )
        except EndpointNotFound as exc:
            out.reports.append(
                {"connector": connector, "status": "skipped", "message": f"not available: {exc}"}
            )
        except EndpointForbidden as exc:
            out.reports.append(
                {
                    "connector": connector,
                    "status": "skipped",
                    "message": f"permission denied: {exc}",
                }
            )
        except SearchTimeout as exc:
            out.reports.append({"connector": connector, "status": "failed", "message": str(exc)})
        except Exception as exc:  # report and keep going with the other extractors
            out.reports.append(
                {
                    "connector": connector,
                    "status": "failed",
                    "message": f"{type(exc).__name__}: {exc}",
                }
            )


def extract(
    transport: Transport,
    instance: str,
    options: Options | None = None,
    only: set[str] | None = None,
) -> ExtractResult:
    ctx = Ctx(transport, instance, options or Options())
    selected = {k: v for k, v in EXTRACTORS.items() if not only or k in only}
    if not ctx.options.fields:
        selected.pop("fields", None)
    if not ctx.options.usage:
        for name in usage.USAGE_EXTRACTORS:
            selected.pop(name, None)
    out = ExtractResult()
    out.as_of = getattr(transport, "as_of", None) or usage.now_iso()
    run_extractors(ctx, selected, "splunk", out)
    return out


__all__ = ["EXTRACTORS", "Options", "extract", "run_extractors"]
