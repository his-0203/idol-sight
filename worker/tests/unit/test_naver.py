from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.naver import NaverCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE", "버추얼"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def test_parses_naver_search_fixture():
    """Load a captured Naver search HTML and verify article extraction."""
    html = (FIXTURES / "naver_search.html").read_text()
    page = Adaptor(content=html, url="https://search.naver.com/search.naver?where=news")

    fetcher = MagicMock()
    fetcher.get.return_value = page

    collector = NaverCollector(fetcher=fetcher)
    result = collector.collect(_plave())

    # Without a members_loader the collector still emits >1 fetch (the
    # group anchors '플레이브' and 'PLAVE' both expand). All fetches
    # see the SAME fixture; dedupe by url_hash collapses them back to
    # the unique-article count.
    assert fetcher.get.call_count >= 1
    assert result.rows_inserted >= 1
    # Each row corresponds to one INSERT statement.
    assert len(result.statements) == result.rows_inserted
    # Sanity-check the first statement's params.
    first_sql, first_params = result.statements[0]
    assert "naver_articles" in first_sql
    assert first_params[1] == "plave"             # group_key
    assert isinstance(first_params[2], str) and first_params[2]   # title


def test_skips_when_no_naver_query():
    """A group with no naver_query AND no name/name_kr is a hard skip
    (matches the legacy single-fetch behaviour that the orchestrator
    relies on for its 'no naver_query' crawl_meta error label)."""
    fetcher = MagicMock()
    collector = NaverCollector(fetcher=fetcher)
    g = _plave()
    # Strip every text identifier so expand_search_terms returns [].
    g_no_q = GroupConfig(**{**g.__dict__,
                            "naver_query": None,
                            "name": "", "name_kr": ""})
    result = collector.collect(g_no_q)
    fetcher.get.assert_not_called()
    assert result.rows_inserted == 0
    assert any("no naver_query" in e for e in result.errors)


def test_multi_query_dedupes_by_url_hash():
    """When members are supplied, the collector issues one fetch per
    derived query AND merges the results — but a duplicate article
    (same URL appearing under two different queries) must collapse to
    a single naver_articles INSERT, otherwise we'd double-count news
    for cohort views.
    """
    html = (FIXTURES / "naver_search.html").read_text()

    fetcher = MagicMock()
    # Same fixture returned for every fetch → every query yields the
    # same article set. After dedupe, the count must equal the unique
    # article count of one fetch (NOT N × that count).
    fetcher.get.return_value = Adaptor(
        content=html,
        url="https://search.naver.com/search.naver?where=news",
    )

    members_loader = MagicMock(return_value=[
        {"name": "노아", "name_en": "Noah"},
        {"name": "예준", "name_en": "Yejun"},
    ])
    collector = NaverCollector(
        fetcher=fetcher,
        members_loader=members_loader,
        sleep_seconds=0.0,
        sleeper=lambda _: None,
    )

    # Single-fetch reference run so we know the dedupe target.
    ref_collector = NaverCollector(fetcher=fetcher)
    ref = ref_collector.collect(_plave())

    fetcher.get.reset_mock()
    multi = collector.collect(_plave())

    # Multi-query path actually fetches more than once (proves the
    # expansion is wired) AND ends up with exactly the reference's
    # article count after dedupe (proves the merge collapses dupes).
    assert fetcher.get.call_count > 1
    assert multi.rows_inserted == ref.rows_inserted


def test_falls_back_to_single_fetch_without_members_loader():
    """Backward compat: if no members_loader is supplied, the collector
    behaves exactly like the legacy single-fetch path."""
    html = (FIXTURES / "naver_search.html").read_text()
    fetcher = MagicMock()
    fetcher.get.return_value = Adaptor(
        content=html,
        url="https://search.naver.com/search.naver?where=news",
    )
    collector = NaverCollector(fetcher=fetcher)
    result = collector.collect(_plave())
    # Without members, the expansion still emits the baseline + KR + EN
    # group anchors (typically 3 distinct strings: '플레이브',
    # 'PLAVE', 'plave' is folded). We assert ≥1 fetch and that all
    # rows ended up under group_key='plave'.
    assert fetcher.get.call_count >= 1
    assert all(stmt[1][1] == "plave" for stmt in result.statements)
