"""Melon daily chart collector (V2.24 — daily-only, chart_date 명시).

V2.24 변경 요약 (vs V2.19/V2.23):
- realtime(/chart/index.htm) fetch 제거. daily(/chart/day/index.htm)만 사용.
- ``chart_date`` 명시 (YYYY-MM-DD, KST). snapshot_at(UTC fetch time)은
  audit/debug용으로만 유지.
- ``melon_chart_entries.source`` 는 새 row에서 항상 'daily'.

Why daily-only:
- 멜론 TOP 100(realtime)은 "직전 1시간 50% + 24시간 누적 50%" 가중치라
  fetch 시점 노이즈가 큼. 01~07시 KST는 24시간 100%로 전환되어 화력
  희석. 단일 시점 스냅샷으로 "trajectory"를 재구성하기엔 부적합.
- 일간차트는 D의 KST 00:00~23:59 24시간 풀집계 — 시점 가중치 없는
  완성형 데이터. 산업 보고 단위와도 일치 ("○월○일 멜론 일간 ○위").
- per-song trajectory 분석(V2.23이 도입한 핵심 기능)은 "발매 N일차" 축이
  자연스러움. 시간별 스냅샷보다 일간 step function 이 노이즈 적음.

Trade-off (수용):
- realtime depth recovery 손실 (V2.19 PLAVE 사례: daily 1곡 vs realtime 6곡).
  group-level depth가 한시적으로 낮게 측정됨. 깊은 팬덤 활동의 양 신호는
  daily 진입곡 수로 한정. 다른 KPI(SOV, engagement)가 이를 보완.

Failure model:
- 단일 fetch 실패 시 ``chart_unreachable`` 보고. partial fallback 없음
  (실시간 차트가 사라졌으므로).

Match strategy (unchanged from V2.18~V2.23):
- group의 name / name_kr / aliases 와 row의 artist anchor를 case-folded
  substring match. 솔로/멤버 단독은 매치하지 않음 (그룹 단위 신호).
"""

from __future__ import annotations

import html as html_mod
import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone
from time import perf_counter
from typing import Any

from scrapling import Fetcher

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

log = logging.getLogger(__name__)

DAILY_URL = "https://www.melon.com/chart/day/index.htm"

# KST는 UTC+9 고정 (DST 없음).
_KST = timezone(timedelta(hours=9))

# Per-row HTML 구조 (2026-05 기준 — V2.23부터 변경 없음):
#   <tr class="lst50|lst100" data-song-no="<song_id>">
#     <span class="rank ">N</span>
#     <div class="ellipsis rank01"><span><a title="<song_title> 재생">...</a></span></div>
#     <div class="ellipsis rank02">
#       <a title="<ARTIST> - 페이지 이동">...</a> (collab → 여러 anchor)
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
_ARTIST_BLOCK_RE = re.compile(
    r'<div class="ellipsis rank02">(?P<block>.*?)</div>',
    re.DOTALL,
)
_ARTIST_TITLE_RE = re.compile(
    r'title="(?P<artist>[^"]+?)\s*-\s*페이지\s*이동"',
)


def _decode(s: str) -> str:
    s = html_mod.unescape(s)
    s = s.replace(" ", " ")          # nbsp
    return re.sub(r"\s+", " ", s).strip()


def parse_chart_html(html: str) -> list[dict[str, Any]]:
    """Parse melon TOP 100 SSR HTML → list of row dicts.

    Returns ``[]`` on empty / malformed input. Each entry:
        {"rank": int, "song_id": str, "song_title": str, "artists": [str, ...]}

    멜론 일간차트 페이지는 동일 row를 두 영역(상단 hero 50 + 하단 51-100)
    에 중복 렌더한다. 호출자는 song_id 단위로 dedup하면 됨.
    """
    if not html:
        return []
    seen: dict[str, dict[str, Any]] = {}
    for m in _ROW_RE.finditer(html):
        body = m.group("body")
        rank_m = _RANK_RE.search(body)
        title_m = _SONG_TITLE_RE.search(body)
        artist_block_m = _ARTIST_BLOCK_RE.search(body)
        if not (rank_m and title_m and artist_block_m):
            continue
        sid = m.group("song_id")
        if sid in seen:
            continue
        artists = [
            _decode(am.group("artist"))
            for am in _ARTIST_TITLE_RE.finditer(artist_block_m.group("block"))
        ]
        seen[sid] = {
            "rank": int(rank_m.group(1)),
            "song_id": sid,
            "song_title": _decode(title_m.group("title")),
            "artists": artists,
        }
    return list(seen.values())


