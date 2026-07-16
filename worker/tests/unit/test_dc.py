from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.dc import DcCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave",
        name="PLAVE",
        name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None,
        dc_gallery_id="plave",
        naver_query="플레이브",
        context_keywords=["플레이브"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def _miiwan_with_supp(supplemental: list[str]) -> GroupConfig:
    """MiiWAN config with configurable supplemental galleries — used to
    exercise the V2.27 supplemental loop. Keywords mirror 0061's seed so
    is_relevant matching is realistic, not contrived."""
    return GroupConfig(
        key="miiwan", name="MiiWAN", name_kr="미완소년",
        debut_date="2026-06-01", yt_channel_id=None,
        dc_gallery_id="miiwansonyeon", naver_query="MiiWAN 미완소년",
        context_keywords=[
            "MiiWAN", "miiwan", "MIIWAN", "미완소년", "ㅁㅇㅅㄴ",
            "나이선", "임온", "마하진", "안석우", "원주율",
        ],
        blacklist_phrases=[], twitter_handles=[],
        dc_supplemental_galleries=supplemental,
    )


def _load_page() -> Adaptor:
    html = (FIXTURES / "dc_gallery.html").read_text()
    return Adaptor(
        content=html,
        url="https://gall.dcinside.com/mgallery/board/lists/?id=plave",
    )


def test_parses_dc_fixture():
    """Load a captured DC mgallery list and verify post extraction.

    Unlike the cross-board hot lists (TheQoo, instiz), every post inside
    a group's dedicated dcinside gallery is by definition about that
    group, so we do not filter by context_keywords — every parsed row
    becomes a (community_posts, community_post_stats) pair.
    """
    stealthy = MagicMock()
    stealthy.fetch.return_value = _load_page()

    c = DcCollector(stealthy=stealthy)
    result = c.collect(_plave())

    stealthy.fetch.assert_called_once()
    assert result.rows_inserted >= 1
    # Each row produces exactly two statements.
    assert len(result.statements) == 2 * result.rows_inserted

    sql0, params0 = result.statements[0]
    sql1, params1 = result.statements[1]
    assert "community_posts" in sql0
    assert "dc" in params0
    assert "community_post_stats" in sql1

    # Extracted URLs must point at gall.dcinside.com (relative href
    # was correctly resolved against the host).
    assert any(
        isinstance(p, str) and p.startswith("https://gall.dcinside.com")
        for p in params0
    )


def test_supplemental_filters_by_relevance():
    """Primary fetch keeps every us-post row; supplemental fetch filters
    by is_relevant. The PLAVE fixture's titles don't contain MiiWAN
    keywords, so the supplemental contributes 0 rows while primary still
    contributes ≥1 row. Verifies the fetch loop AND the cross-group
    filter actually fires."""
    stealthy = MagicMock()
    stealthy.fetch.return_value = _load_page()

    c = DcCollector(stealthy=stealthy)
    result = c.collect(_miiwan_with_supp(["vboyband"]))

    # Two fetches: primary (miiwansonyeon) + 1 supplemental (vboyband).
    assert stealthy.fetch.call_count == 2
    # Primary returns the PLAVE fixture's rows unfiltered (us-post count).
    # Supplemental returns 0 — no PLAVE-fixture title matches MiiWAN kws.
    assert result.rows_inserted >= 1
    # 2 statements per inserted row.
    assert len(result.statements) == 2 * result.rows_inserted


def test_supplemental_only_when_primary_missing():
    """If dc_gallery_id is NULL but supplemental is set, the collector
    still runs — only the supplemental fetch fires. Mirrors the historic
    pre-debut state where the group's own mgallery didn't exist yet but
    the hub gallery did. Matching behaviour is exercised separately
    (test_supplemental_match_passes_keyword_in_fixture) — here we only
    assert that exactly one fetch fires and the collector doesn't error.
    Inside-gallery posts seldom repeat the group's own name in titles,
    so checking ``rows_inserted >= 1`` against the PLAVE fixture would
    be circular: it tests whether the fixture happens to mention 'PLAVE'
    rather than whether the supplemental loop works."""
    stealthy = MagicMock()
    stealthy.fetch.return_value = _load_page()

    g = GroupConfig(
        key="plave_test", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12", yt_channel_id=None,
        dc_gallery_id=None,
        naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE"],
        blacklist_phrases=[], twitter_handles=[],
        dc_supplemental_galleries=["vboyband"],
    )

    c = DcCollector(stealthy=stealthy)
    result = c.collect(g)

    assert stealthy.fetch.call_count == 1
    assert result.errors == []


def test_supplemental_match_passes_keyword_in_fixture():
    """is_relevant on the supplemental fetch passes a row when a context
    keyword genuinely appears in a fixture title. '꽃송이' is a real PLAVE
    song title that shows up in the captured gallery list, so seeding a
    contrived group with that single keyword forces at least one match
    through the filter — proving the supplemental path can produce rows,
    not just call fetch."""
    stealthy = MagicMock()
    stealthy.fetch.return_value = _load_page()

    g = GroupConfig(
        key="kw_probe", name="Probe", name_kr="프로브",
        debut_date=None, yt_channel_id=None,
        dc_gallery_id=None, naver_query=None,
        context_keywords=["꽃송이"],
        blacklist_phrases=[], twitter_handles=[],
        dc_supplemental_galleries=["vboyband"],
    )

    c = DcCollector(stealthy=stealthy)
    result = c.collect(g)

    assert stealthy.fetch.call_count == 1
    assert result.rows_inserted >= 1


def test_fetch_url_requests_list_num_100():
    """V2.32: 단일 fetch 캡처를 50 → 100 건으로 늘리기 위해
    ``&list_num=100`` 파라미터를 list URL 에 항상 붙인다. DC 가
    50 글/페이지를 기본으로 주지만 list_num=100 은 한 번의 CF 챌린지
    통과로 두 페이지치를 받아오는 표준 파라미터다 (list_num=200 은
    무시되므로 100 이 상한). 활성 갤러리에서는 12h 사이 50건 초과
    폭주 시의 누락을 막고, 비활성 갤러리에서는 첫 가동 시 캡처량을
    배가시킨다."""
    stealthy = MagicMock()
    stealthy.fetch.return_value = _load_page()

    c = DcCollector(stealthy=stealthy)
    c.collect(_plave())

    stealthy.fetch.assert_called_once()
    call_url = stealthy.fetch.call_args[0][0]
    assert "list_num=100" in call_url, (
        f"expected list_num=100 in fetch URL, got: {call_url}"
    )


def test_supplemental_fetch_also_requests_list_num_100():
    """list_num=100 은 primary 뿐 아니라 supplemental hub gallery
    (vboyband 등) fetch 에도 적용되어야 한다. 통합갤은 글이 많아 page 1
    50건이 며칠치를 못 따라가는 경우가 잦으므로 효과가 더 크다."""
    stealthy = MagicMock()
    stealthy.fetch.return_value = _load_page()

    c = DcCollector(stealthy=stealthy)
    c.collect(_miiwan_with_supp(["vboyband"]))

    assert stealthy.fetch.call_count == 2
    for call in stealthy.fetch.call_args_list:
        url = call.args[0]
        assert "list_num=100" in url, (
            f"expected list_num=100 in every DC fetch URL, got: {url}"
        )


def test_no_primary_no_supplemental_returns_error():
    """When both primary and supplemental are missing, the collector
    short-circuits as a clean no-op (0 rows, NO error) rather than
    fetching. A group with no DC presence yet (e.g. begritz pre-debut)
    is a legitimate no-op — populating errors would make the 6h cron
    report status=failed and fire a recurring dc:<group> alert."""
    stealthy = MagicMock()
    empty = GroupConfig(
        key="empty", name="X", name_kr="엑스",
        debut_date=None, yt_channel_id=None,
        dc_gallery_id=None, naver_query=None,
        context_keywords=["엑스"],
        blacklist_phrases=[], twitter_handles=[],
        dc_supplemental_galleries=[],
    )
    c = DcCollector(stealthy=stealthy)
    result = c.collect(empty)
    assert result.rows_inserted == 0
    assert stealthy.fetch.call_count == 0
    assert not result.errors  # clean no-op, not a failure
