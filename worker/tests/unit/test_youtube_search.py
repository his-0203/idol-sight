import httpx
from idol_sight.collectors.youtube import YouTubeCollector


class _StubHTTP:
    """httpx.Client 대체 — URL 경로별 고정 응답."""
    def __init__(self, routes):
        self._routes = routes  # {path_substr: json}
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get(self, url, params=None):
        for needle, payload in self._routes.items():
            if needle in url:
                return httpx.Response(200, json=payload, request=httpx.Request("GET", url))
        return httpx.Response(200, json={"items": []}, request=httpx.Request("GET", url))


def _collector(routes):
    return YouTubeCollector(api_key="k", http_factory=lambda: _StubHTTP(routes))


def test_search_shorts_returns_video_ids():
    routes = {"/search": {"items": [
        {"id": {"videoId": "a1"}},
        {"id": {"videoId": "b2"}},
    ]}}
    yt = _collector(routes)
    ids = yt.search_shorts(query="#챌린지", published_after="2026-05-26T00:00:00Z")
    assert ids == ["a1", "b2"]


def test_fetch_stats_parses_views_and_duration():
    routes = {"/videos": {"items": [
        {"id": "a1", "statistics": {"viewCount": "1000", "likeCount": "10",
                                    "commentCount": "2"},
         "snippet": {"title": "t"}, "contentDetails": {"duration": "PT45S"}},
    ]}}
    yt = _collector(routes)
    stats = yt.fetch_stats(["a1"])
    assert stats == [{"video_id": "a1", "views": 1000, "likes": 10, "comments": 2,
                      "title": "t", "channel": None, "duration_sec": 45}]


def test_fetch_stats_missing_duration_is_zero():
    routes = {"/videos": {"items": [
        {"id": "a1", "statistics": {"viewCount": "5"}, "snippet": {"title": "t"}},
    ]}}
    yt = _collector(routes)
    assert yt.fetch_stats(["a1"])[0]["duration_sec"] == 0


def test_fetch_stats_empty_ids_no_call():
    yt = _collector({})
    assert yt.fetch_stats([]) == []


def test_search_shorts_passes_order():
    captured: dict = {}

    class _Cap:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, params=None):
            captured.update(params or {})
            return httpx.Response(200, json={"items": []},
                                  request=httpx.Request("GET", url))

    yt = YouTubeCollector(api_key="k", http_factory=lambda: _Cap())
    yt.search_shorts(query="q", published_after="2026-01-01T00:00:00Z", order="relevance")
    assert captured["order"] == "relevance"
    # 기본값은 viewCount (지표용)
    yt.search_shorts(query="q", published_after="2026-01-01T00:00:00Z")
    assert captured["order"] == "viewCount"
