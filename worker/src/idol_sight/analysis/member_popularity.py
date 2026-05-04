"""Member popularity + HHI (spec §7.3)."""

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
    if total == 0:
        return MemberPopulation(
            group_key=group_key, members=rows,
            hhi=None, evenness=None, status="insufficient",
        )

    shares = [(r.composite_score / total * 100.0) for r in rows]
    hhi = sum(s * s for s in shares) / 10000.0
    evenness = 1.0 - hhi
    return MemberPopulation(
        group_key=group_key, members=rows,
        hhi=round(hhi, 4), evenness=round(evenness, 4), status="ok",
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
        INSERT INTO agg_member_pop_meta(group_key, snapshot_at, hhi, evenness, status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
          hhi=excluded.hhi, evenness=excluded.evenness, status=excluded.status
        """.strip(),
        [pop.group_key, snapshot_at, pop.hhi, pop.evenness, pop.status],
    ))
    return out
