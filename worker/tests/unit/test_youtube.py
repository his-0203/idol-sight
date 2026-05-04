import json
from pathlib import Path
from unittest.mock import MagicMock

from idol_sight.collectors.youtube import YouTubeCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id="UCPZIPuQPrfrUG9Xe_okEmQA",
        dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브"], blacklist_phrases=[], twitter_handles=[],
    )


def _api_returning(search: dict, videos: dict):
    """Mock httpx.Client.get returning fixture responses based on URL substring."""
    def _get(url, *, params=None, **_):
        r = MagicMock()
        if "/search" in url:
            r.json.return_value = search
        elif "/videos" in url:
            r.json.return_value = videos
        else:
            r.json.return_value = {}
        r.raise_for_status.return_value = None
        return r
    client = MagicMock()
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    client.get = _get
    return client


def test_youtube_collector_emits_video_and_stats_inserts():
    search = json.loads((FIXTURES / "youtube_search_response.json").read_text())
    videos = json.loads((FIXTURES / "youtube_videos_response.json").read_text())

    http = _api_returning(search, videos)
    c = YouTubeCollector(api_key="fake", http_factory=lambda: http)
    result = c.collect(_plave())

    assert result.rows_inserted == len(videos["items"])
    # 2 statements per video: youtube_videos INSERT and youtube_video_stats INSERT
    assert len(result.statements) == 2 * result.rows_inserted
    sql0, params0 = result.statements[0]
    assert "youtube_videos" in sql0
    assert params0[1] == "plave"            # group_key
    sql1, params1 = result.statements[1]
    assert "youtube_video_stats" in sql1


def test_youtube_collector_skips_when_no_channel_id():
    g = _plave()
    g_no = GroupConfig(**{**g.__dict__, "yt_channel_id": None})
    c = YouTubeCollector(api_key="fake", http_factory=MagicMock())
    result = c.collect(g_no)
    assert result.rows_inserted == 0
    assert any("no yt_channel_id" in e for e in result.errors)
