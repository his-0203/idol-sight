"""Melon TOP 100 chart collector (V2.19 — realtime + daily union).

Fetches both the realtime chart (/chart/index.htm) and the daily chart
(/chart/day/index.htm), parses each into rows of
(rank, song_id, song_title, artist_names), matches each row against our
seeded groups, then per group:

  peak  = min(rank)                across the union
  depth = count(distinct song_id)  across the union (dedup by song_id)

Both signals are UPDATEd onto the latest agg_summary row in a single
statement per group.

Why two charts (V2.19, replaces V2.18 daily-only):
- Daily alone systematically underrepresents fan-driven multi-song
  presence. PLAVE 2026-05-07: daily had 1 song @ rank 73; realtime had
  6 songs, best @ rank 34. Day-only chart_peak missed both the better
  rank and the depth signal entirely.
- Realtime alone is volatile (per-minute updates) and time-of-day biased.
- Union with song_id dedup recovers depth, and min(rank) across both
  recovers the better peak — without inflating depth when a song appears
  in both charts (the common case for stable hits).

Failure model:
- If one chart fetch fails (empty/unreachable), the other still drives
  the UPDATE.
- Only when BOTH fail does the run report ``chart_unreachable``.

Match strategy (unchanged from V2.18):
- group's `name`, `name_kr`, and `aliases` are checked against each row's
  artist string with case-folded substring match. Solo / member-only
  releases are not matched (group-level ritual signal).
"""

from __future__ import annotations

import html as html_mod
import logging
import re
from collections import defaultdict
from collections.abc import Callable
from time import perf_counter
from typing import Any

from scrapling import Fetcher

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

log = logging.getLogger(__name__)

REALTIME_URL = "https://www.melon.com/chart/index.htm"
DAILY_URL = "https://www.melon.com/chart/day/index.htm"

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

        # Fetch both charts independently — partial failure tolerated.
        realtime_rows = parse_chart_html(self._fetch_html(REALTIME_URL) or "")
        daily_rows = parse_chart_html(self._fetch_html(DAILY_URL) or "")

        if not realtime_rows and not daily_rows:
            return CollectionResult(0, 0, errors=["chart_unreachable"])

        # Per group, dedup by song_id and keep the best (lowest) rank
        # observed across both charts. After accumulation:
        #   peak  = min(rank)         per group
        #   depth = len(songs_dict)   per group
        per_group_songs: dict[str, dict[str, int]] = defaultdict(dict)
        for row in (*realtime_rows, *daily_rows):
            sid = row["song_id"]
            rank = row["rank"]
            for g in seeded:
                if not _row_matches_group(row, g):
                    continue
                key = g["key"]
                cur = per_group_songs[key].get(sid)
                if cur is None or rank < cur:
                    per_group_songs[key][sid] = rank

        statements: list[tuple[str, list[Any]]] = []
        for key, songs in per_group_songs.items():
            if not songs:
                continue
            peak = min(songs.values())
            depth = len(songs)
            # Update the latest agg_summary row. agg_summary is daily,
            # built by build-agg-summary; we attach both signals to the
            # most recent snapshot. If there is no row yet (rare — only on
            # first-ever boot), this UPDATE becomes a no-op which is fine.
            statements.append((
                "UPDATE agg_summary SET melon_top100_peak = ?, "
                "melon_top100_depth = ? "
                "WHERE group_key = ? AND snapshot_at = ("
                "  SELECT MAX(snapshot_at) FROM agg_summary "
                "  WHERE group_key = ?)",
                [peak, depth, key, key],
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
