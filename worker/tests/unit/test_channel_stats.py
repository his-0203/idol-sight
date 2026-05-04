import json
from pathlib import Path
from unittest.mock import MagicMock

from idol_sight.collectors.channel_stats import ChannelStatsCollector
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


def _members_loader_returning(rows):
    return MagicMock(return_value=rows)


def _api_returning(channels: dict):
    def _get(url, *, params=None, **_):
        r = MagicMock()
        r.json.return_value = channels
        r.raise_for_status.return_value = None
        return r
    client = MagicMock()
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    client.get = _get
    return client


def test_channel_stats_emits_one_row_per_channel():
    channels = json.loads((FIXTURES / "youtube_channels_response.json").read_text())
    http = _api_returning(channels)
    members = []   # no solo channels for this test
    c = ChannelStatsCollector(
        api_key="fake",
        http_factory=lambda: http,
        members_loader=_members_loader_returning(members),
    )
    result = c.collect(_plave())

    assert result.rows_inserted == 1
    sql, params = result.statements[0]
    assert "youtube_channel_stats" in sql
    assert params[0] == "UCPZIPuQPrfrUG9Xe_okEmQA"
    assert params[2] == 1140000
    assert params[3] == 160608883
    assert params[4] == 24


def test_channel_stats_includes_member_solo_channels():
    channels = {
      "items": [
        {"id": "UCPZIPuQPrfrUG9Xe_okEmQA", "statistics":
            {"subscriberCount":"1140000","viewCount":"160608883","videoCount":"24"}},
        {"id": "UCmemberSolo", "statistics":
            {"subscriberCount":"50000","viewCount":"1000000","videoCount":"5"}},
      ]
    }
    http = _api_returning(channels)
    c = ChannelStatsCollector(
        api_key="fake",
        http_factory=lambda: http,
        members_loader=_members_loader_returning([
            {"yt_channel_id": "UCmemberSolo"},
        ]),
    )
    result = c.collect(_plave())
    assert result.rows_inserted == 2
