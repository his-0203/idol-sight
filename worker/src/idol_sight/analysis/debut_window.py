"""Debut window organicity — organic vs paid-viral classifier for YouTube
videos uploaded in the ±60 day window around each group's debut date.

See docs/superpowers/specs/2026-05-12-debut-window-organicity-design.md for
the algorithm rationale, signal weights, and verdict thresholds.
"""

from __future__ import annotations

# (label, days_lo_inclusive, days_hi_inclusive). Ranges are non-overlapping
# and contiguous from -60 (60 days before debut) to +60.
WINDOW_BUCKETS: list[tuple[str, int, int]] = [
    ("D-60",  -60, -31),
    ("D-30",  -30,  -2),
    ("D-Day",  -1,   1),
    ("D+30",   2,  30),
    ("D+60",  31,  60),
]


def bucket_for(days_relative: int) -> str | None:
    """Map a signed day offset to its bucket label, or None if out of window.

    ``days_relative`` is days from debut: negative = before, positive = after.
    """
    for label, lo, hi in WINDOW_BUCKETS:
        if lo <= days_relative <= hi:
            return label
    return None
