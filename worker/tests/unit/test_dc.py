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


def test_parses_dc_fixture():
    """Load a captured DC mgallery list and verify post extraction.

    Unlike the cross-board hot lists (TheQoo, instiz), every post inside
    a group's dedicated dcinside gallery is by definition about that
    group, so we do not filter by context_keywords — every parsed row
    becomes a (community_posts, community_post_stats) pair.
    """
    html = (FIXTURES / "dc_gallery.html").read_text()
    page = Adaptor(
        content=html,
        url="https://gall.dcinside.com/mgallery/board/lists/?id=plave",
    )

    stealthy = MagicMock()
    stealthy.fetch.return_value = page

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
