import httpx

from idol_sight.collectors.live_chat import (
    LiveChatReplayScraper,
    _extract_bootstrap,
    _parse_replay,
    ended_broadcasts,
)

WATCH_HTML = '''
<html><head></head><body>
<script>var ytcfg = {};ytcfg.set({"INNERTUBE_API_KEY":"AIza_TEST_KEY",
"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"2.2024"}}});</script>
<script>var ytInitialData = {"contents":{"twoColumnWatchNextResults":
{"conversationBar":{"liveChatRenderer":{"continuations":[
{"reloadContinuationData":{"continuation":"CONT_TOKEN_0"}}]}}}}};</script>
</body></html>
'''


def test_extract_bootstrap_pulls_key_version_and_continuation():
    bs = _extract_bootstrap(WATCH_HTML)
    assert bs["api_key"] == "AIza_TEST_KEY"
    assert bs["client_version"] == "2.2024"
    assert bs["continuation"] == "CONT_TOKEN_0"


def test_extract_bootstrap_returns_none_continuation_when_no_replay():
    bs = _extract_bootstrap(
        '<html><script>ytcfg.set({"INNERTUBE_API_KEY":"K",'
        '"INNERTUBE_CONTEXT":{"client":{"clientVersion":"1"}}});'
        '</script></html>')
    assert bs["continuation"] is None  # 채팅 비활성/리플레이 미준비


def _replay_payload(next_token="CONT_TOKEN_1", items=None):
    items = items if items is not None else [
        {"replayChatItemAction": {"videoOffsetTimeMsec": "5000", "actions": [
            {"addChatItemAction": {"item": {"liveChatTextMessageRenderer": {
                "id": "msg1",
                "authorName": {"simpleText": "팬1"},
                "message": {"runs": [{"text": "무대 너무 좋았어 "}, {"text": "❤"}]},
            }}}}]}},
    ]
    conts = ([{"liveChatReplayContinuationData": {"continuation": next_token}}]
             if next_token else [])
    return {"continuationContents": {"liveChatContinuation": {
        "actions": items, "continuations": conts}}}


def test_parse_replay_extracts_messages_and_next_token():
    msgs, nxt = _parse_replay(_replay_payload())
    assert nxt == "CONT_TOKEN_1"
    assert len(msgs) == 1
    assert msgs[0]["msg_id"] == "msg1"
    assert msgs[0]["author"] == "팬1"
    assert msgs[0]["message"] == "무대 너무 좋았어 ❤"
    assert msgs[0]["offset_ms"] == 5000


def test_parse_replay_no_continuation_returns_none_next():
    _, nxt = _parse_replay(_replay_payload(next_token=None))
    assert nxt is None


def test_parse_replay_skips_non_text_items():
    payload = _replay_payload(items=[
        {"replayChatItemAction": {"actions": [
            {"addBannerToLiveChatCommand": {}}]}},  # not a text message
    ])
    msgs, _ = _parse_replay(payload)
    assert msgs == []


class _FakeResp:
    def __init__(self, text="", payload=None, status=200):
        self._text, self._payload, self.status_code = text, payload or {}, status

    @property
    def text(self):
        return self._text

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("err", request=None, response=None)


class _FakeClient:
    def __init__(self, get_resp, post_responses):
        self._get_resp = get_resp
        self._post = list(post_responses)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, **kw):
        return self._get_resp

    def post(self, url, **kw):
        return self._post.pop(0)


def test_scrape_follows_continuations_until_exhausted():
    get_resp = _FakeResp(text=WATCH_HTML)
    posts = [
        _FakeResp(payload=_replay_payload(next_token="CONT_TOKEN_1", items=[
            {"replayChatItemAction": {"videoOffsetTimeMsec": "1000", "actions": [
                {"addChatItemAction": {"item": {"liveChatTextMessageRenderer": {
                    "id": "a", "authorName": {"simpleText": "u"},
                    "message": {"runs": [{"text": "good"}]}}}}}]}}])),
        _FakeResp(payload=_replay_payload(next_token=None, items=[
            {"replayChatItemAction": {"videoOffsetTimeMsec": "2000", "actions": [
                {"addChatItemAction": {"item": {"liveChatTextMessageRenderer": {
                    "id": "b", "authorName": {"simpleText": "v"},
                    "message": {"runs": [{"text": "bad"}]}}}}}]}}])),
    ]
    scraper = LiveChatReplayScraper(http_factory=lambda: _FakeClient(get_resp, posts))
    msgs = scraper.scrape("vid")
    assert [m["msg_id"] for m in msgs] == ["a", "b"]


def test_scrape_returns_empty_when_no_continuation():
    scraper = LiveChatReplayScraper(
        http_factory=lambda: _FakeClient(_FakeResp(text="<html></html>"), []))
    assert scraper.scrape("vid") == []


class _FakeGetClient:
    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, **kw):
        return _FakeResp(payload=self._payload)


def test_ended_broadcasts_keeps_only_ended_old_enough():
    payload = {"items": [
        {"id": "ended_ok", "snippet": {"title": "끝난방송", "liveBroadcastContent": "none"},
         "liveStreamingDetails": {"actualEndTime": "2026-06-16T01:00:00Z"}},
        {"id": "still_live", "snippet": {"title": "진행중", "liveBroadcastContent": "live"},
         "liveStreamingDetails": {"actualStartTime": "2026-06-16T00:00:00Z"}},
        {"id": "just_ended", "snippet": {"title": "방금끝", "liveBroadcastContent": "none"},
         "liveStreamingDetails": {"actualEndTime": "2026-06-16T03:50:00Z"}},
    ]}
    out = ended_broadcasts(
        lambda: _FakeGetClient(payload),
        api_key="K", video_ids=["ended_ok", "still_live", "just_ended"],
        now_iso="2026-06-16T04:00:00Z", min_age_min=30,
    )
    assert set(out) == {"ended_ok"}          # still_live=라이브중, just_ended=10분전→제외
    assert out["ended_ok"]["title"] == "끝난방송"
    assert out["ended_ok"]["ended_at"] == "2026-06-16T01:00:00Z"


def test_ended_broadcasts_empty_input():
    assert ended_broadcasts(lambda: _FakeGetClient({"items": []}),
                            api_key="K", video_ids=[],
                            now_iso="2026-06-16T04:00:00Z") == {}
