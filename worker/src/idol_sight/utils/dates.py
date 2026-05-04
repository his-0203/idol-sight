"""Defensive date parsing for crawled fields.

Real-world data from naver/dc/theqoo often has the date column polluted with
body text. We:
1. Look only at the first 30 characters (the date should always be at the start).
2. Try multiple regex patterns in order of specificity.
3. Validate the parsed (year, month, day) against the calendar — invalid
   dates return None rather than raising.
"""

from __future__ import annotations

import re
from datetime import datetime

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

WINDOW = 30


def parse_safe(s: str | None) -> datetime | None:
    """Parse the start of `s` as a date.

    Returns None on missing input, unparseable input, or invalid calendar
    components. Never raises.
    """
    if not s:
        return None
    head = s.strip()[:WINDOW]
    for pattern in DATE_PATTERNS:
        m = pattern.search(head)
        if not m:
            continue
        try:
            parts = [int(g) for g in m.groups()]
            return datetime(*parts)   # type: ignore[arg-type]
        except (ValueError, TypeError):
            continue
    return None
