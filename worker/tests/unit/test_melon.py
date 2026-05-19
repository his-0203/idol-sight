"""Tests for the Melon 일간차트 collector (V2.24 — daily-only).

V2.24 변경 (vs V2.19/V2.23):
- realtime(/chart/index.htm) fetch 제거. daily(/chart/day/index.htm) 단독.
- ``chart_date`` 명시 (YYYY-MM-DD, KST). snapshot_at은 UTC fetch 시각.
- ``melon_chart_entries.source`` 는 새 row에서 항상 'daily'.

peak = min(rank) within daily chart; depth = count(distinct song_id)
within daily chart. realtime depth recovery 손실은 의도된 trade-off
(V2.19 PLAVE 6곡 케이스 → V2.24는 daily에 잡힌 곡 수만 반영).
"""

from datetime import UTC, datetime
from unittest.mock import MagicMock

from idol_sight.collectors.melon import (
    MelonChartCollector,
    default_chart_date_kst,
    parse_chart_html,
)


def _update_stmts(statements):
    return [s for s in statements if "UPDATE agg_summary" in s[0]]


def _entry_stmts(statements):
    return [s for s in statements if "INSERT INTO melon_chart_entries" in s[0]]


# Daily chart fixture — PLAVE 3 distinct songs (#1, #34, #73).
# ISEDOL collab at #42. SKINZ absent.
_DAILY_HTML = """\
<table><tbody>
  <tr class="lst50" data-song-no="900001">
    <td><div class="wrap t_center"><span class="rank ">1</span></div></td>
    <td><div class="wrap"><div class="wrap_song_info">
      <div class="ellipsis rank01"><span>
        <a href="javascript:..." title="WAVE 재생">WAVE</a>
      </span></div>
      <div class="ellipsis rank02">
        <a href="/artist/detail.htm?artistId=1" title="PLAVE - 페이지 이동">PLAVE</a>
      </div>
    </div></div></td>
  </tr>
  <tr class="lst50" data-song-no="900034">
    <td><div class="wrap t_center"><span class="rank ">34</span></div></td>
    <td><div class="wrap"><div class="wrap_song_info">
      <div class="ellipsis rank01"><span>
        <a href="javascript:..." title="이 밤을 빌려 말해요 재생">이 밤을 빌려 말해요</a>
      </span></div>
      <div class="ellipsis rank02">
        <a href="/artist/detail.htm?artistId=1" title="PLAVE - 페이지 이동">PLAVE</a>
      </div>
    </div></div></td>
  </tr>
  <tr class="lst50" data-song-no="900042">
    <td><div class="wrap t_center"><span class="rank ">42</span></div></td>
    <td><div class="wrap"><div class="wrap_song_info">
      <div class="ellipsis rank01"><span>
        <a href="javascript:..." title="다른노래 재생">다른노래</a>
      </span></div>
      <div class="ellipsis rank02">
        <a href="/artist/detail.htm?artistId=2" title="이세계아이돌 - 페이지 이동">이세계아이돌</a>
      </div>
    </div></div></td>
  </tr>
  <tr class="lst100" data-song-no="900073">
    <td><div class="wrap t_center"><span class="rank ">73</span></div></td>
    <td><div class="wrap"><div class="wrap_song_info">
      <div class="ellipsis rank01"><span>
        <a href="javascript:..." title="Born Savage 재생">Born Savage</a>
      </span></div>
      <div class="ellipsis rank02">
        <a href="/artist/detail.htm?artistId=1" title="PLAVE - 페이지 이동">PLAVE</a>
        <a href="/artist/detail.htm?artistId=99" title="다른가수 - 페이지 이동">다른가수</a>
      </div>
    </div></div></td>
  </tr>
</tbody></table>
"""


def _page(html: str) -> MagicMock:
    p = MagicMock()
    p.html_content = html
    p.body = html
    return p


def _fetcher_with(daily_html: str) -> MagicMock:
    """A Fetcher whose .get(url, ...) returns the daily page."""
    f = MagicMock()
    f.get.side_effect = lambda url, **_: _page(daily_html)
    return f


_PLAVE = {"key": "plave", "name": "PLAVE", "name_kr": "플레이브", "aliases": []}
_ISEDOL = {"key": "isedol", "name": "ISEGYE IDOL",
           "name_kr": "이세계아이돌", "aliases": ["이세돌"]}
