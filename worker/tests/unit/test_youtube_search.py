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


class _FlakyHTTP:
    """첫 fail_times 회는 429, 이후 200 — burst 레이트리밋 재현. calls 공유."""
    def __init__(self, calls, *, fail_times, ok_payload):
        self._calls = calls
        self._fail_times = fail_times
        self._ok = ok_payload
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def get(self, url, params=None):
        self._calls["n"] += 1
        if self._calls["n"] <= self._fail_times:
            return httpx.Response(429, request=httpx.Request("GET", url))
        return httpx.Response(200, json=self._ok, request=httpx.Request("GET", url))


def test_search_shorts_retries_on_429():
    calls = {"n": 0}
    slept: list[float] = []
    yt = YouTubeCollector(
        api_key="k",
        http_factory=lambda: _FlakyHTTP(
            calls, fail_times=2,
            ok_payload={"items": [{"id": {"videoId": "ok"}}]}),
        sleep=slept.append,
    )
    ids = yt.search_shorts(query="q", published_after="2026-01-01T00:00:00Z")
    assert ids == ["ok"]           # 429 두 번 후 성공
    assert calls["n"] == 3
    assert len(slept) == 2         # 재시도마다 backoff


def test_fetch_stats_retries_on_429():
    calls = {"n": 0}
    slept: list[float] = []
    payload = {"items": [{"id": "a1", "statistics": {"viewCount": "5"},
                          "snippet": {"title": "t"}}]}
    yt = YouTubeCollector(
        api_key="k",
        http_factory=lambda: _FlakyHTTP(calls, fail_times=1, ok_payload=payload),
        sleep=slept.append,
    )
    stats = yt.fetch_stats(["a1"])
    assert stats[0]["views"] == 5
    assert calls["n"] == 2
    assert len(slept) == 1


def test_search_shorts_raises_after_retries_exhausted():
    import pytest
    calls = {"n": 0}
    yt = YouTubeCollector(
        api_key="k",
        http_factory=lambda: _FlakyHTTP(calls, fail_times=99, ok_payload={}),
        sleep=lambda _s: None,
    )
    with pytest.raises(httpx.HTTPStatusError):
        yt.search_shorts(query="q", published_after="2026-01-01T00:00:00Z")


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
