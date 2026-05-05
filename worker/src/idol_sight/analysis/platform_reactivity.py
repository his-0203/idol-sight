"""Cross-platform reactivity per group.

For each viral video (``viral_velocity_ratio ≥ VIRAL_THRESHOLD``)
published in the last ``WINDOW_DAYS``, we count posts/articles on each
community platform within ±24h of the video's ``published_at`` and
report the ratio ``after / before`` averaged across the group's viral
videos.

Interpretation:

  > 2.0   strong reactive — that platform's fandom traffic is
          driven by YouTube comebacks (the platform "wakes up" when
          the group releases something).
  1.5–2.0 reactive
  ~1.0    independent — the platform has a steady tempo not tied to
          comebacks (year-round fandom chatter, dating drama, etc.).
  < 0.7   declining — fewer posts after a release than before, which
          suggests the comeback didn't engage that audience.

We need at least one viral video to compute a meaningful number; with
zero viral videos the field stays at the default 1.0 and the
``reactivity_sample`` column reports 0 so the UI can mark the cell
"insufficient data".
"""

from __future__ import annotations

from typing import Any, Protocol

VIRAL_THRESHOLD = 2.0     # viral_velocity_ratio cutoff
WINDOW_DAYS = 30          # window of viral videos we look back
WINDOW_HOURS = 24         # before/after window per video

PLATFORM_LABELS = ("dc", "theqoo", "instiz")


class _Executor(Protocol):
    def execute(
        self, sql: str, params: list[Any] | None = ...,
    ) -> list[dict[str, Any]]: ...


def compute_reactivity(
    client: _Executor, *, snapshot_at: str,
) -> list[tuple[str, list[Any]]]:
    """Return D1 UPDATE statements for ``agg_summary`` keyed on
    ``(group_key, snapshot_at)``. We update an existing row in place
    rather than inserting — agg_summary upsert already happened
    earlier in the analyse cycle.
    """
    groups = client.execute(
        "SELECT key FROM groups WHERE is_active=1"
    )
    statements: list[tuple[str, list[Any]]] = []

    for g in groups:
        gk = g["key"]
        viral_videos = client.execute(
            "SELECT video_id, published_at, viral_velocity_ratio "
            "FROM youtube_videos "
            "WHERE group_key=? "
            "  AND viral_velocity_ratio IS NOT NULL "
            "  AND viral_velocity_ratio >= ? "
            "  AND published_at >= datetime('now', ?) ",
            [gk, VIRAL_THRESHOLD, f"-{WINDOW_DAYS} days"],
        )
        if not viral_videos:
            statements.append((
                "UPDATE agg_summary SET "
                "  reactivity_dc=1.0, reactivity_theqoo=1.0, "
                "  reactivity_instiz=1.0, reactivity_naver=1.0, "
                "  reactivity_sample=0 "
                "WHERE group_key=? AND snapshot_at=?",
                [gk, snapshot_at],
            ))
            continue

        # Per-platform running totals across the group's viral videos.
        ratios = {p: [] for p in (*PLATFORM_LABELS, "naver")}

        for v in viral_videos:
            pa = v.get("published_at")
            if not pa:
                continue
            # Community posts before/after.
            for platform in PLATFORM_LABELS:
                before, after = _window_counts(
                    client,
                    table="community_posts",
                    where_extra="AND platform=?",
                    where_params=[platform],
                    group_key=gk,
                    pivot_iso=pa,
                    time_col="posted_at",
                )
                if before is not None and after is not None:
                    ratio = _ratio(before, after)
                    if ratio is not None:
                        ratios[platform].append(ratio)
            # Naver articles before/after (relevant only).
            before_n, after_n = _window_counts(
                client,
                table="naver_articles",
                where_extra="AND COALESCE(is_excluded,0)=0",
                where_params=[],
                group_key=gk,
                pivot_iso=pa,
                time_col="published_at",
            )
            if before_n is not None and after_n is not None:
                ratio = _ratio(before_n, after_n)
                if ratio is not None:
                    ratios["naver"].append(ratio)

        def _avg(vals: list[float]) -> float:
            return round(sum(vals) / len(vals), 3) if vals else 1.0

        statements.append((
            "UPDATE agg_summary SET "
            "  reactivity_dc=?, reactivity_theqoo=?, "
            "  reactivity_instiz=?, reactivity_naver=?, "
            "  reactivity_sample=? "
            "WHERE group_key=? AND snapshot_at=?",
            [
                _avg(ratios["dc"]),
                _avg(ratios["theqoo"]),
                _avg(ratios["instiz"]),
                _avg(ratios["naver"]),
                len(viral_videos),
                gk, snapshot_at,
            ],
        ))
    return statements


def _window_counts(
    client: _Executor,
    *,
    table: str,
    where_extra: str,
    where_params: list[Any],
    group_key: str,
    pivot_iso: str,
    time_col: str,
) -> tuple[int | None, int | None]:
    """Count rows in [pivot - 24h, pivot) and [pivot, pivot + 24h]."""
    sql = (
        f"SELECT "
        f"  SUM(CASE WHEN {time_col} >= datetime(?, '-{WINDOW_HOURS} hours') "
        f"           AND {time_col} <  ? THEN 1 ELSE 0 END) AS before_n, "
        f"  SUM(CASE WHEN {time_col} >= ? "
        f"           AND {time_col} <  datetime(?, '+{WINDOW_HOURS} hours') "
        f"           THEN 1 ELSE 0 END) AS after_n "
        f"FROM {table} "
        f"WHERE group_key=? {where_extra}"
    )
    params: list[Any] = [
        pivot_iso, pivot_iso, pivot_iso, pivot_iso, group_key,
        *where_params,
    ]
    rows = client.execute(sql, params)
    if not rows:
        return (0, 0)
    r = rows[0]
    return (int(r.get("before_n") or 0), int(r.get("after_n") or 0))


def _ratio(before: int, after: int) -> float | None:
    """after / before, with a small floor on the denominator so a
    truly inactive 'before' window doesn't blow up to inf — the floor
    means "we didn't see meaningful activity before, so a ratio of
    1.0 is the most we want to report."
    """
    if before == 0 and after == 0:
        return None  # no signal at all → exclude from average
    if before == 0:
        # New activity post-comeback with no prior baseline. Cap at 5×
        # so a single unmoderated baseline doesn't dominate the mean.
        return min(5.0, after / 1.0)
    return min(after / before, 5.0)


__all__ = [
    "PLATFORM_LABELS",
    "VIRAL_THRESHOLD",
    "WINDOW_DAYS",
    "WINDOW_HOURS",
    "compute_reactivity",
]
