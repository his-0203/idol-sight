"""Tests for the YouTube-only ExternalCohortCollector.

We mock httpx.Client.get by URL substring so the test exercises the
channel batch fetch path without touching the network. Spotify is
deliberately out of scope (Premium-required policy 2026-02-06).
"""

from collections.abc import Callable
from typing import Any, cast
from unittest.mock import MagicMock

import httpx

from idol_sight.collectors.external_cohort import (
    ExternalCohortCollector,
    ExternalGroupRow,
)


def _make_http(handlers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]]):
    """handlers maps a URL substring to a callable(params, **kw) -> json dict.

    Returns a MagicMock httpx.Client supporting context-manager + .get().
    """

    def _route(url: str, kw):
        for substr, fn in handlers.items():
            if substr in url:
                return fn(kw)
        return {}

    def _get(url, *, params=None, headers=None, **kw):
        r = MagicMock()
        r.status_code = 200
        body = _route(url, {"params": params, "headers": headers, **kw})
        r.json.return_value = body
        r.raise_for_status.return_value = None
        return r

    client = MagicMock()
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    client.get = _get
    return client


def test_collect_emits_one_row_per_group_with_yt_channel():
    """Happy path: every group has yt_channel_id; YouTube returns
    statistics for all. We expect one INSERT per group with subscribers
    + views populated and Spotify columns NULL."""
    groups = [
        ExternalGroupRow(key="riize", name="RIIZE",
                         yt_channel_id="UC_RIIZE", spotify_artist_id=None),
        ExternalGroupRow(key="bnd", name="BOYNEXTDOOR",
                         yt_channel_id="UC_BND", spotify_artist_id=None),
    ]

    def yt_handler(kw):
        ids = (kw["params"].get("id") or "").split(",")
        return {
            "items": [
                {
                    "id": cid,
                    "statistics": {
                        "subscriberCount": "1000000",
                        "viewCount": "9000000",
                    },
                }
                for cid in ids
            ]
        }

    http = _make_http({
        "googleapis.com/youtube/v3/channels": yt_handler,
    })
    coll = ExternalCohortCollector(
        yt_api_key="fake-yt",
        http_factory=lambda: http,
    )
    result = coll.collect(groups)

    assert len(result.statements) == 2
    for sql, params in result.statements:
        assert "external_metrics" in sql
        assert "NULL, NULL" in sql                  # spotify columns NULL
        # params: group_key, snapshot_at, subscribers, views
        assert params[0] in {"riize", "bnd"}
        assert params[2] == 1_000_000
        assert params[3] == 9_000_000


def test_collect_skips_groups_without_yt_channel():
    """Group with no yt_channel_id has no auto-fetchable signal — emit
    nothing rather than a row of NULLs."""
    groups = [
        ExternalGroupRow(key="ghost", name="Ghost",
                         yt_channel_id=None, spotify_artist_id=None),
    ]
    coll = ExternalCohortCollector(
        yt_api_key="fake",
        http_factory=lambda: _make_http({}),
    )
    result = coll.collect(groups)
    assert result.statements == []


def test_collect_skips_when_yt_key_missing():
    """No YT_API_KEY → no work; surface as error."""
    groups = [
        ExternalGroupRow(key="riize", name="RIIZE",
                         yt_channel_id="UC_X", spotify_artist_id=None),
    ]
    coll = ExternalCohortCollector(
        yt_api_key=None,
        http_factory=lambda: _make_http({}),
    )
    result = coll.collect(groups)
    assert result.statements == []
    assert any("yt_api_key" in e for e in result.errors)


def test_collect_continues_on_per_batch_http_error():
    """A single failing channels.list batch must not black out the
    whole roster; the error is collected and the run finishes with
    whatever rows did succeed (zero in this case since one batch covers
    them all, but the assertion is the error is captured)."""
    groups = [
        ExternalGroupRow(key="riize", name="RIIZE",
                         yt_channel_id="UC_X", spotify_artist_id=None),
    ]

    class FailingClient:
        def __enter__(self):
            return self
        def __exit__(self, *exc):
            return False
        def get(self, url, **_):
            raise httpx.RequestError("boom")

    coll = ExternalCohortCollector(
        yt_api_key="fake",
        # FailingClient is a structural stub — only implements the
        # context-manager + .get() surface the collector touches.
        # cast() keeps the signature honest for runtime while skipping
        # the nominal subtype check Pyright would otherwise enforce.
        http_factory=lambda: cast(httpx.Client, FailingClient()),
    )
    result = coll.collect(groups)
    assert result.statements == []
    assert any("youtube channels.list failed" in e for e in result.errors)


def test_collect_batches_more_than_50_channels():
    """The YouTube channels.list endpoint accepts up to 50 IDs per
    call. With 60 groups the collector should issue 2 batches and
    union the results."""
    groups = [
        ExternalGroupRow(key=f"g{i}", name=f"G{i}",
                         yt_channel_id=f"UC_{i:02d}", spotify_artist_id=None)
        for i in range(60)
    ]
    call_count = {"n": 0}

    def yt_handler(kw):
        call_count["n"] += 1
        ids = (kw["params"].get("id") or "").split(",")
        assert len(ids) <= 50
        return {
            "items": [
                {"id": cid, "statistics": {"subscriberCount": "10", "viewCount": "20"}}
                for cid in ids
            ]
        }

    http = _make_http({
        "googleapis.com/youtube/v3/channels": yt_handler,
    })
    coll = ExternalCohortCollector(
        yt_api_key="fake",
        http_factory=lambda: http,
    )
    result = coll.collect(groups)

    assert call_count["n"] == 2                 # 50 + 10
    assert len(result.statements) == 60
