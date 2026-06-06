import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from scrapling.parser import Adaptor

from idol_sight.collectors.twitter import TwitterCollector, _extract_tweet_id
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.mark.parametrize("href,expected", [
    ("/user/status/123456", "123456"),
    ("https://nitter.net/user/status/123456", "123456"),
    # trailing fragment / query / sub-path must be stripped (PK/dedup integrity)
    ("/user/status/123456#m", "123456"),
    ("/user/status/123456?ref_src=twsrc", "123456"),
    ("/user/status/123456/photo/1", "123456"),
    # non-status hrefs → None (skip)
    ("/user/with_replies", None),
    ("/user", None),
    ("", None),
    (None, None),
])
def test_extract_tweet_id(href, expected):
    assert _extract_tweet_id(href) == expected


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id=None, naver_query=None,
        context_keywords=[], blacklist_phrases=[],
        twitter_handles=["plave_official"],
    )


def test_collects_via_nitter_first_instance():
    html = (FIXTURES / "nitter_profile.html").read_text()
    page = Adaptor(content=html, url="https://nitter.net/plave_official")
    fetcher = MagicMock()
    fetcher.get.return_value = page

    c = TwitterCollector(
        nitter_instances=["https://nitter.net"],
        fetcher=fetcher,
    )
    result = c.collect(_plave())
    fetcher.get.assert_called_once()
    assert result.rows_inserted == 2
    sql, params = result.statements[0]
    assert "twitter_posts" in sql
    assert "plave" in params               # group_key


def test_round_robins_through_nitter_pool():
    """If first nitter returns 0 rows, fall through to next."""
    empty_page = Adaptor(content="<html><body></body></html>", url="https://x")
    html = (FIXTURES / "nitter_profile.html").read_text()
    full_page = Adaptor(content=html, url="https://x")
    fetcher = MagicMock()
    fetcher.get.side_effect = [empty_page, full_page]

    c = TwitterCollector(
        nitter_instances=["https://nitter.dead", "https://nitter.alive"],
        fetcher=fetcher,
    )
    result = c.collect(_plave())
    assert fetcher.get.call_count == 2
    assert result.rows_inserted == 2


def test_falls_back_to_oembed_when_all_nitter_fail():
    empty_page = Adaptor(content="<html><body></body></html>", url="https://x")
    fetcher = MagicMock()
    fetcher.get.return_value = empty_page

    oembed = json.loads((FIXTURES / "twitter_oembed.json").read_text())
    oembed_resp = MagicMock()
    oembed_resp.json.return_value = oembed
    oembed_resp.raise_for_status.return_value = None
    http = MagicMock()
    http.__enter__ = MagicMock(return_value=http)
    http.__exit__ = MagicMock(return_value=False)
    http.get = MagicMock(return_value=oembed_resp)

    c = TwitterCollector(
        nitter_instances=["https://a", "https://b"],
        fetcher=fetcher,
        http_factory=lambda: http,
    )
    result = c.collect(_plave())
    # No rows inserted but no exception either — sentinel error_msg recorded.
    assert result.rows_inserted == 0
    assert any("all_twitter_paths_blocked" in e or "oembed" in e for e in result.errors)


def test_no_handles_returns_empty():
    g = _plave()
    g_no = GroupConfig(**{**g.__dict__, "twitter_handles": []})
    c = TwitterCollector(nitter_instances=["x"], fetcher=MagicMock())
    result = c.collect(g_no)
    assert result.rows_inserted == 0
