import json
from pathlib import Path
from unittest.mock import MagicMock

from idol_sight.collectors.youtube import YouTubeCollector, _extract_hashtags
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


def _miiwan() -> GroupConfig:
    return GroupConfig(
        key="miiwan", name="MiiWAN", name_kr="미완소년",
        debut_date="2026-06-01",
        yt_channel_id="UC_MIIWAN_OFFICIAL",
        dc_gallery_id="miiwan", naver_query="미완소년",
        context_keywords=["미완소년"], blacklist_phrases=[], twitter_handles=[],
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


def test_youtube_collector_fans_out_across_member_channels():
    """ISEDOL-style group: members_loader returns solo channels and the
    collector should run search.list once per channel, dedupe overlapping
    video IDs, and stamp every emitted row with the group_key.
    """
    # Group channel returns video gA; member channels return gA (collab,
    # duplicate) + mA + mB. Expect 3 unique video IDs hitting videos.list.
    calls: list[str] = []

    def _get(url, *, params=None, **_):
        r = MagicMock()
        params = params or {}
        if "/search" in url:
            calls.append(params["channelId"])
            ch = params["channelId"]
            if ch == "UC_GROUP":
                r.json.return_value = {"items": [
                    {"id": {"videoId": "gA"}},
                ]}
            elif ch == "UC_M1":
                r.json.return_value = {"items": [
                    {"id": {"videoId": "gA"}},  # collab — duplicate
                    {"id": {"videoId": "mA"}},
                ]}
            elif ch == "UC_M2":
                r.json.return_value = {"items": [
                    {"id": {"videoId": "mB"}},
                ]}
            else:
                r.json.return_value = {"items": []}
        elif "/videos" in url:
            ids = (params.get("id") or "").split(",")
            r.json.return_value = {"items": [
                {
                    "id": vid,
                    "snippet": {"title": f"Video {vid}", "channelId": "UC_X"},
                    "contentDetails": {"duration": "PT3M"},
                    "statistics": {"viewCount": "100", "likeCount": "5", "commentCount": "1"},
                }
                for vid in ids
            ]}
        else:
            r.json.return_value = {}
        r.raise_for_status.return_value = None
        return r

    http = MagicMock()
    http.__enter__ = MagicMock(return_value=http)
    http.__exit__ = MagicMock(return_value=False)
    http.get = _get

    g = GroupConfig(
        key="isedol", name="ISEDOL", name_kr="이세계아이돌",
        debut_date="2021-12-17",
        yt_channel_id="UC_GROUP",
        dc_gallery_id="isekaidol", naver_query="이세계아이돌",
        context_keywords=[], blacklist_phrases=[], twitter_handles=[],
    )

    def loader(group_key):
        assert group_key == "isedol"
        return [{"yt_channel_id": "UC_M1"}, {"yt_channel_id": "UC_M2"}]

    c = YouTubeCollector(api_key="fake", http_factory=lambda: http, members_loader=loader)
    result = c.collect(g)

    # 3 unique videos (gA deduped) → 6 statements (video + stats per id).
    assert result.rows_inserted == 3
    assert len(result.statements) == 6
    # search.list invoked once per channel, in order.
    assert calls == ["UC_GROUP", "UC_M1", "UC_M2"]
    # Every youtube_videos INSERT stamps group_key='isedol'.
    for sql, params in result.statements:
        if "youtube_videos" in sql and "stats" not in sql:
            assert params[1] == "isedol"


def test_extract_hashtags_merges_snippet_tags_and_description():
    sn = {
        "tags": ["MiiWAN", "kpop"],
        "description": "첫 미완소년 무대 영상! #miiwan #마하진 #데뷔",
    }
    out = _extract_hashtags(sn)
    # snippet.tags 가 먼저, description 토큰이 뒤. 'miiwan' 은 'MiiWAN'
    # 의 case-insensitive 중복으로 dedupe — 첫 등장 (snippet.tags) 유지.
    assert out == ["MiiWAN", "kpop", "마하진", "데뷔"]


def test_extract_hashtags_returns_none_when_empty():
    assert _extract_hashtags({}) is None
    assert _extract_hashtags({"tags": [], "description": ""}) is None
    assert _extract_hashtags({"description": "no hashtags here, sorry"}) is None


def test_extract_hashtags_strips_short_tokens():
    # 1자 토큰은 제외 — '#a', '#가' 같은 무의미한 매칭 방지.
    sn = {"description": "#a #ab #가 #마하진"}
    assert _extract_hashtags(sn) == ["ab", "마하진"]


def test_youtube_collector_populates_tags_for_miiwan():
    """MiiWAN 그룹: snippet.tags + description 해시태그가 INSERT params 에 JSON 으로 직렬화된다."""
    search = {"items": [{"id": {"videoId": "miiv1"}}]}
    videos = {
        "items": [
            {
                "id": "miiv1",
                "snippet": {
                    "title": "MiiWAN Debut Teaser",
                    "publishedAt": "2026-05-01T09:00:00Z",
                    "channelId": "UC_MIIWAN_OFFICIAL",
                    "tags": ["MiiWAN", "데뷔"],
                    "description": "공식 티저 영상입니다 #miiwan #마하진",
                },
                "contentDetails": {"duration": "PT1M30S"},
                "statistics": {"viewCount": "10000", "likeCount": "500", "commentCount": "30"},
            }
        ]
    }
    http = _api_returning(search, videos)
    c = YouTubeCollector(api_key="fake", http_factory=lambda: http)
    result = c.collect(_miiwan())

    sql_v, params_v = result.statements[0]
    assert "youtube_videos" in sql_v and "tags" in sql_v
    tags_param = params_v[-1]
    assert tags_param is not None
    parsed = json.loads(tags_param)
    # snippet.tags 먼저 → description 토큰. 'miiwan' case-insensitive dedupe.
    assert parsed == ["MiiWAN", "데뷔", "마하진"]


def test_youtube_collector_populates_tags_for_non_miiwan_group():
    """V2.5.2: 전 그룹 확장 — PLAVE 도 동일 fixture 에서 tags JSON 저장."""
    search = {"items": [{"id": {"videoId": "plv1"}}]}
    videos = {
        "items": [
            {
                "id": "plv1",
                "snippet": {
                    "title": "PLAVE Stage",
                    "publishedAt": "2026-04-01T09:00:00Z",
                    "channelId": "UCPZIPuQPrfrUG9Xe_okEmQA",
                    "tags": ["PLAVE", "kpop"],
                    "description": "무대 영상 #plave #caligo #노아",
                },
                "contentDetails": {"duration": "PT3M0S"},
                "statistics": {"viewCount": "100000", "likeCount": "5000", "commentCount": "200"},
            }
        ]
    }
    http = _api_returning(search, videos)
    c = YouTubeCollector(api_key="fake", http_factory=lambda: http)
    result = c.collect(_plave())

    sql_v, params_v = result.statements[0]
    assert "youtube_videos" in sql_v
    tags_param = params_v[-1]
    assert tags_param is not None
    parsed = json.loads(tags_param)
    # 'plave' 는 'PLAVE' 와 case-insensitive 중복 → 'PLAVE' 만 유지.
    assert parsed == ["PLAVE", "kpop", "caligo", "노아"]


def test_youtube_collector_tags_null_when_snippet_empty():
    """tags/description 양쪽이 비어있으면 tags 컬럼은 NULL — 그룹 무관."""
    search = {"items": [{"id": {"videoId": "vEmpty"}}]}
    videos = {
        "items": [
            {
                "id": "vEmpty",
                "snippet": {
                    "title": "Untagged Video",
                    "publishedAt": "2026-04-01T09:00:00Z",
                    "channelId": "UC_X",
                    # tags / description 모두 없음
                },
                "contentDetails": {"duration": "PT2M0S"},
                "statistics": {"viewCount": "1000", "likeCount": "10", "commentCount": "1"},
            }
        ]
    }
    http = _api_returning(search, videos)
    c = YouTubeCollector(api_key="fake", http_factory=lambda: http)
    result = c.collect(_plave())

    sql_v, params_v = result.statements[0]
    assert params_v[-1] is None
