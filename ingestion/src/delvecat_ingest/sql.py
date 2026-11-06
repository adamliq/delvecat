"""Find table names in SQL (good enough for lineage; not a SQL parser)."""

from __future__ import annotations

import re

_STRING = re.compile(r"'(?:[^']|'')*'")
_COMMENT = re.compile(r"--[^\n]*|/\*.*?\*/", re.S)
_TABLE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE)\s+((?:[\w$#]+|\"[^\"]+\"|`[^`]+`|\[[^\]]+\])"
    r"(?:\s*\.\s*(?:[\w$#]+|\"[^\"]+\"|`[^`]+`|\[[^\]]+\]))*)",
    re.I,
)
_CTE = re.compile(r"\b(?:WITH|,)\s*([\w$#]+)\s+AS\s*\(", re.I)


def tables(sql: str | None) -> list[str]:
    """Tables referenced by FROM / JOIN / INTO / UPDATE, in order, without CTE names."""
    if not sql:
        return []
    text = _STRING.sub("''", _COMMENT.sub(" ", sql))
    ctes = {m.group(1).lower() for m in _CTE.finditer(text)}
    found: list[str] = []
    for m in _TABLE.finditer(text):
        name = re.sub(r"\s*\.\s*", ".", m.group(1))
        name = re.sub(r'["`\[\]]', "", name)
        if name.lower() in ctes or name.lower() in ("dual", "select", "lateral"):
            continue
        if name not in found:
            found.append(name)
    return found
