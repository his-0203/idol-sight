"""Melon chart collector (V2.25 — daily + TOP100, chart_type 분기).

V2.25 변경 (vs V2.24):
- TOP100 차트(/chart/index.htm) 적재 복원. 단 V2.19처럼 union 하지 않고
  ``chart_type`` 컬럼으로 분기 적재 — 일간/탑100 trajectory를 독립 추적.
- 두 모드 모두 chart_type 인자로 선택. 'daily' 기본.

Why 두 모드 (사용자 요청, 2026-05-19):
- 일간차트(daily, 06 KST): D-1 KST의 24h 풀집계. 시점 가중치 없는 산업
  표준 단위. "○월○일 ○위" 형식 보고와 일치.
- TOP100 차트(top100, 22 KST): "직전 1h 50% + 24h 50%" 가중치 차트.
  22 KST는 저녁 화력의 결산 시점 — 그날 팬덤이 도달시킨 최고 위치를
  캡처. 일간이 놓치는 화력 정점(realtime depth recovery)을 별도 축으로
  보존.
- 같은 곡이 두 차트에 다른 rank로 나타날 수 있고, 두 trajectory를
  대시보드 탭으로 비교하는 게 인사이트 풀.

Schema:
- chart_type = 'daily' | 'top100' (migration 0060).
- PK (snapshot_at, group_key, song_id) 그대로. snapshot_at 시각이 21 UTC
  (daily) vs 13 UTC (top100)라 충돌 없음.
- source 필드 (V2.23 historical: 'realtime'|'daily'|'both')는 chart_type
  도입으로 의미가 중복. 새 row는 항상 source='daily' (legacy 유지).

Match strategy (unchanged from V2.18~V2.24):
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
TOP100_URL = "https://www.melon.com/chart/index.htm"

CHART_TYPE_URLS = {"daily": DAILY_URL, "top100": TOP100_URL}

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


def default_chart_date_kst(
    now_utc: datetime | None = None,
    *,
    chart_type: str = "daily",
) -> str:
    """차트 fetch 시점에 의미적으로 맞는 KST 날짜.

    - daily: 21:00 UTC = KST 06:00 익일 → "어제 KST"의 24h 풀집계가 fetch
      대상. KST에서 1일 빼기.
    - top100: 13:00 UTC = KST 22:00 → "오늘 KST"의 22시 시점 가중치 차트.
      KST 그 날짜.

    임의 시점 실행도 형식적으론 동작하지만 cron이 위 두 시각에 고정.
    """
    now = now_utc or datetime.now(UTC)
    kst = now.astimezone(_KST)
    if chart_type == "top100":
        return kst.strftime("%Y-%m-%d")
    return (kst - timedelta(days=1)).strftime("%Y-%m-%d")


class MelonChartCollector:
    source = "melon"

    def __init__(
        self,
        fetcher: Any | None = None,
        groups_loader: Callable[[], list[dict]] | None = None,
        url: str | None = None,
    ):
        self._fetcher = fetcher or Fetcher
        self._groups_loader = groups_loader or (lambda: [])
        self._url_override = url  # 명시 url 지정 시 chart_type 무시.

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        # Per-group fan-out is a no-op — one HTTP fetch covers everything.
        return CollectionResult(0, 0)

    def collect_global(
        self,
        snapshot_at: str | None = None,
        chart_date: str | None = None,
        chart_type: str = "daily",
    ) -> CollectionResult:
        """차트 fetch → agg_summary UPDATE + per-song INSERT statements.

        Args:
            snapshot_at: audit/debug 용 UTC fetch 시각 ('YYYY-MM-DDTHH:00:00Z').
                기본값 = 현재 UTC hour. agg_summary sandwich와 정렬용.
            chart_date: 이 row가 표현하는 KST 차트 날짜 ('YYYY-MM-DD').
                기본값 = ``default_chart_date_kst(chart_type=...)``.
            chart_type: 'daily' (06 KST cron, /chart/day) 또는 'top100'
                (22 KST cron, /chart/index). melon_chart_entries.chart_type
                컬럼에 그대로 기록 — 대시보드 탭이 이 값으로 필터.
        """
        if chart_type not in CHART_TYPE_URLS:
            raise ValueError(
                f"chart_type must be one of {sorted(CHART_TYPE_URLS)}, "
                f"got {chart_type!r}"
            )
        started = perf_counter()
        seeded = self._groups_loader()
        if not seeded:
            return CollectionResult(0, 0, errors=["no_groups_seeded"])

        snap = snapshot_at or datetime.now(UTC).strftime("%Y-%m-%dT%H:00:00Z")
        cdate = chart_date or default_chart_date_kst(chart_type=chart_type)
        url = self._url_override or CHART_TYPE_URLS[chart_type]

        rows = parse_chart_html(self._fetch_html(url) or "")
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
            # agg_summary.melon_top100_peak/depth는 일간차트 기준으로만 갱신.
            # TOP100 22 KST run은 이 UPDATE를 건너뛴다 — V2.18→V2.19 시절의
            # union으로 다시 회귀하지 않기 위함. group-level KPI는 daily
            # 표준 단위로 유지하고 TOP100 trajectory는 별도 탭으로만 보여줌.
            if chart_type == "daily":
                statements.append((
                    "UPDATE agg_summary SET melon_top100_peak = ?, "
                    "melon_top100_depth = ? "
                    "WHERE group_key = ? AND snapshot_at = ("
                    "  SELECT MAX(snapshot_at) FROM agg_summary "
                    "  WHERE group_key = ?)",
                    [peak, depth, key, key],
                ))
            # V2.25: per-song entries — chart_type 컬럼 명시.
            # PK (snapshot_at, group_key, song_id) — daily(21 UTC) vs
            # top100(13 UTC) 시각 다르므로 같은 그룹/곡 두 row 공존.
            for sid, song in songs.items():
                statements.append((
                    "INSERT INTO melon_chart_entries "
                    "  (snapshot_at, group_key, song_id, song_title, rank, "
                    "   source, chart_date, chart_type) "
                    "VALUES (?, ?, ?, ?, ?, 'daily', ?, ?) "
                    "ON CONFLICT(snapshot_at, group_key, song_id) DO UPDATE SET "
                    "  rank = excluded.rank, "
                    "  source = excluded.source, "
                    "  song_title = excluded.song_title, "
                    "  chart_date = excluded.chart_date, "
                    "  chart_type = excluded.chart_type",
                    [snap, key, sid, song["title"], song["rank"],
                     cdate, chart_type],
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
