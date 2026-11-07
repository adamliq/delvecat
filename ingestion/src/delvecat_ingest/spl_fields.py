"""Field-level lineage from SPL: which fields a search reads from its data, how
it uses them, and which source fields each of its output columns comes from.

Like :mod:`spl`, this is a forgiving best-effort walk of the pipeline, run on
SPL whose macros are already expanded. It tracks the fields the pipeline
creates (``eval``, ``rename``, ``stats`` outputs, ``lookup`` outputs, ``rex``
groups...) so later references to them are traced back to the source fields
they were made from instead of being reported as source fields themselves.

Output columns are reported only when the pipeline ends in a known shape (a
``stats``/``table``/``fields`` and what follows). A command it does not
understand that may change the shape of the results (``xyseries``,
``foreach``, ``map``...) makes the outputs unknown rather than wrong.

Known limits: wildcards (``table src*``) are skipped; ``spath`` and automatic
key-value extraction create fields nobody declares, so their names are taken
at face value; ``eval`` functions that take field names as strings
(``mvzip("a", ...)``) are not followed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .spl import _subsearches, _tokens, _unquote, split_top

# Fields that are about where events come from, not what they hold.
META = frozenset(
    {
        "index",
        "sourcetype",
        "eventtype",
        "tag",
        "earliest",
        "latest",
        "splunk_server",
        "splunk_server_group",
        "linecount",
        "punct",
        "timestartpos",
        "timeendpos",
        "starttime",
        "endtime",
        "savedsearch_name",
        "search_name",
        "nodename",
    }
)

KEYWORDS = frozenset({"and", "or", "not", "xor", "like", "in", "true", "false", "null", "as", "by"})

# How a source field is used.
HOWS = (
    "filter",
    "groupBy",
    "aggregate",
    "eval",
    "rename",
    "lookup",
    "extract",
    "enrich",
    "join",
    "dedup",
    "sort",
    "select",
    "output",
)

GENERATING_SOURCES = {
    "inputlookup": "lookup",
    "inputcsv": "lookup",
    "datamodel": "datamodel",
    "pivot": "datamodel",
    "savedsearch": "search",
    "loadjob": "search",
    "makeresults": "other",
    "rest": "other",
    "metadata": "other",
    "metasearch": "events",
    "eventcount": "other",
    "dbinspect": "other",
    "dbxquery": "database",
    "mstats": "metrics",
    "mcatalog": "metrics",
    "gentimes": "other",
}

# Commands after which only the fields they output exist.
TRANSFORMING = frozenset(
    {"stats", "chart", "timechart", "top", "rare", "sistats", "sichart", "sitimechart", "tstats"}
)
# Commands whose output shape we do not model.
OPAQUE = frozenset(
    {
        "xyseries",
        "untable",
        "transpose",
        "foreach",
        "map",
        "contingency",
        "associate",
        "correlate",
        "fieldsummary",
        "analyzefields",
        "kvform",
        "extract",
        "kv",
        "xmlkv",
        "multikv",
        "autoregress",
        "predict",
        "cluster",
        "kmeans",
        "anomalydetection",
        "fit",
        "apply",
        "addinfo",
        "addtotals",
        "addcoltotals",
        "appendpipe",
        "selfjoin",
        "set",
    }
)

_STATS_OPTIONS = re.compile(
    r"(?i)(?<![\w.(])(span|limit|useother|usenull|partial|allnum|delim|bins|minspan|start|end"
    r"|aligntime|cont|fixedrange|format|sep|agg|dedup_splitvals|otherstr|nullstr|showcount"
    r"|showperc|countfield|percentfield|summariesonly|allow_old_summaries|prestats|local|append"
    r"|chunk_size|fillnull_value|max_events|window|global|current|reset_on_change|reset_before"
    r"|reset_after|time_window|by_prefix|instance_field|timeformat)\s*=\s*(\"[^\"]*\"|\S+)"
)
_AGG = re.compile(
    r"([A-Za-z_][\w]*)\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)"
    r"(?:\s+as\s+(\"[^\"]+\"|'[^']+'|[^\s,]+))?"
    r"|(?<![\w.])(count|c)(?![\w(])(?:\s+as\s+(\"[^\"]+\"|'[^']+'|[^\s,]+))?",
    re.I,
)
_IDENT = re.compile(
    r"'([^']+)'|\"(?:[^\"\\]|\\.)*\"|\$[^$]*\$|(?<![\w.$])([A-Za-z_][\w.:]*)(\s*\()?"
)
_NAMED_GROUP = re.compile(r"\(\?P?<([A-Za-z_]\w*)>")
_AS_PAIR = re.compile(r"(\"[^\"]+\"|'[^']+'|[^\s,]+)\s+as\s+(\"[^\"]+\"|'[^']+'|[^\s,]+)", re.I)
_COMPARE = ("<", ">", "<=", ">=", "==")
_TERM_FIELD = re.compile(r"^([A-Za-z_][\w.:]*?)(::|!=|<=|>=|==|=|<|>)(.*)$", re.S)
# Aggregations whose result does not reveal the values they were computed from.
COUNT_LIKE = frozenset({"count", "c", "dc", "distinct_count", "estdc", "estdc_error"})
# An eval that only hashes: the result does not reveal the values either.
_HASHED = re.compile(r"(?i)^\s*(md5|sha1|sha256|sha512)\s*\(.*\)\s*$", re.S)
_BY = re.compile(r"(?i)\s+(?:by|over)\s+")


@dataclass
class FieldAnalysis:
    source: str = "events"  # events | datamodel | lookup | search | database | metrics | other
    used: dict[str, set[str]] = field(default_factory=dict)  # source field -> hows
    outputs: dict[str, set[str]] | None = None  # output column -> source fields
    masked: set[str] = field(default_factory=set)  # output columns that hide source values

    def merge(self, other: FieldAnalysis) -> None:
        for name, hows in other.used.items():
            self.used.setdefault(name, set()).update(hows)
        self.outputs = None

    def to_json(self) -> dict:
        out: dict = {
            "source": self.source,
            "used": [
                {"name": n, "how": [h for h in HOWS if h in self.used[n]]}
                for n in sorted(self.used, key=str.lower)
            ],
        }
        if self.outputs is not None:
            out["outputs"] = [
                {
                    "name": n,
                    "from": sorted(srcs, key=str.lower),
                    **({"masked": True} if n in self.masked and srcs else {}),
                }
                for n, srcs in self.outputs.items()
            ]
        return out


def _clean(name: str) -> str:
    name = name.strip()
    if len(name) >= 2 and name[0] == name[-1] and name[0] in "\"'":
        name = name[1:-1]
    return name


def _names(args: str) -> list[str]:
    """Field names from a comma / space separated list, without wildcards or options."""
    out = []
    for part in re.split(r"[,\s]+", args.strip()):
        part = _clean(part)
        if part and "=" not in part and "*" not in part and part not in ("+", "-"):
            out.append(part)
    return out


class _Pipeline:
    def __init__(self, out: FieldAnalysis):
        self.out = out
        self.env: dict[str, set[str]] = {}  # fields the pipeline created -> source fields
        self.closed = False  # only fields in env exist (after a transforming command)
        self.projected = False  # env is exactly the set of result columns
        self.opaque = False  # result shape unknown from here on
        # Fields whose values do not carry their source values (counts, hashes).
        self.masked: set[str] = set()

    # -- references --------------------------------------------------------------------
    def ref(self, raw: str, how: str) -> set[str]:
        name = _clean(raw)
        if not name or "$" in name or "*" in name:
            return set()
        if name in self.env:
            return set(self.env[name])
        if self.closed or self.opaque:
            return set()
        if name in META or name.startswith("_") or name.lower().startswith("tag::"):
            return set()
        self.out.used.setdefault(name, set()).add(how)
        return {name}

    def refs(self, names: list[str], how: str) -> set[str]:
        srcs: set[str] = set()
        for n in names:
            srcs |= self.ref(n, how)
        return srcs

    def expression(self, expr: str, how: str) -> set[str]:
        srcs: set[str] = set()
        for m in _IDENT.finditer(expr):
            quoted, name, call = m.group(1), m.group(2), m.group(3)
            if quoted:
                srcs |= self.ref(quoted, how)
            elif name and not call and name.lower() not in KEYWORDS:
                srcs |= self.ref(name, how)
        return srcs

    def set(self, name: str, srcs: set[str], masked: bool = False) -> None:
        name = _clean(name)
        if name and "*" not in name:
            self.env[name] = set(srcs)
            if masked:
                self.masked.add(name)
            else:
                self.masked.discard(name)

    def reset(self, columns: dict[str, set[str]], masked: set[str] | None = None) -> None:
        self.env = columns
        self.masked = {m for m in (masked or set()) if m in columns}
        self.closed = True
        self.projected = True

    def make_opaque(self) -> None:
        self.masked = set()
        self.opaque = True
        self.projected = False
        self.closed = True
        self.env = {}

    # -- search terms ------------------------------------------------------------------
    def terms(self, clause: str) -> None:
        tokens = _tokens(clause)
        for i, tok in enumerate(tokens):
            nxt = tokens[i + 1] if i + 1 < len(tokens) else ""
            if nxt in _COMPARE or nxt.upper() == "IN":
                self.ref(tok, "filter")
                continue
            m = _TERM_FIELD.match(tok)
            if m and m.group(2) != "::":
                self.ref(m.group(1), "filter")


def _stats(p: _Pipeline, name: str, args: str) -> None:
    args = _STATS_OPTIONS.sub(" ", args)
    if name == "tstats":
        args = re.sub(r"(?i)\bfrom\s+(datamodel|nodename)\s*=\s*\S+", " ", args)
        args = re.sub(r"(?i)\bfrom\s+\S+", " ", args)
        m = re.search(r"(?i)\bwhere\b(.*?)(?=\s+by\s+|$)", args, re.S)
        if m:
            p.terms(m.group(1))
            args = args[: m.start()] + " " + args[m.end() :]
    parts = _BY.split(args, maxsplit=2)
    aggs, by = parts[0], " ".join(parts[1:])
    columns: dict[str, set[str]] = {}
    masked: set[str] = set()
    transforming = name in TRANSFORMING
    if name in ("top", "rare"):
        fields = _names(aggs)
        for f in fields:
            columns[f] = p.ref(f, "groupBy")
        columns["count"], columns["percent"] = set(), set()
    else:
        for m in _AGG.finditer(aggs):
            if m.group(1):
                func, inner, alias = m.group(1), m.group(2), m.group(3)
                srcs = p.expression(inner, "aggregate")
                col = _clean(alias) if alias else f"{func}({inner.strip()})"
                columns[col] = srcs
                if func.lower() in COUNT_LIKE:
                    masked.add(col)
            else:
                alias = m.group(5)
                columns[_clean(alias) if alias else m.group(4)] = set()
    for f in _names(by):
        if f in p.masked:
            masked.add(f)
        columns[f] = p.ref(f, "groupBy")
    if name == "timechart":
        columns.setdefault("_time", set())
    if transforming:
        p.reset(columns, masked)
    else:  # eventstats / streamstats add columns to every event
        for k, v in columns.items():
            p.set(k, v, masked=k in masked)


def _lookup(p: _Pipeline, args: str) -> None:
    args = re.sub(r"(?i)\b(local|update|event_time_field)\s*=\s*\S+", " ", args)
    parts = re.split(r"(?i)\s+(?:output|outputnew)\s+", args, maxsplit=1)
    inputs = parts[0].strip().split(None, 1)
    srcs: set[str] = set()
    if len(inputs) > 1:
        rest = inputs[1]
        paired = {m.group(0) for m in _AS_PAIR.finditer(rest)}
        for m in _AS_PAIR.finditer(rest):
            srcs |= p.ref(m.group(2), "lookup")
        for pair in paired:
            rest = rest.replace(pair, " ")
        for f in _names(rest):
            srcs |= p.ref(f, "lookup")
    if len(parts) > 1:
        out = parts[1]
        paired = list(_AS_PAIR.finditer(out))
        for m in paired:
            p.set(m.group(2), srcs)
            out = out.replace(m.group(0), " ")
        for f in _names(out):
            p.set(f, srcs)


def _command(p: _Pipeline, name: str, args: str, sub_outputs: list[set[str]]) -> None:
    opts = dict(
        (k.lower(), _unquote(v))
        for k, v in re.findall(r"(?<![\w.])([A-Za-z_]\w*)\s*=\s*(\"[^\"]*\"|[^\s,]+)", args)
    )
    if name in ("search", "where"):
        if name == "where":
            p.expression(args, "filter")
        else:
            p.terms(args)
        for cols in sub_outputs:
            p.refs(sorted(cols), "filter")
    elif name in TRANSFORMING or name in ("eventstats", "streamstats"):
        _stats(p, name, args)
    elif name in ("eval", "fieldformat"):
        for assignment in split_top(args, ","):
            m = re.match(r"\s*(\"[^\"]+\"|'[^']+'|[^\s=]+)\s*=(?!=)(.*)$", assignment, re.S)
            if not m:
                continue
            srcs = p.expression(m.group(2), "eval")
            if name == "eval":
                p.set(m.group(1), srcs, masked=bool(_HASHED.match(m.group(2))))
    elif name == "rename":
        for m in _AS_PAIR.finditer(args):
            old, new = _clean(m.group(1)), m.group(2)
            was_masked = old in p.masked
            srcs = p.ref(old, "rename")
            p.set(new, srcs, masked=was_masked)
            p.env.pop(old, None)
            p.masked.discard(old)
    elif name in ("table", "fields"):
        body = args.strip()
        if name == "fields" and body.startswith("-"):
            for f in _names(body[1:]):
                p.env.pop(f, None)
            return
        if name == "fields" and body.startswith("+"):
            body = body[1:]
        if "*" in body:  # a wildcard keeps fields we cannot list
            for f in _names(body):
                p.ref(f, "select")
            p.projected = False
            return
        columns = {f: p.ref(f, "select") for f in _names(body)}
        p.reset(columns, {f for f in columns if f in p.masked})
    elif name == "lookup":
        _lookup(p, args)
    elif name == "rex":
        target = opts.get("field", "_raw")
        srcs = p.ref(target, "extract")
        if opts.get("mode") != "sed":
            for g in _NAMED_GROUP.findall(args):
                p.set(g, srcs)
    elif name == "regex":
        m = re.match(r"\s*([A-Za-z_][\w.]*)\s*!?=", args)
        p.ref(m.group(1) if m else "_raw", "filter")
    elif name == "spath":
        srcs = p.ref(opts.get("input", "_raw"), "extract")
        if "output" in opts:
            p.set(opts["output"], srcs)
    elif name == "iplocation":
        rest = _STATS_OPTIONS.sub(
            " ", re.sub(r"(?i)\b(prefix|allfields|lang)\s*=\s*\S+", " ", args)
        )
        names = _names(rest)
        if names:
            srcs = p.ref(names[-1], "enrich")
            prefix = opts.get("prefix", "")
            for f in ("City", "Country", "Region", "lat", "lon"):
                p.set(prefix + f, srcs)
    elif name in ("bin", "bucket", "discretize"):
        body = _STATS_OPTIONS.sub(" ", args)
        m = _AS_PAIR.search(body)
        if m:
            p.set(m.group(2), p.ref(m.group(1), "eval"))
        else:
            for f in _names(body):
                p.set(f, p.ref(f, "eval"))
    elif name == "convert":
        for m in re.finditer(r"\w+\(([^)]+)\)(?:\s+as\s+(\S+))?", args, re.I):
            srcs = p.ref(m.group(1), "eval")
            p.set(m.group(2) or m.group(1), srcs)
    elif name in ("makemv", "mvexpand", "nomv", "mvcombine", "fillnull", "filldown"):
        body = re.sub(r"(?i)\b\w+\s*=\s*(\"[^\"]*\"|\S+)", " ", args)
        for f in _names(body):
            p.ref(f, "eval")
    elif name == "dedup":
        parts = re.split(r"(?i)\bsortby\b", args, maxsplit=1)
        body = re.sub(r"(?i)\b\w+\s*=\s*\S+", " ", parts[0])
        p.refs([f for f in _names(body) if not f.isdigit()], "dedup")
        if len(parts) > 1:
            p.refs(_names(re.sub(r"[+\-]|\b(auto|str|ip|num)\(|\)", " ", parts[1])), "sort")
    elif name == "sort":
        body = re.sub(r"(?i)\blimit\s*=\s*\S+|\b(auto|str|ip|num)\(|\)|\bd(esc)?\s*$", " ", args)
        p.refs(
            [f for f in _names(body.replace("+", " ").replace("-", " ")) if not f.isdigit()], "sort"
        )
    elif name == "join":
        body = re.sub(r"(?i)\b\w+\s*=\s*\S+", " ", args)
        p.refs(_names(body), "join")
        p.projected = False
    elif name in ("append", "appendcols", "union", "multisearch"):
        p.projected = False
    elif name in OPAQUE:
        p.make_opaque()
    # Everything else (head, tail, collect, outputlookup, sendemail, ...) keeps the fields.


def analyze_fields(spl: str) -> FieldAnalysis:
    """Analyze macro-expanded SPL (subsearches included)."""
    out = _analyze(spl)
    for col, srcs in (out.outputs or {}).items():
        if srcs == {col} and col not in out.masked:  # a source field passed through
            out.used[col].add("output")
    return out


def _analyze(spl: str) -> FieldAnalysis:
    out = FieldAnalysis()
    if spl and spl.strip():
        _pipeline(spl, out)
    return out


def _pipeline(spl: str, out: FieldAnalysis) -> None:
    text = spl.strip()
    starts_with_pipe = text.startswith("|")
    p = _Pipeline(out)
    for n, segment in enumerate(split_top(text[1:] if starts_with_pipe else text, "|")):
        body, subs = _subsearches(segment)
        sub_outputs: list[set[str]] = []
        for sub in subs:
            sa = _analyze(sub)
            if sa.source in ("events", "datamodel"):
                for f, hows in sa.used.items():
                    out.used.setdefault(f, set()).update(hows)
            if sa.outputs is not None:
                sub_outputs.append(set(sa.outputs))
        stripped = body.strip()
        if not stripped:
            continue
        first, _, rest = stripped.partition(" ")
        name = first.lower()
        if n == 0:
            if not starts_with_pipe:
                p.terms(rest if name == "search" else stripped)
                for cols in sub_outputs:
                    p.refs(sorted(cols), "filter")
                continue
            if name == "from":
                kind = rest.strip().split(":", 1)[0].lower()
                out.source = {
                    "datamodel": "datamodel",
                    "lookup": "lookup",
                    "inputlookup": "lookup",
                }.get(kind, "search")
                continue
            if name == "tstats":
                out.source = "datamodel" if re.search(r"(?i)datamodel\s*=", rest) else "events"
            elif name in GENERATING_SOURCES:
                out.source = GENERATING_SOURCES[name]
                if name in ("inputlookup", "inputcsv"):
                    where = re.split(r"(?i)\bwhere\b", rest, maxsplit=1)
                    if len(where) > 1:
                        p.expression(where[1], "filter")
                continue
        _command(p, name, rest, sub_outputs)
    if p.projected and not p.opaque:
        out.outputs = {k: v for k, v in p.env.items()}
        out.masked = set(p.masked)
