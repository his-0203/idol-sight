"""Melon 일간차트 1회성 백필 (V2.24 — guyso.me 아카이브 기반).

멜론 공식은 dayTime 파라미터를 무시해 과거 일간차트에 접근 불가.
guyso.me 아카이브 사이트는 ``/chart/melon/daily/YYYYMMDD`` 경로로 과거
일간차트의 __NEXT_DATA__ JSON을 그대로 보존한다. JSON에는 멜론 본래의
song_id (numeric, e.g. ``601719413``)가 포함되어 forward-collected row
와 동일한 PK 공간을 공유한다.

호출 패턴 (cli.py melon-chart-backfill):
    1) chart_date 단위로 이미 데이터가 있는 날짜는 skip (gap fill 전용).
    2) 각 날짜의 __NEXT_DATA__ JSON 파싱 → top N (default 100) 필터링.
    3) seeded group과 substring match (멜론 forward collector와 동일 로직).
    4) snapshot_at = ``<chart_date>T00:00:00Z`` synthetic (결정적 → ON
       CONFLICT idempotent). chart_date는 명시.

3rd-party 의존이지만 이 스크립트는 1회성(또는 새 그룹 추가 시 재실행)
이므로 운영 리스크 제한적. 일상 수집은 melon.py가 멜론 공식 사용.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, timedelta
from typing import Any

from scrapling import Fetcher

from idol_sight.collectors.melon import _row_matches_group

log = logging.getLogger(__name__)

GUYSO_DAILY_URL = "https://guyso.me/chart/melon/daily/{yyyymmdd}"
_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(?P<json>.*?)</script>',
    re.DOTALL,
)


def _parse_guyso_payload(html: str) -> list[dict[str, Any]] | None:
    """guyso.me daily chart 페이지 → list of normalized row dicts.

    Returns ``None`` on parse failure (caller decides skip vs error).
    Normalized row matches ``parse_chart_html`` output shape so
    ``_row_matches_group`` works identically.
    """
    m = _NEXT_DATA_RE.search(html)
    if not m:
        return None
    try:
        data = json.loads(m.group("json"))
        entries = data["props"]["pageProps"]["data"]["data"]
    except (KeyError, ValueError, TypeError):
        return None
    out: list[dict[str, Any]] = []
    for e in entries:
        song = e.get("song") or {}
        sid = song.get("id")
        if sid is None:
            continue
        artists = [a.get("name", "") for a in song.get("artists") or []]
        out.append({
            "rank": int(e.get("ranking", 0)),
            "song_id": str(sid),
            "song_title": song.get("name") or "",
            "artists": [a for a in artists if a],
        })
    return out


def fetch_guyso_daily(chart_date: str, fetcher: Any | None = None) -> list[dict[str, Any]] | None:
    """Fetch one day from guyso.me. chart_date is 'YYYY-MM-DD'."""
    fetcher = fetcher or Fetcher
    yyyymmdd = chart_date.replace("-", "")
    url = GUYSO_DAILY_URL.format(yyyymmdd=yyyymmdd)
    try:
        page = fetcher.get(url, impersonate="chrome131", stealthy_headers=True)
    except Exception as e:  # noqa: BLE001
        log.warning("guyso fetch failed %s: %s", url, e)
        return None
    for attr in ("html_content", "body", "raw_html", "html"):
        v = getattr(page, attr, None)
        if isinstance(v, str) and v.strip():
            return _parse_guyso_payload(v)
    return None


def daterange(start: str, end: str) -> list[str]:
    """Inclusive YYYY-MM-DD range, ascending."""
    s = date.fromisoformat(start)
    e = date.fromisoformat(end)
    if e < s:
        raise ValueError(f"end ({end}) < start ({start})")
    out: list[str] = []
    cur = s
    while cur <= e:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def build_backfill_statements(
    chart_date: str,
    rows: list[dict[str, Any]],
    seeded_groups: list[dict],
    top_n: int = 100,
) -> list[tuple[str, list[Any]]]:
    """rows (parsed guyso entries) × seeded_groups → INSERT statements.

    snapshot_at = ``<chart_date>T00:00:00Z`` (synthetic, 결정적).
    source = 'daily'. ON CONFLICT(snapshot_at, group_key, song_id) DO
    UPDATE so re-running the same date is idempotent.

    Top-N filter (default 100) keeps forward/backward symmetry — forward
    collector parses melon's top 100 page, so backfill must too.
    """
    snap = f"{chart_date}T00:00:00Z"
    per_group: dict[str, dict[str, dict[str, Any]]] = {}
    for row in rows:
        if row["rank"] < 1 or row["rank"] > top_n:
            continue
        for g in seeded_groups:
            if not _row_matches_group(row, g):
                continue
            key = g["key"]
            bucket = per_group.setdefault(key, {})
            cur = bucket.get(row["song_id"])
            if cur is None or row["rank"] < cur["rank"]:
                bucket[row["song_id"]] = {
                    "rank": row["rank"],
                    "title": row["song_title"],
                }

    stmts: list[tuple[str, list[Any]]] = []
    for key, songs in per_group.items():
        for sid, song in songs.items():
            stmts.append((
                "INSERT INTO melon_chart_entries "
                "  (snapshot_at, group_key, song_id, song_title, rank, "
                "   source, chart_date) "
                "VALUES (?, ?, ?, ?, ?, 'daily', ?) "
                "ON CONFLICT(snapshot_at, group_key, song_id) DO UPDATE SET "
                "  rank = excluded.rank, "
                "  song_title = excluded.song_title, "
                "  chart_date = excluded.chart_date",
                [snap, key, sid, song["title"], song["rank"], chart_date],
            ))
    return stmts


def existing_chart_dates(
    client: Any, start: str, end: str
) -> set[str]:
    """Dates in [start, end] that already have any melon_chart_entries.

    Pre-check so backfill skips dates already covered by forward-collected
    or earlier backfilled rows. chart_date 컬럼이 NULL인 V2.23 row는
    migration 0059이 backfill했지만 안전망으로 COALESCE 사용.
    """
    sql = (
        "SELECT DISTINCT COALESCE(chart_date, substr(snapshot_at, 1, 10)) "
        "  AS d "
        "FROM melon_chart_entries "
        "WHERE COALESCE(chart_date, substr(snapshot_at, 1, 10)) "
        "      BETWEEN ? AND ?"
    )
    rs = client.execute(sql, [start, end])
    return {r["d"] for r in rs if r.get("d")}
