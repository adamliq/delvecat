"""Ask Splunk's own SPL parser about searches Licoryx Delvecat's analyser cannot follow.

Before lineage is derived, every search is analysed once. Those that come back with a
parse failure or macros the catalog cannot resolve (not visible, defined elsewhere) are
sent, up to a limit, to ``search/parser`` in the search's own app: Splunk parses the
search there, read-only, without running it, and expands its macros. Lineage then
analyses Splunk's version of the search instead (``lineage.parsedBySplunk``).
"""

from __future__ import annotations

from typing import Any

from .lineage import MacroLibrary, _spl_sources
from .spl import analyze

# Entity key holding {original SPL: Splunk's expanded SPL}; read and removed by derive().
PARSED_KEY = "_parsedSpl"


def needs_parser(spl: str, resolver: Any) -> bool:
    a = analyze(spl, resolver)
    return bool(a.unresolved_macros) or any("could not parse" in w for w in a.warnings)


def splunk_spl(parsed: dict[str, Any]) -> str | None:
    """The search as Splunk parsed it: each command with its (macro-expanded) arguments."""
    parts = []
    for c in parsed.get("commands") or []:
        if not isinstance(c, dict) or not c.get("command"):
            continue
        args = c.get("rawargs")
        parts.append(f"{c['command']} {args}".strip() if isinstance(args, str) else c["command"])
    if not parts:
        return None
    text = " | ".join(parts)
    return text if parts[0].startswith("search") else f"| {text}"


def parser_assist(transport: Any, entities: list[dict[str, Any]], limit: int = 200) -> dict:
    """Record Splunk's parse of the searches the analyser cannot follow; returns counts."""
    parse = getattr(transport, "parse_spl", None)
    if parse is None or limit <= 0:
        return {"tried": 0, "parsed": 0}
    macros = MacroLibrary(entities)
    tried = parsed = 0
    for e in entities:
        sources = [(spl, label) for spl, fragment, label in _spl_sources(e) if spl and not fragment]
        if not sources:
            continue
        app = e.get("app") or "search"
        owner = e.get("owner") if e.get("sharing") == "user" else None
        for spl, _ in sources:
            if tried >= limit:
                return {"tried": tried, "parsed": parsed, "limited": True}
            if "$" in spl or not needs_parser(spl, macros.resolver(app, owner)):
                continue  # dashboard tokens: Splunk cannot parse them either
            tried += 1
            try:
                body = parse(app, spl)
            except Exception:  # noqa: BLE001 - a parser failure only means no help
                body = None
            text = splunk_spl(body) if body else None
            if text:
                e.setdefault(PARSED_KEY, {})[spl] = text
                parsed += 1
    return {"tried": tried, "parsed": parsed}
