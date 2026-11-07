"""A small, forgiving SPL analyzer that finds what a search reads, writes and uses.

It does not validate SPL. It walks the pipeline (including ``[subsearches]``),
expands macros when given a resolver, and reports references to catalogued
objects: indexes, sourcetypes, eventtypes, tags, macros, lookups, data models
and saved searches.

Known limits: ``map search="..."`` strings and dynamically built searches are
not followed; dashboard tokens (``$tok$``) are reported as dynamic.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .sql import tables as _sql_tables

if TYPE_CHECKING:
    from .spl_fields import FieldAnalysis

MAX_MACRO_DEPTH = 10

# (edge type, target type, name, is wildcard pattern)
Reference = tuple[str, str, str, bool]


@dataclass
class SplAnalysis:
    refs: set[Reference] = field(default_factory=set)
    macros: list[str] = field(default_factory=list)  # macros used directly (resolved names)
    unresolved_macros: list[str] = field(default_factory=list)
    implicit_index: bool = False  # a base search without an index constraint
    dynamic: bool = False  # contains $tokens$
    warnings: list[str] = field(default_factory=list)
    fields: FieldAnalysis | None = None  # field-level lineage

    def merge(self, other: SplAnalysis) -> None:
        if other.fields is not None:
            if self.fields is None:
                self.fields = other.fields
            else:
                if self.fields.source != other.fields.source and other.fields.source == "events":
                    self.fields.source = "events"
                self.fields.merge(other.fields)
        self.refs |= other.refs
        for m in other.unresolved_macros:
            if m not in self.unresolved_macros:
                self.unresolved_macros.append(m)
        self.implicit_index |= other.implicit_index
        self.dynamic |= other.dynamic
        self.warnings.extend(w for w in other.warnings if w not in self.warnings)


# --- scanning helpers -------------------------------------------------------------------


def _scan(s: str):
    """Yield (index, char, depth) for characters outside quotes and backticks.

    ``depth`` counts open () and [] so callers can find top-level separators.
    """
    depth = 0
    quote = None
    i = 0
    while i < len(s):
        c = s[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in ('"', "`"):
            quote = c
            i += 1
            continue
        if c in "([":
            yield i, c, depth
            depth += 1
        elif c in ")]":
            depth = max(0, depth - 1)
            yield i, c, depth
        else:
            yield i, c, depth
        i += 1


def split_top(s: str, sep: str) -> list[str]:
    """Split on ``sep`` outside quotes, backticks, parentheses and brackets."""
    parts, start = [], 0
    for i, c, depth in _scan(s):
        if c == sep and depth == 0:
            parts.append(s[start:i])
            start = i + 1
    parts.append(s[start:])
    return parts


def _subsearches(s: str) -> tuple[str, list[str]]:
    """Remove top-level ``[ ... ]`` groups; return the remaining text and their contents."""
    out, subs = [], []
    start = None
    last = 0
    for i, c, depth in _scan(s):
        if c == "[" and depth == 0:
            start = i
        elif c == "]" and depth == 0 and start is not None:
            out.append(s[last:start])
            subs.append(s[start + 1 : i])
            last = i + 1
            start = None
    out.append(s[last:])
    return " ".join(out), subs


def _unquote(v: str) -> str:
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] == '"':
        return v[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return v


# --- macro expansion ----------------------------------------------------------------------

MacroResolver = Callable[[str], "tuple[str, list[str]] | None"]
"""Given a macro name such as ``"rare_port_threshold(1)"``, return (definition, arg names)."""

_MACRO_CALL = re.compile(r"^\s*([\w.:-]+)\s*(?:\((.*)\))?\s*$", re.S)


def _macro_spans(s: str) -> list[tuple[int, int]]:
    """Positions of `...` macro calls outside double quotes."""
    spans, quote, start = [], False, None
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and quote:
            i += 2
            continue
        if c == '"' and start is None:
            quote = not quote
        elif c == "`" and not quote:
            if start is None:
                start = i
            else:
                spans.append((start, i))
                start = None
        i += 1
    return spans


_COMMENT = re.compile(r"```.*?```", re.S)


def strip_comments(spl: str) -> str:
    """Remove SPL comments (```like this```)."""
    return _COMMENT.sub(" ", spl)


def expand_macros(
    spl: str, resolve: MacroResolver | None, depth: int = 0
) -> tuple[str, list[str], list[str]]:
    """Expand `macro` and `macro(args)` calls.

    Returns (expanded SPL, macros used at this level, unresolved macros at any level).
    Unresolved macros are replaced by a space so the rest still parses.
    """
    used: list[str] = []
    unresolved: list[str] = []
    spl = strip_comments(spl)
    if depth > MAX_MACRO_DEPTH:
        return spl, used, ["(macro nesting too deep)"]
    out, last = [], 0
    for start, end in _macro_spans(spl):
        out.append(spl[last:start])
        last = end + 1
        call = spl[start + 1 : end]
        if "$" in call:  # macro name or args built from tokens: only known at run time
            out.append(" $dynamic$ ")
            continue
        m = _MACRO_CALL.match(call)
        if not m:
            unresolved.append(spl[start + 1 : end])
            out.append(" ")
            continue
        name, raw_args = m.group(1), m.group(2)
        args = [a.strip() for a in split_top(raw_args, ",")] if raw_args is not None else []
        if raw_args is not None and raw_args.strip() == "":
            args = []
        full = f"{name}({len(args)})" if args else name
        used.append(full)
        found = resolve(full) if resolve else None
        if not found:
            unresolved.append(full)
            out.append(" ")
            continue
        definition, arg_names = found
        for arg_name, value in zip(arg_names, args, strict=False):
            definition = definition.replace(f"${arg_name}$", _unquote(value))
        inner, _, inner_unresolved = expand_macros(definition, resolve, depth + 1)
        unresolved.extend(u for u in inner_unresolved if u not in unresolved)
        out.append(f" {inner} ")
    out.append(spl[last:])
    return "".join(out), used, unresolved


# --- search terms ---------------------------------------------------------------------------


def _tokens(s: str) -> list[str]:
    """Split a search clause into terms, parentheses and quoted strings.

    Whitespace around ``=`` and ``!=`` is removed first, so ``index = web`` works.
    """
    compact, quote = [], False
    i = 0
    while i < len(s):
        c = s[i]
        if c == '"' and (i == 0 or s[i - 1] != "\\"):
            quote = not quote
        if not quote and c.isspace():
            j = i
            while j < len(s) and s[j].isspace():
                j += 1
            prev = compact[-1] if compact else ""
            nxt = s[j] if j < len(s) else ""
            if prev in ("=",) or nxt == "=" or (nxt == "!" and s[j : j + 2] == "!="):
                i = j
                continue
            compact.append(" ")
            i = j
            continue
        compact.append(c)
        i += 1
    text = "".join(compact)
    tokens, cur, quote = [], [], False
    for i, c in enumerate(text):
        if c == '"' and (i == 0 or text[i - 1] != "\\"):
            quote = not quote
            cur.append(c)
        elif not quote and c in "()":
            if cur:
                tokens.append("".join(cur))
                cur = []
            tokens.append(c)
        elif not quote and c.isspace():
            if cur:
                tokens.append("".join(cur))
                cur = []
        else:
            cur.append(c)
    if cur:
        tokens.append("".join(cur))
    return tokens


_TERM = re.compile(r"^([A-Za-z_][\w.]*)(::|!=|=)(.*)$", re.S)

# search-term key → (edge type, target type)
_TERM_TARGETS = {
    "index": ("reads", "index"),
    "sourcetype": ("reads", "sourcetype"),
    "eventtype": ("uses", "eventtype"),
    "tag": ("uses", "tag"),
}


def _search_terms(clause: str, out: SplAnalysis) -> bool:
    """Collect references from search terms; return True if a positive index term exists."""
    tokens = _tokens(clause)
    has_index = False
    group_neg = [False]
    negate_next = False
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        upper = tok.upper()
        if upper == "NOT":
            negate_next = not negate_next
        elif tok == "(":
            group_neg.append(group_neg[-1] ^ negate_next)
            negate_next = False
        elif tok == ")":
            if len(group_neg) > 1:
                group_neg.pop()
        elif upper in ("OR", "AND"):
            pass
        elif (
            i + 2 < len(tokens) and tokens[i + 1].upper() == "IN" and tokens[i + 2] == "("
        ):  # key IN (a, b)
            key = tok.lower()
            values, j = [], i + 3
            while j < len(tokens) and tokens[j] != ")":
                values.extend(v for v in tokens[j].split(",") if v)
                j += 1
            negated = group_neg[-1] ^ negate_next
            negate_next = False
            if key in _TERM_TARGETS and not negated:
                for v in values:
                    has_index |= _add_term(key, v, out)
            i = j
        else:
            m = _TERM.match(tok)
            negated = group_neg[-1] ^ negate_next
            negate_next = False
            if m and not negated and m.group(2) != "!=":
                key, op, value = m.group(1).lower(), m.group(2), m.group(3)
                if op == "::" and key == "tag":  # tag::<field>=<tag>
                    _, _, value = value.partition("=")
                elif op == "::" and key not in ("index", "sourcetype", "eventtype"):
                    key = ""
                if key in _TERM_TARGETS:
                    has_index |= _add_term(key, value, out)
        i += 1
    return has_index


def _add_term(key: str, raw: str, out: SplAnalysis) -> bool:
    value = _unquote(raw)
    if not value:
        return False
    if "$" in value:
        out.dynamic = True
        return key == "index"
    edge_type, target = _TERM_TARGETS[key]
    out.refs.add((edge_type, target, value, any(c in value for c in "*?")))
    return key == "index"


# --- commands -----------------------------------------------------------------------------

GENERATING = {
    "tstats",
    "mstats",
    "metadata",
    "metasearch",
    "inputlookup",
    "inputcsv",
    "makeresults",
    "rest",
    "datamodel",
    "pivot",
    "from",
    "savedsearch",
    "loadjob",
    "dbinspect",
    "eventcount",
    "dbxquery",
    "mcatalog",
    "gentimes",
    "union",
    "multisearch",
    "set",
    "search",
}


def _positional(args: str) -> list[str]:
    """Arguments that are not ``key=value`` options."""
    return [_unquote(t) for t in _tokens(args) if "=" not in t and t not in ("(", ")")]


def _options(args: str) -> dict[str, str]:
    opts = {}
    for t in _tokens(args):
        m = _TERM.match(t)
        if m and m.group(2) == "=":
            opts[m.group(1).lower()] = _unquote(m.group(3))
    return opts


_DATAMODEL_ARG = re.compile(r"datamodel\s*[=:]\s*\"?([\w-]+)", re.I)
_FROM_ARG = re.compile(r"^\s*(datamodel|lookup|inputlookup|savedsearch)\s*:\s*\"?([^\s\"|]+)", re.I)


def _command(name: str, args: str, out: SplAnalysis) -> None:
    def ref(edge: str, target: str, value: str | None) -> None:
        if not value:
            return
        if "$" in value:
            out.dynamic = True
            return
        out.refs.add((edge, target, value, False))

    if name == "search":
        _search_terms(args, out)
    elif name in ("tstats", "mstats", "metadata", "metasearch", "eventcount", "dbinspect"):
        _search_terms(re.sub(r"(?i)\b(from|by|groupby)\b.*?(?=\bwhere\b|$)", " ", args), out)
        for m in _DATAMODEL_ARG.finditer(args):
            ref("reads", "dataModel", m.group(1).split(".")[0])
        if name == "metadata" or name == "eventcount":
            for k, v in _options(args).items():
                if k == "index":
                    ref("reads", "index", v)
    elif name in ("datamodel", "pivot"):
        pos = _positional(args)
        ref("reads", "dataModel", pos[0] if pos else None)
    elif name == "from":
        m = _FROM_ARG.match(args)
        if m:
            kind, value = m.group(1).lower(), m.group(2)
            if kind == "datamodel":
                ref("reads", "dataModel", value.split(".")[0])
            elif kind in ("lookup", "inputlookup"):
                ref("reads", "lookup", value)
            else:
                ref("reads", "savedSearch", value)
    elif name == "lookup":
        pos = _positional(args)
        ref("uses", "lookup", pos[0] if pos else None)
    elif name == "inputlookup":
        pos = _positional(re.split(r"(?i)\bwhere\b", args)[0])
        ref("reads", "lookup", pos[0] if pos else None)
    elif name == "outputlookup":
        pos = _positional(args)
        ref("writes", "lookup", pos[0] if pos else None)
    elif name in ("collect", "mcollect"):
        ref(
            "writes",
            "index",
            _options(args).get("index") or ("summary" if name == "collect" else None),
        )
    elif name == "dbxquery":
        opts = _options(args)
        conn = opts.get("connection")
        ref("uses", "dbConnection", conn)
        if conn and "$" not in conn:
            for t in [opts["table"]] if opts.get("table") else _sql_tables(opts.get("query")):
                ref("reads", "externalTable", f"{conn}/{t}")
    elif name == "dbxoutput":
        ref("writes", "dbOutput", _options(args).get("output"))
    elif name == "dbxlookup":
        ref("uses", "dbLookup", _options(args).get("lookup"))
    elif name == "savedsearch":
        pos = _positional(args)
        ref("reads", "savedSearch", pos[0] if pos else None)
    elif name == "loadjob":
        spec = _options(args).get("savedsearch")
        if spec:
            ref("reads", "savedSearch", spec.split(":")[-1])


def analyze(
    spl: str | None,
    resolve_macro: MacroResolver | None = None,
    *,
    fragment: bool = False,
) -> SplAnalysis:
    """Analyze an SPL string.

    ``fragment`` marks SPL that is not a complete search (macro bodies, eventtype
    searches, data model constraints, dashboard post-process searches): a missing
    index there is expected and is not reported.
    """
    out = SplAnalysis()
    if not spl or not spl.strip():
        return out
    expanded, used, unresolved = expand_macros(spl, resolve_macro)
    out.macros = list(dict.fromkeys(used))
    for m in used:
        out.refs.add(("uses", "macro", m, False))
    out.unresolved_macros = list(dict.fromkeys(unresolved))
    if "$dynamic$" in expanded:
        out.dynamic = True
        expanded = expanded.replace("$dynamic$", " ")
    _analyze_pipeline(expanded, out, fragment=fragment)
    from .spl_fields import analyze_fields  # imports helpers from this module

    out.fields = analyze_fields(expanded)
    return out


def _analyze_pipeline(spl: str, out: SplAnalysis, *, fragment: bool) -> None:
    text = spl.strip()
    starts_with_pipe = text.startswith("|")
    segments = split_top(text[1:] if starts_with_pipe else text, "|")
    for n, segment in enumerate(segments):
        body, subs = _subsearches(segment)
        for sub in subs:
            _analyze_pipeline(sub, out, fragment=False)
        stripped = body.strip()
        if not stripped:
            continue
        first, _, rest = stripped.partition(" ")
        name = first.lower()
        if n == 0 and not starts_with_pipe:
            # A base search: "search" is optional.
            clause = rest if name == "search" else stripped
            has_index = _search_terms(clause, out)
            uses_knowledge = any(r[1] in ("eventtype", "tag") for r in out.refs)
            if not has_index and not fragment and not uses_knowledge and not out.dynamic:
                out.implicit_index = True
        else:
            _command(name, rest, out)
