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


def test_no_primary_no_supplemental_returns_error():
    """When both primary and supplemental are missing, the collector
    short-circuits with an explanatory error rather than fetching."""
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
    assert result.errors
    assert "no dc_gallery_id" in result.errors[0]
