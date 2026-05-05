"""Share of Voice computation (spec §7.2 — V2 reformulation).

What used to be called "Market Share" was really *Share of Voice* (SOV)
— the share of the cohort's measured cross-platform attention, not the
share of the actual K-pop market (which has a defined denominator like
Circle Chart). The previous formula summed raw counts across signals
(yt_views + dc_posts + naver*100 …) which let a single 99%-weighted
signal (yt_views) dominate everything; PLAVE's reported 51% was largely
an artifact of that, not a reflection of real attention split.

V2 normalizes each signal independently before mixing them so that no
one source can dominate. Each component is converted to a unit-less
[0, 1] cohort rank (linear-interpolated percentile across the active
groups), then weighted, then re-normalized to a 0–100 share. Cumulative
and momentum components stay separate so the BI can show both
"long-term standing" and "this-week motion".

Input shape (per group):
  - yt_views, comm_total, news, twitter (cumulative window)
  - delta_yt_views, delta_comm, delta_news (this-week motion)

Weights (sum = 1.0):
  yt_views 30%, comm 25%, news 20%, subscribers 15%, twitter 10%

Output dataclass field names stay ``cum``/``mom``/``final`` so
downstream code (agg_market_share table, frontend) keeps working —
``ShareRow`` is now interpreted as SOV rather than market share.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

ALPHA_CUM = 0.6
BETA_MOM = 0.4

# Cohort-relative weights for the SOV mix. They must sum to 1.0.
SOV_WEIGHTS = {
    "yt_views":   0.30,
    "community":  0.25,
    "news":       0.20,
    "subscribers": 0.15,
    "twitter":    0.10,
}
assert abs(sum(SOV_WEIGHTS.values()) - 1.0) < 1e-9


def _percentile_rank(values: list[float]) -> list[float]:
    """Linear percentile rank in [0, 1] preserving input order.

    Tied values get the average of their ranks (so 5 zeros all map to
    the same fraction). Returns a list aligned to ``values``. Empty list
    → empty list. Single value → [1.0] (it's the cohort's only point).
    """
    n = len(values)
    if n == 0:
        return []
    if n == 1:
        return [1.0]
    indexed = sorted(range(n), key=lambda i: values[i])
    ranks = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[indexed[j + 1]] == values[indexed[i]]:
            j += 1
        # Average rank for the tie group, normalized so max → 1.0.
        avg_rank = (i + j) / 2.0
        for k in range(i, j + 1):
            ranks[indexed[k]] = avg_rank / (n - 1) if n > 1 else 1.0
        i = j + 1
    return ranks


def _compose_score(group_ranks: dict[str, float]) -> float:
    """Weighted sum of the 5 normalized cohort ranks → cohort SOV [0,1]."""
    return sum(SOV_WEIGHTS[k] * group_ranks.get(k, 0.0) for k in SOV_WEIGHTS)


@dataclass
class ShareRow:
    week_start: str
    week_end: str
    group_key: str
    cum: float          # cumulative SOV share % (0-100)
    mom: float          # momentum SOV share % (0-100)
    final: float        # weighted final SOV share %


def compute_market_share(
    *,
    week_start: str,
    week_end: str,
    groups: list[dict[str, Any]],
) -> list[ShareRow]:
    """Compute SOV per group from cohort-relative percentile ranks.

    ``groups`` accepts two shapes for backwards compatibility:

    1. New (preferred): each item carries the raw cohort signals
       (yt_views, comm_total, news, subscribers, twitter,
       delta_yt_views, delta_comm, delta_news). The function computes
       per-signal percentile ranks across the cohort and mixes them per
       SOV_WEIGHTS.

    2. Legacy: items only carry ``cum_score``/``mom_score`` (single
       numbers). In that case we fall back to the v1 raw-sum
       normalization so existing tests keep passing.
    """
    if not groups:
        return []

    has_signals = any("yt_views" in g for g in groups)
    if has_signals:
        return _compute_sov(week_start, week_end, groups)
    return _compute_legacy(week_start, week_end, groups)


def _compute_sov(
    week_start: str, week_end: str, groups: list[dict[str, Any]],
) -> list[ShareRow]:
    keys = [g["key"] for g in groups]
    # Cumulative ranks
    cum_signal = {
        "yt_views":   [float(g.get("yt_views", 0) or 0) for g in groups],
        "community":  [float(g.get("comm_total", 0) or 0) for g in groups],
        "news":       [float(g.get("news", 0) or 0) for g in groups],
        "subscribers": [float(g.get("subscribers", 0) or 0) for g in groups],
        "twitter":    [float(g.get("twitter", 0) or 0) for g in groups],
    }
    cum_ranks = {sig: _percentile_rank(vals) for sig, vals in cum_signal.items()}

    # Momentum: delta of the high-volume signals only (yt/community/news).
    # Twitter/subscribers don't deliver useful weekly deltas yet — we'd be
    # comparing two snapshots that may both be empty.
    mom_signal = {
        "yt_views":   [max(float(g.get("delta_yt_views", 0) or 0), 0.0) for g in groups],
        "community":  [max(float(g.get("delta_comm", 0) or 0), 0.0) for g in groups],
        "news":       [max(float(g.get("delta_news", 0) or 0), 0.0) for g in groups],
        "subscribers": [0.0] * len(groups),
        "twitter":    [0.0] * len(groups),
    }
    mom_ranks = {sig: _percentile_rank(vals) for sig, vals in mom_signal.items()}

    # Per-group cohort score, then re-normalize to a 0-100 share so the
    # cohort sums to 100% (zero-sum SOV).
    cum_scores = []
    mom_scores = []
    for i, _ in enumerate(keys):
        cum_scores.append(_compose_score({sig: cum_ranks[sig][i] for sig in SOV_WEIGHTS}))
        mom_scores.append(_compose_score({sig: mom_ranks[sig][i] for sig in SOV_WEIGHTS}))

    cum_total = sum(cum_scores) or 0.0
    mom_total = sum(mom_scores) or 0.0

    rows: list[ShareRow] = []
    for i, k in enumerate(keys):
        cum_pct = (cum_scores[i] / cum_total * 100.0) if cum_total > 0 else 0.0
        mom_pct = (mom_scores[i] / mom_total * 100.0) if mom_total > 0 else 0.0
        final = cum_pct * ALPHA_CUM + mom_pct * BETA_MOM
        rows.append(ShareRow(
            week_start=week_start, week_end=week_end, group_key=k,
            cum=round(cum_pct, 2), mom=round(mom_pct, 2),
            final=round(final, 2),
        ))
    return rows


def _compute_legacy(
    week_start: str, week_end: str, groups: list[dict[str, Any]],
) -> list[ShareRow]:
    cum_total = sum(g.get("cum_score", 0) for g in groups) or 0
    mom_total = sum(g.get("mom_score", 0) for g in groups) or 0

    rows: list[ShareRow] = []
    for g in groups:
        cum_pct = (g.get("cum_score", 0) / cum_total * 100.0) if cum_total > 0 else 0.0
        mom_pct = (g.get("mom_score", 0) / mom_total * 100.0) if mom_total > 0 else 0.0
        final = cum_pct * ALPHA_CUM + mom_pct * BETA_MOM
        rows.append(ShareRow(
            week_start=week_start, week_end=week_end,
            group_key=g["key"],
            cum=round(cum_pct, 2), mom=round(mom_pct, 2),
            final=round(final, 2),
        ))
    return rows


def to_statements(rows: list[ShareRow], *, market_total: int) -> list[tuple[str, list]]:
    """Convert rows to D1 INSERT statements for agg_market_share."""
    out: list[tuple[str, list]] = []
    for r in rows:
        out.append((
            """
            INSERT INTO agg_market_share
              (week_start, week_end, group_key, cum, mom, final, market_total)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(week_start, group_key) DO UPDATE SET
              week_end=excluded.week_end,
              cum=excluded.cum, mom=excluded.mom, final=excluded.final,
              market_total=excluded.market_total
            """.strip(),
            [r.week_start, r.week_end, r.group_key,
             r.cum, r.mom, r.final, market_total],
        ))
    return out
