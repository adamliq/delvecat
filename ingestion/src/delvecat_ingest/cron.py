"""Rough expected-run counts for cron schedules (enough to tell "should have run")."""

from __future__ import annotations

RANGES = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 6))


def _field(expr: str, lo: int, hi: int) -> set[int]:
    values: set[int] = set()
    for part in expr.split(","):
        step = 1
        if "/" in part:
            part, step_s = part.split("/", 1)
            step = int(step_s)
        if part in ("*", ""):
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(part)
            if step > 1:
                end = hi
        if start < lo or end > hi + 1 or start > end:
            raise ValueError(expr)
        values.update(range(start, end + 1, step))
    return {7 if v == 7 else v for v in values}


def runs_per_day(cron: str | None) -> float | None:
    """Average scheduled runs per day, or None if the expression is not understood."""
    if not cron:
        return None
    parts = cron.split()
    if len(parts) != 5:
        return None
    try:
        minute, hour, dom, month, dow = (
            _field(p, lo, hi) for p, (lo, hi) in zip(parts, RANGES, strict=True)
        )
    except ValueError:
        return None
    dow = {0 if d == 7 else d for d in dow}
    day_fraction = 1.0
    restricted_dom, restricted_dow = parts[2] != "*", parts[4] != "*"
    if restricted_dom and restricted_dow:  # cron ORs them
        day_fraction = min(1.0, len(dom) / 30.4 + len(dow) / 7)
    elif restricted_dom:
        day_fraction = len(dom) / 30.4
    elif restricted_dow:
        day_fraction = len(dow) / 7
    return len(minute) * len(hour) * day_fraction * len(month) / 12
