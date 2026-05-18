"""Tests for the Melon TOP 100 chart collector.

V2.19: collector fetches BOTH the realtime chart (/chart/index.htm) and
the daily chart (/chart/day/index.htm), unions matched rows per group
(deduplicated by song_id), and writes two signals to agg_summary:

  melon_top100_peak  = min(rank)  across the union (lower = better)
  melon_top100_depth = count(distinct song_id) across the union

Why two charts: realtime captures current fan-driven streaming depth
(PLAVE-style multi-song presence), daily provides 24h-stable peak.
Combining recovers signal that day-only missed (PLAVE 2026-05-07: day
1 song @ rank 73 vs realtime 6 songs, best @ rank 34).

If one chart fetch fails the other still drives the UPDATE; only when
BOTH fail does the run report ``chart_unreachable``.

V2.23: additionally emits per-song INSERTs into ``melon_chart_entries``
(migration 0058) with ``source`` ∈ {realtime, daily, both} so the
frontend can render 곡 단위 trajectory charts. UPSERT on PK so re-runs
within the same snapshot_at are idempotent.
"""

from unittest.mock import MagicMock

from idol_sight.collectors.melon import (
    MelonChartCollector,
    parse_chart_html,
)


def _update_stmts(statements):
    return [s for s in statements if "UPDATE agg_summary" in s[0]]


def _entry_stmts(statements):
    return [s for s in statements if "INSERT INTO melon_chart_entries" in s[0]]

# Realtime chart fixture — PLAVE 3 distinct songs (#1, #34, #77).
# ISEDOL collab in #42. SKINZ absent.
_REALTIME_HTML = """\
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
  <tr class="lst50" data-song-no="900077">
    <td><div class="wrap t_center"><span class="rank ">77</span></div></td>
    <td><div class="wrap"><div class="wrap_song_info">
      <div class="ellipsis rank01"><span>
        <a href="javascript:..." title="콜라보곡 재생">콜라보곡</a>
      </span></div>
      <div class="ellipsis rank02">
        <a href="/artist/detail.htm?artistId=1" title="PLAVE - 페이지 이동">PLAVE</a>
        <a href="/artist/detail.htm?artistId=99" title="다른가수 - 페이지 이동">다른가수</a>
      </div>
    </div></div></td>
  </tr>
</tbody></table>
"""

