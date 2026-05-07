"""Tests for the Melon TOP 100 daily chart collector.

The collector reads the SSR HTML at /chart/day/index.htm, extracts (rank,
song_id, song_title, artist_names) for the 100 charted songs, then matches
each row against our seeded groups (name / name_kr / aliases). When a group
charts at multiple ranks (multiple songs), the lowest rank number (= best
peak) wins. The result is an UPDATE on agg_summary.melon_top100_peak for
the latest snapshot.
"""

from unittest.mock import MagicMock

from idol_sight.collectors.melon import (
    MelonChartCollector,
    parse_chart_html,
)

_FAKE_HTML = """\

<table><tbody>
  <tr class="lst50" data-song-no="900001">
    <td><div class="wrap t_center"><span class="rank ">1</span></div></td>
    <td><div class="wrap"><div class="wrap_song_info">
      <div class="ellipsis rank01"><span>
        <a href="javascript:melon.play.playSong('19041201',900001);" title="WAVE 재생">WAVE</a>
      </span></div>
      <div class="ellipsis rank02">
        <a href="/artist/detail.htm?artistId=1" title="PLAVE - 페이지 이동">PLAVE</a>
      </div>
    </div></div></td>
  </tr>
  <tr class="lst50" data-song-no="900002">
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
  <tr class="lst50" data-song-no="900003">
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


def test_parse_chart_html_extracts_rank_song_artist():
    rows = parse_chart_html(_FAKE_HTML)
    assert len(rows) == 3
    r1 = rows[0]
    assert r1["rank"] == 1
    assert r1["song_id"] == "900001"
    assert r1["song_title"] == "WAVE"
    # Artist normalize: " - 페이지 이동" 접미사 strip.
    # 다중 artist는 list로 반환 (collab 케이스).
    assert "PLAVE" in r1["artists"]


def test_parse_chart_html_handles_collab_multiple_artists():
    rows = parse_chart_html(_FAKE_HTML)
    r3 = rows[2]
    assert r3["rank"] == 77
    # collab 케이스 — 두 artist 모두 추출.
    assert "PLAVE" in r3["artists"]
    assert "다른가수" in r3["artists"]


def test_parse_returns_empty_for_blank_html():
    assert parse_chart_html("") == []
    assert parse_chart_html("<html></html>") == []


def test_collect_global_no_groups_seeded():
    fetcher = MagicMock()
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: [])
    res = c.collect_global()
    assert res.rows_inserted == 0
    assert "no_groups_seeded" in res.errors


def test_collect_global_matches_group_and_emits_update_with_lowest_rank():
    """PLAVE charts at #1 (WAVE) and #77 (콜라보곡). Peak rank = 1."""
    page = MagicMock()
    page.html_content = _FAKE_HTML
    page.body = _FAKE_HTML
    fetcher = MagicMock()
    fetcher.get.return_value = page

    groups = [
        {"key": "plave", "name": "PLAVE", "name_kr": "플레이브", "aliases": []},
        {"key": "isedol", "name": "ISEGYE IDOL", "name_kr": "이세계아이돌",
         "aliases": ["이세돌"]},
        {"key": "skinz", "name": "SKINZ", "name_kr": "스킨즈", "aliases": []},
    ]
    c = MelonChartCollector(fetcher=fetcher, groups_loader=lambda: groups)
    res = c.collect_global()

    # PLAVE matched (peak 1) + ISEDOL matched (peak 42). SKINZ no match → no row.
    assert res.rows_inserted == 2
    sqls = [s[0] for s in res.statements]
    params = [s[1] for s in res.statements]
    # All statements should be UPDATE on agg_summary with peak rank.
    for sql in sqls:
        assert "UPDATE agg_summary" in sql
        assert "melon_top100_peak" in sql
    by_key = {p[1]: p[0] for p in params}    # params: [peak, group_key]
    assert by_key["plave"] == 1
    assert by_key["isedol"] == 42


def test_collect_global_unreachable_chart():
    page = MagicMock()
    page.html_content = ""
    page.body = ""
    fetcher = MagicMock()
    fetcher.get.return_value = page
    c = MelonChartCollector(
        fetcher=fetcher,
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE",
                                 "name_kr": "플레이브", "aliases": []}],
    )
    res = c.collect_global()
    assert res.rows_inserted == 0
    assert "chart_unreachable" in res.errors
