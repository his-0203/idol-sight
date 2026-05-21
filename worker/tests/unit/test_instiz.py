from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.instiz import InstizCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _isedol() -> GroupConfig:
    return GroupConfig(
        key="isedol", name="ISEDOL", name_kr="이세계아이돌",
        debut_date="2021-12-17",
        yt_channel_id=None, dc_gallery_id="isedol", naver_query="이세계아이돌",
        context_keywords=["이세계아이돌"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def _load_page():
    html = (FIXTURES / "instiz_hotlist.html").read_text()
    return Adaptor(content=html, url="https://www.instiz.net/pt/")


def test_parses_instiz_fixture():
    """Load a captured instiz hot-list HTML and verify post extraction."""
    fetcher = MagicMock()
    fetcher.get.return_value = _load_page()
    stealthy = MagicMock()  # should never be hit when tier-1 returns rows

    c = InstizCollector(fetcher=fetcher, stealthy=stealthy)
    result = c.collect(_isedol())

    fetcher.get.assert_called_once()
    stealthy.fetch.assert_not_called()
    assert result.rows_inserted >= 1
    # Each post creates 2 statements (community_posts + community_post_stats).
    assert len(result.statements) == 2 * result.rows_inserted

    # First statement is community_posts, second is community_post_stats.
    sql0, params0 = result.statements[0]
    sql1, params1 = result.statements[1]
    assert "community_posts" in sql0 and "instiz" in params0
    assert "community_post_stats" in sql1
    # Sanity: the matched row is the one mentioning the context keyword.
    assert any("이세계아이돌" in str(p) for p in params0)


def test_supplemental_board_triggers_second_fetch():
    """V2.28: instiz_supplemental_boards 가 비어 있지 않으면 primary (pt)
    + 보조 path 각각에 대해 fetcher.get 가 1 회씩 호출된다. tier-1 이
    빈 결과를 반환할 때만 stealthy fallback 이 추가 트리거된다."""
    fetcher = MagicMock()
    fetcher.get.return_value = _load_page()
    stealthy = MagicMock()

    isedol_with_supp = GroupConfig(
        key="isedol", name="ISEDOL", name_kr="이세계아이돌",
        debut_date="2021-12-17",
        yt_channel_id=None, dc_gallery_id="isedol", naver_query="이세계아이돌",
        context_keywords=["이세계아이돌"],
        blacklist_phrases=[], twitter_handles=[],
        instiz_supplemental_boards=["musicpd"],
    )

    c = InstizCollector(fetcher=fetcher, stealthy=stealthy)
    result = c.collect(isedol_with_supp)

    # primary + 1 supplemental = 2 tier-1 fetches. tier-1 이 매번 의미
    # 있는 결과를 반환하므로 stealthy fallback 은 발동하지 않는다.
    assert fetcher.get.call_count == 2
    stealthy.fetch.assert_not_called()
    assert result.errors == []
