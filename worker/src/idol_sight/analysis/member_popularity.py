"""Member popularity + HHI (spec §7.3 — V2.5 normalized).

Analytics Reporter §A-3 caught a structural bug in the v1 evenness
metric: with N members evenly distributed, HHI = N · (1/N)² = 1/N,
so evenness = 1 - 1/N depends on N. Five-member groups topped out at
0.8, ten-member at 0.9 — meaning "evenness=0.85" meant different
things across PLAVE (5) and STELLIVE (10).

V2.5 introduces a *normalized* HHI:

  HHI_norm = (HHI - 1/N) / (1 - 1/N)

This rescales [1/N, 1] → [0, 1], so 0 = perfectly even, 1 = total
domination, regardless of N. ``evenness`` then = 1 - HHI_norm and is
directly comparable across group sizes.

We keep the raw HHI as ``hhi`` (frontend modal still references it)
and add ``hhi_norm`` and ``top1_share`` / ``top3_share`` (Pareto
ratios) for the more intuitive UI labels Analytics Reporter
recommended.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class MemberRow:
    name: str
    yt_score: float
    community_score: float
    composite_score: float
    yt_videos: int
    yt_avg_views: int
    yt_sufficient: bool
    community_mentions: int


@dataclass
class MemberPopulation:
    group_key: str
    members: list[MemberRow]
    hhi: float | None
    evenness: float | None
    status: str        # 'ok' | 'insufficient'
    # V2.5 additions — non-breaking. Older callers ignore these.
    hhi_norm: float | None = None
    top1_share: float | None = None
    top3_share: float | None = None


def compute_member_popularity(
    *,
    group_key: str,
    members: list[dict[str, Any]],
) -> MemberPopulation:
    rows: list[MemberRow] = []
    for m in members:
        composite = m["yt_score"] * 0.5 + m["community_score"] * 0.5
        rows.append(MemberRow(
            name=m["name"],
            yt_score=m["yt_score"], community_score=m["community_score"],
            composite_score=composite,
            yt_videos=m.get("yt_videos", 0),
            yt_avg_views=m.get("yt_avg_views", 0),
            yt_sufficient=bool(m.get("yt_sufficient", False)),
            community_mentions=m.get("community_mentions", 0),
        ))

    total = sum(r.composite_score for r in rows)
    n = len(rows)
    if total == 0 or n == 0:
        return MemberPopulation(
            group_key=group_key, members=rows,
            hhi=None, evenness=None, status="insufficient",
        )

    shares_pct = [(r.composite_score / total * 100.0) for r in rows]
    hhi = sum(s * s for s in shares_pct) / 10000.0   # [1/N, 1]

    # V2.5: normalized HHI — rescale [1/N, 1] → [0, 1] so size-N
    # comparison is fair. Single-member group has no distribution to
    # measure → leave hhi_norm at None.
    if n > 1:
        floor = 1.0 / n
        hhi_norm = max((hhi - floor) / (1.0 - floor), 0.0)
        evenness = 1.0 - hhi_norm
    else:
        hhi_norm = None
        evenness = None

    # Pareto ratios — more intuitive for UI labels.
    sorted_shares = sorted(shares_pct, reverse=True)
    top1 = sorted_shares[0] / 100.0
    top3 = sum(sorted_shares[:3]) / 100.0

    return MemberPopulation(
        group_key=group_key, members=rows,
        hhi=round(hhi, 4),
        evenness=round(evenness, 4) if evenness is not None else None,
        status="ok",
        hhi_norm=round(hhi_norm, 4) if hhi_norm is not None else None,
        top1_share=round(top1, 4),
        top3_share=round(top3, 4),
    )


def to_statements(
    pop: MemberPopulation,
    *,
    snapshot_at: str,
    member_id_lookup: dict[str, int],
) -> list[tuple[str, list]]:
    out: list[tuple[str, list]] = []
    for r in pop.members:
        member_id = member_id_lookup.get(r.name)
        if member_id is None:
            continue
        out.append((
            """
            INSERT INTO agg_member_popularity
              (group_key, snapshot_at, member_id,
               yt_score, community_score, composite_score,
               yt_videos, yt_avg_views, yt_sufficient, community_mentions)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(group_key, snapshot_at, member_id) DO UPDATE SET
              yt_score=excluded.yt_score,
              community_score=excluded.community_score,
              composite_score=excluded.composite_score,
              yt_videos=excluded.yt_videos,
              yt_avg_views=excluded.yt_avg_views,
              yt_sufficient=excluded.yt_sufficient,
              community_mentions=excluded.community_mentions
            """.strip(),
            [pop.group_key, snapshot_at, member_id,
             r.yt_score, r.community_score, r.composite_score,
             r.yt_videos, r.yt_avg_views, 1 if r.yt_sufficient else 0,
             r.community_mentions],
        ))

    out.append((
        """
        INSERT INTO agg_member_pop_meta(
          group_key, snapshot_at, hhi, evenness, status,
          hhi_norm, top1_share, top3_share)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
          hhi=excluded.hhi, evenness=excluded.evenness, status=excluded.status,
          hhi_norm=excluded.hhi_norm,
          top1_share=excluded.top1_share,
          top3_share=excluded.top3_share
        """.strip(),
        [pop.group_key, snapshot_at, pop.hhi, pop.evenness, pop.status,
         pop.hhi_norm, pop.top1_share, pop.top3_share],
    ))
    return out
