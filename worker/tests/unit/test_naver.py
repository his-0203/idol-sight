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

    fetcher.get.assert_called_once()
    assert result.rows_inserted >= 1
    # Each row corresponds to one INSERT statement.
    assert len(result.statements) == result.rows_inserted
    # Sanity-check the first statement's params.
    first_sql, first_params = result.statements[0]
    assert "naver_articles" in first_sql
    assert first_params[1] == "plave"             # group_key
    assert isinstance(first_params[2], str) and first_params[2]   # title


def test_skips_when_no_naver_query():
    fetcher = MagicMock()
    collector = NaverCollector(fetcher=fetcher)
    g = _plave()
    g_no_q = GroupConfig(**{**g.__dict__, "naver_query": None})
    result = collector.collect(g_no_q)
    fetcher.get.assert_not_called()
    assert result.rows_inserted == 0
    assert any("no naver_query" in e for e in result.errors)