_SKINZ = {"key": "skinz", "name": "SKINZ", "name_kr": "스킨즈", "aliases": []}


# ─── parser ─────────────────────────────────────────────────────────────


def test_parse_chart_html_extracts_rank_song_artist():
    rows = parse_chart_html(_DAILY_HTML)
    assert len(rows) == 4
    r1 = next(r for r in rows if r["rank"] == 1)
    assert r1["song_id"] == "900001"
    assert r1["song_title"] == "WAVE"
    assert "PLAVE" in r1["artists"]


def test_parse_chart_html_handles_collab_multiple_artists():
    rows = parse_chart_html(_DAILY_HTML)
    r_collab = next(r for r in rows if r["rank"] == 73)
    assert "PLAVE" in r_collab["artists"]
    assert "다른가수" in r_collab["artists"]


def test_parse_returns_empty_for_blank_html():
    assert parse_chart_html("") == []
    assert parse_chart_html("<html></html>") == []


def test_parse_dedups_when_same_song_id_appears_twice():
    """멜론 일간차트 페이지는 동일 row를 hero 50 + tail 51-100 두 영역
    에 중복 렌더한다. parse_chart_html은 song_id 기준 dedup."""
    doubled = _DAILY_HTML + _DAILY_HTML
    rows = parse_chart_html(doubled)
    sids = [r["song_id"] for r in rows]
    assert len(sids) == len(set(sids))


# ─── chart_date default ─────────────────────────────────────────────────


def test_default_chart_date_kst_is_yesterday_in_kst():
    """21:00 UTC fetch → KST 익일 06:00 → 어제 KST = UTC 같은 날 의 날짜."""
    now_utc = datetime(2026, 5, 19, 21, 0, tzinfo=UTC)
    # KST 06:00 익일 — 어제 KST = 2026-05-19 KST = UTC 2026-05-19
    assert default_chart_date_kst(now_utc) == "2026-05-19"


def test_default_chart_date_kst_around_kst_midnight():
    """UTC 15:00 = KST 00:00 → 어제 KST = UTC 14:59 시점의 UTC 날 - 1."""
    # 2026-05-19 14:59 UTC = 2026-05-19 23:59 KST → 어제 KST = 2026-05-18
    now_utc = datetime(2026, 5, 19, 14, 59, tzinfo=UTC)
    assert default_chart_date_kst(now_utc) == "2026-05-18"
    # 2026-05-19 15:00 UTC = 2026-05-20 00:00 KST → 어제 KST = 2026-05-19
    now_utc = datetime(2026, 5, 19, 15, 0, tzinfo=UTC)
    assert default_chart_date_kst(now_utc) == "2026-05-19"


# ─── collector lifecycle ────────────────────────────────────────────────


def test_collect_global_no_groups_seeded():
    fetcher = MagicMock()
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [])
    res = c.collect_global()
    assert res.rows_inserted == 0
    assert "no_groups_seeded" in res.errors


def test_collect_global_fetches_only_daily():
    """V2.24 — realtime URL 더 이상 호출되지 않음."""
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    c.collect_global(chart_date="2026-05-15")
    fetched_urls = [call.args[0] for call in fetcher.get.call_args_list]
    assert all("/chart/day/index.htm" in u for u in fetched_urls), \
        f"non-daily URL fetched: {fetched_urls}"
    assert not any("/chart/index.htm" == u for u in fetched_urls), \
        f"realtime URL still fetched: {fetched_urls}"


def test_peak_is_min_rank_in_daily():
    """PLAVE daily ranks {1, 34, 73} → peak=1. ISEDOL daily=42 → peak=42."""
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher, groups_loader=lambda: [_PLAVE, _ISEDOL],
    )
    res = c.collect_global(chart_date="2026-05-15")
    by_key = {p[2]: {"peak": p[0], "depth": p[1]}
              for p in [s[1] for s in _update_stmts(res.statements)]}
    assert by_key["plave"]["peak"] == 1
    assert by_key["isedol"]["peak"] == 42


def test_depth_is_distinct_song_count_in_daily():
    """PLAVE daily-only songs: 900001, 900034, 900073 → depth=3."""
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    res = c.collect_global(chart_date="2026-05-15")
    plave_params = next(p for p in [s[1] for s in _update_stmts(res.statements)]
                        if p[2] == "plave")
    assert plave_params[1] == 3


