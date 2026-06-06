"""Tests for the hanteonews-based Hanteo collector.

The collector now reads hanteonews.com chart announcement articles instead
of the (JS-protected) hanteochart.com SPA. Tests use small fake HTML
documents that match the prose conventions used by hanteonews.
"""

from unittest.mock import MagicMock

from idol_sight.collectors.hanteo import HanteoCollector


def test_match_group_does_not_steal_neighbour_sales_in_multi_group_text():
    """Multi-group article: each group owns the span from its mention to the
    next group's. The backward look-back must not read the previous group's
    trailing 초동 sales as ours."""
    text = ("플레이브가 정규 1집으로 판매량 50,000장 기록. "
            "이세계아이돌은 미니앨범 판매량 30,000장.")
    plave = {"key": "plave", "name": "PLAVE", "name_kr": "플레이브"}
    isedol = {"key": "isedol", "name": "ISEDOL", "name_kr": "이세계아이돌"}

    plave_hit = HanteoCollector._match_group(text, plave, ["ISEDOL", "이세계아이돌"])
    isedol_hit = HanteoCollector._match_group(text, isedol, ["PLAVE", "플레이브"])

    assert plave_hit is not None and plave_hit[2] == 50_000   # (album, rank, sales, index)
    assert isedol_hit is not None and isedol_hit[2] == 30_000  # not 50,000


def test_match_group_keeps_lookback_when_no_other_group_near():
    """Single-group text still uses the backward window (e.g. '1위 PLAVE')."""
    text = "이번 주 1위 PLAVE, 판매량 50,000장."
    plave = {"key": "plave", "name": "PLAVE", "name_kr": "플레이브"}
    hit = HanteoCollector._match_group(text, plave, [])
    assert hit is not None
    _album, rank, sales, _index = hit
    assert sales == 50_000
    assert rank == 1   # backward look-back captured "1위" before the name


def _make_fetcher(html_by_url: dict[str, str]) -> MagicMock:
    """Stub fetcher whose .get(url) returns an object exposing
    .html_content matching the supplied URL → HTML map."""
    def _get(url: str, **_: object) -> object:
        page = MagicMock()
        page.html_content = html_by_url.get(url, "")
        # Defensive: also set generic fallbacks the collector tries.
        page.body = page.html_content
        page.raw_html = page.html_content
        return page
    fetcher = MagicMock()
    fetcher.get.side_effect = _get
    return fetcher


def test_collect_per_group_is_a_no_op():
    """Per-group collect returns empty without raising — global is the work."""
    c = HanteoCollector(
        fetcher=_make_fetcher({}),
        groups_loader=lambda: [],
    )
    res = c.collect(group=MagicMock(key="plave"))
    assert res.rows_inserted == 0


def test_no_groups_seeded_returns_error():
    c = HanteoCollector(
        fetcher=_make_fetcher({}),
        groups_loader=lambda: [],
    )
    res = c.collect_global()
    assert res.rows_inserted == 0
    assert "no_groups_seeded" in res.errors


def test_collect_global_extracts_sales_for_matched_group():
    """A weekly summary article that mentions PLAVE + 'Caligo Pt.2' +
    sales count produces one hanteo_weekly INSERT."""
    list_html = """
    <html><body>
      <a href="/ko/article/91000">[일간랭킹: 5월 4일] 스킵해야 할 일간 글</a>
      <a href="/ko/article/91001">4월 5주 한터 주간차트 발표…주인공은 플레이브</a>
    </body></html>
    """
    weekly_article = """
    <html><body><article>
      4월 5주 한터 주간차트 발표
      플레이브가 'Caligo Pt.2'로 4월 5주 음반 지수 1,091,820.80점
      (판매량 991,850장)을 기록하며 주간 음반차트 2위에 올랐다.
    </article></body></html>
    """
    daily_article = "<html><body>일간랭킹 본문이라 무시되어야 한다</body></html>"

    html_by_url = {
        "https://www.hanteonews.com/ko/article/chart": list_html,
        "https://www.hanteonews.com/ko/article/91001": weekly_article,
        "https://www.hanteonews.com/ko/article/91000": daily_article,
    }
    seeded = [
        {"key": "plave",  "name": "PLAVE",  "name_kr": "플레이브"},
        {"key": "isedol", "name": "ISEDOL", "name_kr": "이세계아이돌"},
    ]
    c = HanteoCollector(
        fetcher=_make_fetcher(html_by_url),
        groups_loader=lambda: seeded,
    )
    result = c.collect_global()

    assert result.rows_inserted == 1
    sql, params = result.statements[0]
    assert "hanteo_weekly" in sql
    assert params[2] == "plave"             # group_key
    assert params[3] == "Caligo Pt.2"       # album (extracted from quotes)
    assert params[4] == 2                   # rank
    assert params[5] == 991850              # sales (commas stripped)
    assert "hanteonews/91001" in (params[6] or "")


def test_collect_global_skips_when_only_index_no_sales():
    """If the article has 음반 지수 but not 판매량 for the group, we still
    record the row (index alone is useful) — but only if either is present."""
    list_html = '<a href="/ko/article/91002">주간차트 발표</a>'
    article = """
    <html><body>
      4월 4주 주간차트 — 플레이브 음반 지수 100.50점으로 5위.
    </body></html>
    """
    c = HanteoCollector(
        fetcher=_make_fetcher({
            "https://www.hanteonews.com/ko/article/chart": list_html,
            "https://www.hanteonews.com/ko/article/91002": article,
        }),
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE", "name_kr": "플레이브"}],
    )
    result = c.collect_global()
    # index only, no sales — still recorded (note carries the index value).
    assert result.rows_inserted == 1
    _, params = result.statements[0]
    assert params[5] is None                # sales unknown
    assert "idx=100.5" in (params[6] or "")


def test_collect_global_returns_zero_when_no_group_matches():
    list_html = '<a href="/ko/article/91003">주간차트 발표</a>'
    article = "<html><body>방탄소년단 주간 차트 1위 (판매량 1,000,000장)</body></html>"
    c = HanteoCollector(
        fetcher=_make_fetcher({
            "https://www.hanteonews.com/ko/article/chart": list_html,
            "https://www.hanteonews.com/ko/article/91003": article,
        }),
        groups_loader=lambda: [{"key": "plave", "name": "PLAVE", "name_kr": "플레이브"}],
    )
    result = c.collect_global()
    assert result.rows_inserted == 0
    assert result.statements == []
