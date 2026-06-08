"""Defensive date parsing for crawled fields.

Real-world data from naver/dc/theqoo often has the date column polluted with
body text or rendered as a Korean relative timestamp. We:
1. Look only at the first 30 characters (the date should always be at the start).
2. Try absolute-format patterns first (most specific).
3. Fall back to Korean relative-time patterns ("X시간 전", "어제").
4. Validate parsed components against the calendar — invalid → None, never raise.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

DATE_PATTERNS = [
    # Most specific first: ISO with time
    re.compile(r"(\d{4})-(\d{2})-(\d{2})[\sT](\d{2}):(\d{2})"),
    # Korean dot format with time
    re.compile(r"(\d{4})\.(\d{1,2})\.(\d{1,2})\.?\s+(\d{1,2}):(\d{1,2})"),
    # Korean dot format date-only
    re.compile(r"(\d{4})\.(\d{1,2})\.(\d{1,2})\.?"),
    # Slash format
    re.compile(r"(\d{4})/(\d{1,2})/(\d{1,2})"),
    # ISO date-only
    re.compile(r"(\d{4})-(\d{2})-(\d{2})"),
]

# Korean relative-time patterns. Order matters — more specific first.
RELATIVE_PATTERNS: list[tuple[re.Pattern[str], object]] = [
    (re.compile(r"(\d+)\s*초\s*전"),   lambda m: timedelta(seconds=int(m.group(1)))),
    (re.compile(r"(\d+)\s*분\s*전"),   lambda m: timedelta(minutes=int(m.group(1)))),
    (re.compile(r"(\d+)\s*시간\s*전"), lambda m: timedelta(hours=int(m.group(1)))),
    (re.compile(r"(\d+)\s*일\s*전"),   lambda m: timedelta(days=int(m.group(1)))),
    (re.compile(r"(\d+)\s*주\s*전"),   lambda m: timedelta(weeks=int(m.group(1)))),
    (re.compile(r"방금|just now",      re.IGNORECASE), lambda m: timedelta(seconds=0)),
    (re.compile(r"오늘"),               lambda m: timedelta(days=0)),
    (re.compile(r"어제"),               lambda m: timedelta(days=1)),
    (re.compile(r"그제|그저께"),        lambda m: timedelta(days=2)),
]

WINDOW = 30


def kst_to_utc(dt: datetime | None) -> datetime | None:
    """Convert a naive **KST** datetime to naive **UTC** (subtract 9h).

    Korean community sites (DC/theqoo/instiz) render absolute post times in KST,
    which ``parse_safe`` returns as a naive datetime. The DB contract is UTC (the
    frontend's ``formatKST`` adds +9h for display), so collectors must convert
    KST→UTC before storing — otherwise a 14:04 KST post is stored as 14:04Z and
    displayed as 23:04 KST (9h late)."""
    return dt - timedelta(hours=9) if dt is not None else None


def parse_safe(s: str | None, *, now: datetime | None = None) -> datetime | None:
    """Parse the start of `s` as a date.

    Returns None on missing input, unparseable input, or invalid calendar
    components. Never raises.

    `now` is the reference point for relative-time parsing — defaults to
    `datetime.now()`. Pass an explicit value in tests for stable assertions.
    """
    if not s:
        return None
    head = s.strip()[:WINDOW]

    # Absolute formats (year present)
    for pattern in DATE_PATTERNS:
        m = pattern.search(head)
        if not m:
            continue
        try:
            parts = [int(g) for g in m.groups()]
            return datetime(*parts)   # type: ignore[arg-type]
        except (ValueError, TypeError):
            continue

    # Relative Korean phrases — fall back, anchored to `now`
    base = now or datetime.now()
    for pattern, delta_fn in RELATIVE_PATTERNS:
        m = pattern.search(head)
        if not m:
            continue
        try:
            return base - delta_fn(m)   # type: ignore[operator]
        except (ValueError, TypeError):
            continue

    return None
