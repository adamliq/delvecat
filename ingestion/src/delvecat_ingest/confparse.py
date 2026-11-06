"""Minimal Splunk .conf reader (stanzas, key = value, backslash continuations, comments)."""

from __future__ import annotations

from pathlib import Path


def parse_conf(text: str) -> dict[str, dict[str, str]]:
    stanzas: dict[str, dict[str, str]] = {"default": {}}
    current = stanzas["default"]
    pending = ""
    for raw in text.splitlines():
        line = pending + raw.strip()
        pending = ""
        if line.endswith("\\"):
            pending = line[:-1] + "\n"
            continue
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = stanzas.setdefault(line[1:-1].strip(), {})
        elif "=" in line:
            key, _, value = line.partition("=")
            current[key.strip()] = value.strip()
    return stanzas


def read_app_conf(app_dir: Path, name: str) -> dict[str, dict[str, str]]:
    """Merge ``default/<name>.conf`` then ``local/<name>.conf`` the way Splunk layers them."""
    merged: dict[str, dict[str, str]] = {}
    for layer in ("default", "local"):
        file = app_dir / layer / f"{name}.conf"
        if file.is_file():
            for stanza, keys in parse_conf(
                file.read_text(encoding="utf-8", errors="replace")
            ).items():
                merged.setdefault(stanza, {}).update(keys)
    return {k: v for k, v in merged.items() if v or k != "default"}
