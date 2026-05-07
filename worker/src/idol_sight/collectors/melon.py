"""Melon TOP 100 daily chart collector.

Fetches the SSR-rendered chart page at /chart/day/index.htm, parses 100
rows of (rank, song_id, song_title, artist_names), then matches each row
against our seeded groups. The lowest rank number a group charts at is
the **peak**; that peak gets UPSERTed into agg_summary.melon_top100_peak
on the latest snapshot.

Why daily (not realtime / weekly):
- Realtime updates every minute → noise + bot-detection load.
- Weekly chart lag would mask same-week debut entries.
- Daily strikes the balance: stable enough to dedup, fresh enough to
  surface a comeback within a day.

Match strategy:
- group's `name`, `name_kr`, and `aliases` are checked against each row's
  artist string with case-folded substring match (Korean names are typically
  exact). 1차 정확도 위주, false-positive 최소화 — collab 케이스에서
  artist 문자열 안에 우리 그룹 이름이 부분 포함되면 잡음.
- 아티스트 이름이 멤버명만 적혀있는 솔로 발매 케이스는 잡지 않음
  (그룹 단위 ritual 시그널이라는 의미).

Like HanteoCollector, this one is `collect_global` only — per-group
fan-out doesn't fit since one HTTP fetch covers all 100 ranks.
"""

from __future__ import annotations

import html as html_mod
import logging
import re
from collections.abc import Callable
from time import perf_counter
from typing import Any

from scrapling import Fetcher

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

log = logging.getLogger(__name__)

CHART_URL = "https://www.melon.com/chart/day/index.htm"

# Per-row HTML structure (live as of 2026-05-07):
#   <tr class="lst50|lst100" data-song-no="<song_id>">
#     ...
#     <span class="rank ">N</span>
#     ...
#     <div class="ellipsis rank01"><span><a ... title="<song_title> 재생">...</a></span></div>
#     <div class="ellipsis rank02">
#       <a href="/artist/detail.htm?..." title="<ARTIST> - 페이지 이동">...</a>
#       (collab → multiple anchors)
#     </div>
#   </tr>
_ROW_RE = re.compile(
    r'<tr class="lst(?:50|100)"[^>]*data-song-no="(?P<song_id>\d+)"[^>]*>'
    r'(?P<body>.*?)</tr>',
    re.DOTALL,
)
_RANK_RE = re.compile(r'<span class="rank\s*">(\d+)</span>')
_SONG_TITLE_RE = re.compile(
    r'<div class="ellipsis rank01">.*?title="(?P<title>[^"]+?)\s*재생"',
    re.DOTALL,
)
# Artist anchors live inside rank02. We collect every "X - 페이지 이동" title.
_ARTIST_BLOCK_RE = re.compile(
    r'<div class="ellipsis rank02">(?P<block>.*?)</div>',
    re.DOTALL,
)
_ARTIST_TITLE_RE = re.compile(
    r'title="(?P<artist>[^"]+?)\s*-\s*페이지\s*이동"',
)


def _decode(s: str) -> str:
    """HTML entity (&nbsp; 등) decode + 공백 압축."""
    s = html_mod.unescape(s)
    s = s.replace(" ", " ")          # nbsp
    return re.sub(r"\s+", " ", s).strip()


def parse_chart_html(html: str) -> list[dict[str, Any]]:
    """Parse melon TOP 100 SSR HTML → list of row dicts.

    Returns ``[]`` on empty / malformed input. Each entry:
        {"rank": int, "song_id": str, "song_title": str, "artists": [str, ...]}
    """
    if not html:
        return []
    out: list[dict[str, Any]] = []
    for m in _ROW_RE.finditer(html):
        body = m.group("body")
        rank_m = _RANK_RE.search(body)
        title_m = _SONG_TITLE_RE.search(body)
        artist_block_m = _ARTIST_BLOCK_RE.search(body)
        if not (rank_m and title_m and artist_block_m):
            continue
        artists = [
            _decode(am.group("artist"))
            for am in _ARTIST_TITLE_RE.finditer(artist_block_m.group("block"))
        ]
        out.append({
            "rank": int(rank_m.group(1)),
            "song_id": m.group("song_id"),
            "song_title": _decode(title_m.group("title")),
            "artists": artists,
        })
    return out


def _row_matches_group(row: dict[str, Any], group: dict[str, Any]) -> bool:
    """case-folded substring match against any artist anchor in the row."""
    candidates = [group.get("name"), group.get("name_kr")]
    candidates.extend(group.get("aliases") or [])
    candidates = [c for c in candidates if c and len(c) >= 2]
    haystack = " ".join(row["artists"]).casefold()
    return any(c.casefold() in haystack for c in candidates)


class MelonChartCollector:
    source = "melon"

    def __init__(
        self,
        fetcher: Any | None = None,
        groups_loader: Callable[[], list[dict]] | None = None,
    ):
        self._fetcher = fetcher or Fetcher
        # Returns [{"key": "plave", "name": "PLAVE", "name_kr": "플레이브",
        #           "aliases": ["..."]}, ...].
        self._groups_loader = groups_loader or (lambda: [])

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        # Per-group fan-out is a no-op — one HTTP fetch covers everything.
        return CollectionResult(0, 0)

    def collect_global(self) -> CollectionResult:
        started = perf_counter()
        seeded = self._groups_loader()
        if not seeded:
            return CollectionResult(0, 0, errors=["no_groups_seeded"])

        html = self._fetch_html(CHART_URL)
        if not html:
            return CollectionResult(0, 0, errors=["chart_unreachable"])

        rows = parse_chart_html(html)
        if not rows:
            return CollectionResult(0, 0, errors=["chart_empty_or_unparseable"])

        # Lowest rank wins per group (best peak).
        peak_by_key: dict[str, int] = {}
        for row in rows:
            for g in seeded:
                if not _row_matches_group(row, g):
                    continue
                key = g["key"]
                cur = peak_by_key.get(key)
                if cur is None or row["rank"] < cur:
                    peak_by_key[key] = row["rank"]

        statements: list[tuple[str, list[Any]]] = []
        for key, peak in peak_by_key.items():
            # Update the latest agg_summary row. agg_summary is daily,
            # built by build-agg-summary; we attach the chart peak to the
            # most recent snapshot. If there is no row yet (rare — only on
            # first-ever boot), this UPDATE becomes a no-op which is fine.
            statements.append((
                "UPDATE agg_summary SET melon_top100_peak = ? "
                "WHERE group_key = ? AND snapshot_at = ("
                "  SELECT MAX(snapshot_at) FROM agg_summary "
                "  WHERE group_key = ?)",
                [peak, key, key],
            ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(statements),
            rows_updated=0,
            statements=statements,
            runtime_ms=runtime_ms,
        )

    # ─── helpers ─────────────────────────────────────────────────

    def _fetch_html(self, url: str) -> str | None:
        try:
            page = self._fetcher.get(
                url, impersonate="chrome131", stealthy_headers=True,
            )
        except Exception as e:                              # noqa: BLE001
            log.warning("melon fetch failed %s: %s", url, e)
            return None
        for attr in ("html_content", "body", "raw_html", "html"):
            v = getattr(page, attr, None)
            if isinstance(v, str) and v.strip():
                return v
        return None
