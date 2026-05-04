from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.theqoo import TheQooCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def test_parses_theqoo_fixture():
    """Load a captured TheQoo hot-list HTML and verify post extraction."""
    html = (FIXTURES / "theqoo_hotpost.html").read_text()
    page = Adaptor(content=html, url="https://theqoo.net/hot")

    stealthy = MagicMock()
    stealthy.fetch.return_value = page

    c = TheQooCollector(stealthy=stealthy)
    result = c.collect(_plave())

    stealthy.fetch.assert_called_once()
    assert result.rows_inserted >= 1
    # Each post creates 2 statements (community_posts + community_post_stats).
    assert len(result.statements) == 2 * result.rows_inserted

    # First INSERT must hit community_posts with platform='theqoo'.
    sql0, params0 = result.statements[0]
    sql1, params1 = result.statements[1]
    assert "community_posts" in sql0
    assert "theqoo" in params0
    assert "community_post_stats" in sql1
    # Sanity: the matched row mentions one of the context keywords.
    assert any(
        ("플레이브" in str(p)) or ("PLAVE" in str(p))
        for p in params0
    )
