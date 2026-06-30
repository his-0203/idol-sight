"""Re-arbitrate already-stored naver_articles after the anchor-gate fix.

``naver_articles`` keeps only the article title (no snippet), so this
backfill re-evaluates each stored title against *every* active group via
:class:`NewsFilter` and re-owns the row to the highest-scoring relevant
group. This repairs rows that leaked into the wrong group's PR/리스크
feed back when the news filter matched on bare substrings (a "버추얼"
mention dragging a BTHD article into ISEDOL).

Pure over its inputs (rows + group configs) so it's unit-testable; the
CLI wrapper supplies rows from D1 and batches the resulting UPDATEs.

Ownership rule, per row:
  - Evaluate the title against all groups.
  - Among groups that find it relevant, pick the highest ``match_score``.
    Ties prefer the current owner, then a stable group order — so a
    genuine round-up doesn't flip-flop on re-runs.
  - If no group can anchor it, keep the current owner but mark it
    excluded (with the current group's exclude reason).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

from idol_sight.analysis.news_filter import NewsFilter
from idol_sight.config import GroupConfig


@dataclass(frozen=True)
class BackfillUpdate:
    url_hash: str
    group_key: str
    is_excluded: int
    reason: str | None
    match_score: int


def rearbitrate(
    rows: Iterable[Mapping[str, object]],
    groups: Sequence[GroupConfig],
) -> list[BackfillUpdate]:
    filters = [(g, NewsFilter(g)) for g in groups]

    updates: list[BackfillUpdate] = []
    for row in rows:
        url_hash = str(row["url_hash"])
        title = str(row.get("title") or "")
        published_at = str(row.get("published_at") or "")
        current_key = str(row.get("group_key") or "")

        best: tuple[tuple[int, bool, int], str, int] | None = None
        current_reason: str | None = None

        for idx, (group, filt) in enumerate(filters):
            verdict = filt.evaluate(
                title=title, snippet="", published_at=published_at)
            if group.key == current_key and not verdict.relevant:
                current_reason = verdict.reason
            if not verdict.relevant:
                continue
            # Rank: score desc, then current-owner, then stable order.
            rank = (verdict.score, group.key == current_key, -idx)
            if best is None or rank > best[0]:
                best = (rank, group.key, verdict.score)

        if best is not None:
            updates.append(
                BackfillUpdate(url_hash, best[1], 0, None, best[2]))
        else:
            updates.append(
                BackfillUpdate(url_hash, current_key, 1, current_reason, 0))

    return updates