# Daily chart fixture — PLAVE 1 song (#73, "이 밤을 빌려 말해요" =
# same song_id 900034 as realtime → must dedup). Plus a different
# PLAVE song (#85, "Born Savage" = song_id 900085) NOT in realtime.
# ISEDOL absent from daily.
_DAILY_HTML = """\
<table><tbody>
  <tr class="lst50" data-song-no="900034">
    <td><div class="wrap t_center"><span class="rank ">73</span></div></td>
    <td><div class="wrap"><div class="wrap_song_info">
      <div class="ellipsis rank01"><span>
        <a href="javascript:..." title="이 밤을 빌려 말해요 재생">이 밤을 빌려 말해요</a>
      </span></div>
      <div class="ellipsis rank02">
        <a href="/artist/detail.htm?artistId=1" title="PLAVE - 페이지 이동">PLAVE</a>
      </div>
    </div></div></td>
  </tr>
  <tr class="lst50" data-song-no="900085">
    <td><div class="wrap t_center"><span class="rank ">85</span></div></td>
    <td><div class="wrap"><div class="wrap_song_info">
      <div class="ellipsis rank01"><span>
        <a href="javascript:..." title="Born Savage 재생">Born Savage</a>
      </span></div>
      <div class="ellipsis rank02">
        <a href="/artist/detail.htm?artistId=1" title="PLAVE - 페이지 이동">PLAVE</a>
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


def _fetcher_with(realtime_html: str, daily_html: str) -> MagicMock:
    """A Fetcher whose .get(url, ...) returns the right page per URL."""
    f = MagicMock()
    def get(url, **_):
        if "/chart/day/" in url:
            return _page(daily_html)
        return _page(realtime_html)
    f.get.side_effect = get
    return f


# ─── parser (unchanged) ─────────────────────────────────────────────────


def test_parse_chart_html_extracts_rank_song_artist():
    rows = parse_chart_html(_REALTIME_HTML)
    assert len(rows) == 4
    r1 = rows[0]
    assert r1["rank"] == 1
    assert r1["song_id"] == "900001"
    assert r1["song_title"] == "WAVE"
    assert "PLAVE" in r1["artists"]


def test_parse_chart_html_handles_collab_multiple_artists():
    rows = parse_chart_html(_REALTIME_HTML)
    r_collab = next(r for r in rows if r["rank"] == 77)
    assert "PLAVE" in r_collab["artists"]
    assert "다른가수" in r_collab["artists"]


def test_parse_returns_empty_for_blank_html():
    assert parse_chart_html("") == []
    assert parse_chart_html("<html></html>") == []


# ─── collector lifecycle ────────────────────────────────────────────────


def test_collect_global_no_groups_seeded():
    fetcher = MagicMock()
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [])
    res = c.collect_global()
    assert res.rows_inserted == 0
    assert "no_groups_seeded" in res.errors


def test_collect_global_fetches_both_charts():
    """V2.19 — realtime chart AND daily chart are both fetched."""
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    c.collect_global()

    fetched_urls = [call.args[0] for call in fetcher.get.call_args_list]
    assert any("/chart/index.htm" in u for u in fetched_urls), \
        f"realtime URL not fetched: {fetched_urls}"
    assert any("/chart/day/index.htm" in u for u in fetched_urls), \
        f"daily URL not fetched: {fetched_urls}"


def test_peak_is_min_rank_across_both_charts():
    """PLAVE realtime best=1, daily best=73 → peak=1.
    ISEDOL realtime=42 only → peak=42 (daily fetch still happens)."""
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    groups = [
        {"key": "plave", "name": "PLAVE", "name_kr": "플레이브", "aliases": []},
        {"key": "isedol", "name": "ISEGYE IDOL", "name_kr": "이세계아이돌",
         "aliases": ["이세돌"]},
    ]
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: groups)
    res = c.collect_global()
    by_key = {p[2]: {"peak": p[0], "depth": p[1]} for p in
              [s[1] for s in _update_stmts(res.statements)]}
    assert by_key["plave"]["peak"] == 1
    assert by_key["isedol"]["peak"] == 42


def test_depth_is_distinct_song_count_across_union():
    """PLAVE realtime songs: 900001, 900034, 900077.
    PLAVE daily songs:    900034, 900085.
    Union (dedup by song_id): {900001, 900034, 900077, 900085} → depth=4.
    """
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global()
    plave_params = next(p for p in [s[1] for s in _update_stmts(res.statements)]
                        if p[2] == "plave")
    # params layout: [peak, depth, key, key]
    assert plave_params[1] == 4


def test_update_statement_writes_both_peak_and_depth():
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global()
    upd = _update_stmts(res.statements)
    assert len(upd) == 1
    sql = upd[0][0]
    assert "UPDATE agg_summary" in sql
    assert "melon_top100_peak" in sql
    assert "melon_top100_depth" in sql


def test_partial_failure_one_chart_unreachable_other_succeeds():
    """If realtime fails but daily succeeds, collector still emits an
    UPDATE using the daily-only data. No fatal error."""
    fetcher = _fetcher_with("", _DAILY_HTML)  # realtime empty
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global()
    assert res.rows_inserted == 1  # 1 group matched
    upd = _update_stmts(res.statements)
    assert len(upd) == 1
    plave_params = upd[0][1]
    # daily had #73 + #85, both PLAVE → peak=73, depth=2
    assert plave_params[0] == 73
    assert plave_params[1] == 2


def test_both_charts_unreachable_returns_error():
    fetcher = _fetcher_with("", "")
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global()
    assert res.rows_inserted == 0
    assert "chart_unreachable" in res.errors


def test_no_match_emits_zero_rows():
    """SKINZ absent from both fixtures → no UPDATE."""
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "skinz", "name": "SKINZ",
                                "name_kr": "스킨즈", "aliases": []}],
    )
    res = c.collect_global()
    assert res.rows_inserted == 0


# ─── V2.23 per-song entries (melon_chart_entries) ───────────────────────


def test_entries_emit_one_insert_per_distinct_song():
    """PLAVE union = 4 distinct song_ids → 4 INSERTs into entries."""
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global(snapshot_at="2026-05-18T21:00:00Z")
    entries = _entry_stmts(res.statements)
    song_ids = {p[2] for _, p in entries}
    assert song_ids == {"900001", "900034", "900077", "900085"}


def test_entries_source_tags_realtime_daily_both():
    """song_id 900034 appears in BOTH charts → 'both'.
    900001/900077 in realtime only → 'realtime'.
    900085 in daily only → 'daily'."""
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global(snapshot_at="2026-05-18T21:00:00Z")
    # params layout: [snap, key, song_id, title, rank, source]
    by_sid = {p[2]: p for _, p in _entry_stmts(res.statements)}
    assert by_sid["900034"][5] == "both"
    assert by_sid["900001"][5] == "realtime"
    assert by_sid["900077"][5] == "realtime"
    assert by_sid["900085"][5] == "daily"


def test_entries_rank_is_min_when_song_in_both_charts():
    """900034: realtime #34, daily #73 → entries stores min=34."""
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global(snapshot_at="2026-05-18T21:00:00Z")
    e = next(p for _, p in _entry_stmts(res.statements) if p[2] == "900034")
    # [snap, key, sid, title, rank, source]
    assert e[4] == 34


def test_entries_use_provided_snapshot_at():
    """snapshot_at param is forwarded to every entry row."""
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    snap = "2026-05-18T21:00:00Z"
    res = c.collect_global(snapshot_at=snap)
    entries = _entry_stmts(res.statements)
    assert entries  # at least one
    assert all(p[0] == snap for _, p in entries)


def test_entries_default_snapshot_is_current_utc_hour():
    """Omitting snapshot_at → derived value matches YYYY-MM-DDTHH:00:00Z."""
    import re
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global()
    entries = _entry_stmts(res.statements)
    snaps = {p[0] for _, p in entries}
    assert len(snaps) == 1  # single snapshot across all entries
    (snap,) = snaps
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:00:00Z", snap)


def test_entries_song_title_stored():
    """song_title field of melon HTML row appears in entry params."""
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global(snapshot_at="2026-05-18T21:00:00Z")
    by_sid = {p[2]: p for _, p in _entry_stmts(res.statements)}
    assert by_sid["900001"][3] == "WAVE"
    assert by_sid["900085"][3] == "Born Savage"


def test_entries_upsert_on_conflict():
    """INSERT carries ON CONFLICT DO UPDATE so re-runs are idempotent."""
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global(snapshot_at="2026-05-18T21:00:00Z")
    sql = _entry_stmts(res.statements)[0][0]
    assert "ON CONFLICT" in sql
    assert "rank = excluded.rank" in sql


def test_entries_skipped_for_unmatched_groups():
    """SKINZ has 0 songs charting → 0 entries."""
    fetcher = _fetcher_with(_REALTIME_HTML, _DAILY_HTML)
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "skinz", "name": "SKINZ",
                                "name_kr": "스킨즈", "aliases": []}],
    )
    res = c.collect_global(snapshot_at="2026-05-18T21:00:00Z")
    assert _entry_stmts(res.statements) == []
