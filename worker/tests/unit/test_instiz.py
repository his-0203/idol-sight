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


def test_parses_instiz_fixture():
    """Load a captured instiz hot-list HTML and verify post extraction."""
    html = (FIXTURES / "instiz_hotlist.html").read_text()
    page = Adaptor(content=html, url="https://www.instiz.net/pt/")

    fetcher = MagicMock()
    fetcher.get.return_value = page
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
