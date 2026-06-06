"""Live CCV migration 0080 — smoke test."""
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _apply_all() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def test_migration_adds_ccv_tracked_and_samples_table():
    conn = _apply_all()
    cols = {r[1] for r in conn.execute("PRAGMA table_info(groups)")}
    assert "ccv_tracked" in cols
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "live_ccv_samples" in tables
    seeded = {r[0] for r in conn.execute(
        "SELECT key FROM groups WHERE ccv_tracked=1")}
    assert {"miiwan", "plave", "owis", "wegosix"} <= seeded
    indexes = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND tbl_name='live_ccv_samples'")}
    assert "idx_ccv_group_time" in indexes


from idol_sight.collectors.live_ccv import LiveCcvCollector


class _FakeResp:
    def __init__(self, text="", payload=None, status=200):
        self._text = text
        self._payload = payload or {}
        self.status_code = status

    @property
    def text(self):
        return self._text

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx
            raise httpx.HTTPStatusError("err", request=None, response=None)


class _FakeClient:
    """Routes .get() by URL/params to queued responses."""
    def __init__(self, handler):
        self._handler = handler

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, params=None):
        return self._handler(url, params or {})


_RSS = (
    '<?xml version="1.0"?><feed>'
    '<entry><yt:videoId>aaaaaaaaaaa</yt:videoId></entry>'
    '<entry><yt:videoId>bbbbbbbbbbb</yt:videoId></entry>'
    '<entry><yt:videoId>aaaaaaaaaaa</yt:videoId></entry>'
    '</feed>'
)


def test_rss_video_ids_parses_and_dedupes():
    coll = LiveCcvCollector(api_key="k", groups_loader=lambda: [])
    client = _FakeClient(lambda url, params: _FakeResp(text=_RSS))
    ids = coll._rss_video_ids(client, "UC_test_channel_000000")
    assert ids == ["aaaaaaaaaaa", "bbbbbbbbbbb"]


_VIDEOS_PAYLOAD = {
    "items": [
        {"id": "aaaaaaaaaaa",
         "snippet": {"liveBroadcastContent": "live", "title": "MiiWAN 데뷔 라이브"},
         "liveStreamingDetails": {"concurrentViewers": "1234"}},
        {"id": "bbbbbbbbbbb",
         "snippet": {"liveBroadcastContent": "none", "title": "지난 영상"},
         "liveStreamingDetails": {}},
    ]
}


def test_live_samples_extracts_only_live_with_ccv():
    coll = LiveCcvCollector(api_key="k", groups_loader=lambda: [])
    client = _FakeClient(lambda url, params: _FakeResp(payload=_VIDEOS_PAYLOAD))
    live = coll._live_samples(client, ["aaaaaaaaaaa", "bbbbbbbbbbb"])
    assert set(live) == {"aaaaaaaaaaa"}
    assert live["aaaaaaaaaaa"] == {"ccv": 1234, "title": "MiiWAN 데뷔 라이브"}


def test_collect_global_maps_videos_to_groups_and_upserts():
    targets = [
        {"key": "miiwan", "yt_channel_id": "UCmiiwan0000000000000000"},
        {"key": "owis", "yt_channel_id": "UCowis00000000000000000000"},
    ]

    def handler(url, params):
        if "feeds/videos.xml" in url:
            if "UCmiiwan" in url:
                return _FakeResp(
                    text="<feed><entry><yt:videoId>aaaaaaaaaaa</yt:videoId></entry></feed>")
            return _FakeResp(
                text="<feed><entry><yt:videoId>bbbbbbbbbbb</yt:videoId></entry></feed>")
        return _FakeResp(payload=_VIDEOS_PAYLOAD)  # aaaa live, bbbb not

    coll = LiveCcvCollector(
        api_key="k", groups_loader=lambda: targets,
        http_factory=lambda: _FakeClient(handler))
    result = coll.collect_global(now_iso="2026-06-06T12:00:00Z")
    assert result.rows_inserted == 1            # only aaaa is live
    sql, params = result.statements[0]
    assert "INSERT INTO live_ccv_samples" in sql
    assert params == ["aaaaaaaaaaa", "miiwan", "2026-06-06T12:00:00Z", 1234,
                      "MiiWAN 데뷔 라이브"]


def test_collect_global_all_rss_fail_returns_error():
    def handler(url, params):
        return _FakeResp(status=500)
    coll = LiveCcvCollector(
        api_key="k",
        groups_loader=lambda: [{"key": "miiwan", "yt_channel_id": "UCx"}],
        http_factory=lambda: _FakeClient(handler))
    result = coll.collect_global(now_iso="2026-06-06T12:00:00Z")
    assert result.statements == []
    assert result.errors