def test_update_statement_writes_both_peak_and_depth():
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    res = c.collect_global(chart_date="2026-05-15")
    upd = _update_stmts(res.statements)
    assert len(upd) == 1
    sql = upd[0][0]
    assert "UPDATE agg_summary" in sql
    assert "melon_top100_peak" in sql
    assert "melon_top100_depth" in sql


def test_chart_unreachable_returns_error():
    fetcher = _fetcher_with("")
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    res = c.collect_global(chart_date="2026-05-15")
    assert res.rows_inserted == 0
    assert "chart_unreachable" in res.errors


def test_no_match_emits_zero_rows():
    """SKINZ absent from fixture → no UPDATE, no entries."""
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_SKINZ])
    res = c.collect_global(chart_date="2026-05-15")
    assert res.rows_inserted == 0
    assert _update_stmts(res.statements) == []
    assert _entry_stmts(res.statements) == []


# ─── per-song entries (melon_chart_entries) ────────────────────────────


def test_entries_emit_one_insert_per_distinct_song():
    """PLAVE 3 distinct song_ids in daily → 3 INSERTs."""
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    res = c.collect_global(
        snapshot_at="2026-05-16T21:00:00Z", chart_date="2026-05-15",
    )
    entries = _entry_stmts(res.statements)
    song_ids = {p[2] for _, p in entries}
    assert song_ids == {"900001", "900034", "900073"}


def test_entries_source_is_always_daily():
    """V2.24 source 필드는 항상 'daily' (realtime/both 사라짐).
    SQL literal에 'daily' 가 있고, params 에는 source 인덱스 없음."""
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    res = c.collect_global(
        snapshot_at="2026-05-16T21:00:00Z", chart_date="2026-05-15",
    )
    entries = _entry_stmts(res.statements)
    assert entries
    for sql, params in entries:
        assert "'daily'" in sql
        # params layout (V2.24): [snap, key, sid, title, rank, chart_date]
        assert len(params) == 6


def test_entries_chart_date_is_propagated():
    """chart_date 파라미터가 모든 entry row 마지막 칸에 전달."""
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    res = c.collect_global(
        snapshot_at="2026-05-16T21:00:00Z", chart_date="2026-05-15",
    )
    entries = _entry_stmts(res.statements)
    assert entries
    cdates = {p[5] for _, p in entries}
    assert cdates == {"2026-05-15"}


def test_entries_default_chart_date_uses_kst_yesterday():
    """chart_date 미지정 → default_chart_date_kst() 사용."""
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    res = c.collect_global(snapshot_at="2026-05-16T21:00:00Z")
    entries = _entry_stmts(res.statements)
    cdates = {p[5] for _, p in entries}
    assert len(cdates) == 1
    (cdate,) = cdates
    # default = 어제 KST. 형식 검증으로 충분 (시점 의존성 회피).
    assert len(cdate) == 10 and cdate[4] == "-" and cdate[7] == "-"


def test_entries_use_provided_snapshot_at():
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    snap = "2026-05-16T21:00:00Z"
    res = c.collect_global(snapshot_at=snap, chart_date="2026-05-15")
    entries = _entry_stmts(res.statements)
    assert entries
    assert all(p[0] == snap for _, p in entries)


def test_entries_default_snapshot_is_current_utc_hour():
    import re
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    res = c.collect_global(chart_date="2026-05-15")
    entries = _entry_stmts(res.statements)
    snaps = {p[0] for _, p in entries}
    assert len(snaps) == 1
    (snap,) = snaps
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:00:00Z", snap)


def test_entries_song_title_stored():
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    res = c.collect_global(
        snapshot_at="2026-05-16T21:00:00Z", chart_date="2026-05-15",
    )
    by_sid = {p[2]: p for _, p in _entry_stmts(res.statements)}
    assert by_sid["900001"][3] == "WAVE"
    assert by_sid["900073"][3] == "Born Savage"


def test_entries_upsert_on_conflict_includes_chart_date():
    fetcher = _fetcher_with(_DAILY_HTML)
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [_PLAVE])
    res = c.collect_global(
        snapshot_at="2026-05-16T21:00:00Z", chart_date="2026-05-15",
    )
    sql = _entry_stmts(res.statements)[0][0]
    assert "ON CONFLICT" in sql
    assert "rank = excluded.rank" in sql
    assert "chart_date = excluded.chart_date" in sql
