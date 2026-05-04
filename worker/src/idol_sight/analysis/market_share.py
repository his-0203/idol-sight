"""Market share computation (spec §7.2).

Cum 60% + Mom 40%. Produces dataclass rows + statement builder for
agg_market_share.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

ALPHA_CUM = 0.6
BETA_MOM = 0.4


@dataclass
class ShareRow:
    week_start: str
    week_end: str
    group_key: str
    cum: float          # cumulative share % (0-100)
    mom: float          # momentum share % (0-100)
    final: float        # weighted final %


def compute_market_share(
    *,
    week_start: str,
    week_end: str,
    groups: list[dict[str, Any]],
) -> list[ShareRow]:
    """`groups` is a list of {key, cum_score, mom_score}."""
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