def _row_matches_group(row: dict[str, Any], group: dict[str, Any]) -> bool:
    """case-folded substring match against any artist anchor in the row."""
    candidates = [group.get("name"), group.get("name_kr")]
    candidates.extend(group.get("aliases") or [])
    candidates = [c for c in candidates if c and len(c) >= 2]
    haystack = " ".join(row["artists"]).casefold()
    return any(c.casefold() in haystack for c in candidates)


def default_chart_date_kst(now_utc: datetime | None = None) -> str:
    """Cron 기본값: 현재 KST 기준 "어제" 의 일간차트.

    21:00 UTC 실행 시 → KST 06:00 익일 → 어제 KST = UTC 같은 날.
    임의 시점 실행도 안전하도록 KST로 변환 후 -1일.
    """
    now = now_utc or datetime.now(UTC)
    kst = now.astimezone(_KST)
    return (kst - timedelta(days=1)).strftime("%Y-%m-%d")


class MelonChartCollector:
    source = "melon"

    def __init__(
        self,
        fetcher: Any | None = None,
        groups_loader: Callable[[], list[dict]] | None = None,
        url: str = DAILY_URL,
    ):
        self._fetcher = fetcher or Fetcher
        self._groups_loader = groups_loader or (lambda: [])
        self._url = url

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        # Per-group fan-out is a no-op — one HTTP fetch covers everything.
        return CollectionResult(0, 0)

    def collect_global(
        self,
        snapshot_at: str | None = None,
        chart_date: str | None = None,
    ) -> CollectionResult:
        """일간차트 fetch → agg_summary UPDATE + per-song INSERT statements.

        Args:
            snapshot_at: audit/debug 용 UTC fetch 시각 ('YYYY-MM-DDTHH:00:00Z').
                기본값 = 현재 UTC hour. agg_summary sandwich와 정렬용.
            chart_date: 이 row가 표현하는 KST 일간차트 날짜 ('YYYY-MM-DD').
                기본값 = ``default_chart_date_kst()``.
        """
        started = perf_counter()
        seeded = self._groups_loader()
        if not seeded:
            return CollectionResult(0, 0, errors=["no_groups_seeded"])

        snap = snapshot_at or datetime.now(UTC).strftime("%Y-%m-%dT%H:00:00Z")
        cdate = chart_date or default_chart_date_kst()

        rows = parse_chart_html(self._fetch_html(self._url) or "")
        if not rows:
            return CollectionResult(0, 0, errors=["chart_unreachable"])

        # Per group: dedup by song_id, keep best rank (daily already unique
        # by song_id, but parse_chart_html dedup made it explicit). Match
        # group → emit per-song record.
        per_group_songs: dict[str, dict[str, dict[str, Any]]] = {}
        for row in rows:
            for g in seeded:
                if not _row_matches_group(row, g):
                    continue
                key = g["key"]
                bucket = per_group_songs.setdefault(key, {})
                # parse_chart_html dedup → 1 row/song_id 보장. 그래도 방어:
                cur = bucket.get(row["song_id"])
                if cur is None or row["rank"] < cur["rank"]:
                    bucket[row["song_id"]] = {
                        "rank": row["rank"],
                        "title": row["song_title"],
                    }

        statements: list[tuple[str, list[Any]]] = []
        for key, songs in per_group_songs.items():
            if not songs:
                continue
            peak = min(s["rank"] for s in songs.values())
            depth = len(songs)
            # Update the latest agg_summary row. agg_summary is daily,
            # built by build-agg-summary; we attach both signals to the
            # most recent snapshot.
            statements.append((
                "UPDATE agg_summary SET melon_top100_peak = ?, "
                "melon_top100_depth = ? "
                "WHERE group_key = ? AND snapshot_at = ("
                "  SELECT MAX(snapshot_at) FROM agg_summary "
                "  WHERE group_key = ?)",
                [peak, depth, key, key],
            ))
            # V2.24: per-song entries. source='daily' 고정.
            # PK (snapshot_at, group_key, song_id) — 같은 snap 내 idempotent.
            # chart_date는 별도 컬럼 (migration 0059).
            for sid, song in songs.items():
                statements.append((
                    "INSERT INTO melon_chart_entries "
                    "  (snapshot_at, group_key, song_id, song_title, rank, "
                    "   source, chart_date) "
                    "VALUES (?, ?, ?, ?, ?, 'daily', ?) "
                    "ON CONFLICT(snapshot_at, group_key, song_id) DO UPDATE SET "
                    "  rank = excluded.rank, "
                    "  source = excluded.source, "
                    "  song_title = excluded.song_title, "
                    "  chart_date = excluded.chart_date",
                    [snap, key, sid, song["title"], song["rank"], cdate],
                ))

        groups_matched = sum(1 for songs in per_group_songs.values() if songs)
        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=groups_matched,
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
