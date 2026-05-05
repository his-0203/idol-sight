"""Tests for ExternalCohortCollector.

We mock httpx.Client.get / .post by URL substring so the test exercises
the full auth-token caching, channel batch fetch, Spotify artist fetch,
and monthly_listeners scrape paths without hitting the network.
"""

from unittest.mock import MagicMock

from idol_sight.collectors.external_cohort import (
    ExternalCohortCollector,
    ExternalGroupRow,
)


def _make_http(handlers: dict[str, callable]):
    """handlers maps a URL substring to a callable(params, **kw) -> json dict.

    Returns a MagicMock httpx.Client supporting both context-manager use
    and direct .get/.post calls.
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
        if isinstance(body, tuple):
            r.status_code, body = body
        r.json.return_value = body if not isinstance(body, str) else {}
        r.text = body if isinstance(body, str) else ""
        r.raise_for_status.return_value = None
        return r

    def _post(url, *, headers=None, data=None, **kw):
        r = MagicMock()
        r.status_code = 200
        body = _route(url, {"headers": headers, "data": data, **kw})
        if isinstance(body, tuple):
            r.status_code, body = body
        r.json.return_value = body if not isinstance(body, str) else {}
        r.text = body if isinstance(body, str) else ""
        r.raise_for_status.return_value = None
        return r

    client = MagicMock()
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    client.get = _get
    client.post = _post
    return client


def test_collect_emits_one_row_per_group_with_both_signals():
    """Happy path: every group has both YT and Spotify IDs and both APIs
    return data. We expect one INSERT per group with all four metric
    columns populated, plus source='auto'."""
    groups = [
        ExternalGroupRow(key="riize", name="RIIZE",
                         yt_channel_id="UC_RIIZE", spotify_artist_id="SP_RIIZE"),
        ExternalGroupRow(key="bnd", name="BOYNEXTDOOR",
                         yt_channel_id="UC_BND", spotify_artist_id="SP_BND"),
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

    def sp_token_handler(kw):
        return {"access_token": "fake-token", "expires_in": 3600}

    def sp_artist_handler(kw):
        # URL contains the artist ID at the end; use it as a stable echo.
        return {"id": "SP_X", "followers": {"total": 500_000}}

    def sp_embed_handler(kw):
        # Inline JSON shape: "monthly_listeners":N
        return '<html><script>{"monthly_listeners":1234567}</script></html>'

    http = _make_http({
        "googleapis.com/youtube/v3/channels": yt_handler,
        "accounts.spotify.com/api/token": sp_token_handler,
        "api.spotify.com/v1/artists/": sp_artist_handler,
        "open.spotify.com/embed/artist/": sp_embed_handler,
    })

    coll = ExternalCohortCollector(
        yt_api_key="fake-yt",
        spotify_client_id="cid",
        spotify_client_secret="csec",
        http_factory=lambda: http,
    )
    result = coll.collect(groups)

    assert len(result.statements) == 2
    for sql, params in result.statements:
        assert "external_metrics" in sql
        # params order: group_key, snapshot_at, yt_subscribers,
        #               yt_total_views, monthly_listeners, followers
        assert params[0] in {"riize", "bnd"}
        assert params[2] == 1_000_000           # subscribers
        assert params[3] == 9_000_000           # views
        assert params[4] == 1_234_567           # monthly_listeners
        assert params[5] == 500_000             # followers


def test_collect_partial_when_only_youtube_present():
    """Group with no spotify_artist_id should still get a half snapshot
    (YouTube columns populated, Spotify columns NULL). Half-data is more
    useful than no row."""
    groups = [
        ExternalGroupRow(key="evnne", name="EVNNE",
                         yt_channel_id="UC_E", spotify_artist_id=None),
    ]

    def yt_handler(kw):
        return {"items": [{"id": "UC_E", "statistics": {
            "subscriberCount": "600000", "viewCount": "130000000",
        }}]}

    http = _make_http({
        "googleapis.com/youtube/v3/channels": yt_handler,
    })
    coll = ExternalCohortCollector(
        yt_api_key="fake",
        spotify_client_id=None,
        spotify_client_secret=None,
        http_factory=lambda: http,
    )
    result = coll.collect(groups)

    assert len(result.statements) == 1
    _, params = result.statements[0]
    assert params[2] == 600_000                # yt subscribers
    assert params[3] == 130_000_000            # yt views
    assert params[4] is None                   # monthly_listeners
    assert params[5] is None                   # followers


def test_collect_skips_groups_with_no_ids():
    """A group with neither yt_channel_id nor spotify_artist_id has no
    signal source — emit nothing rather than an empty row."""
    groups = [
        ExternalGroupRow(key="ghost", name="Ghost",
                         yt_channel_id=None, spotify_artist_id=None),
    ]
    coll = ExternalCohortCollector(yt_api_key=None, http_factory=lambda: _make_http({}))
    result = coll.collect(groups)
    assert result.statements == []


def test_resolve_fills_missing_spotify_id():
    """resolve() should call Spotify Search for groups missing an ID
    and emit UPDATE statements. Rows with an existing ID must NOT be
    overwritten — operator-set IDs are sticky."""
    groups = [
        ExternalGroupRow(key="riize", name="RIIZE",
                         yt_channel_id=None, spotify_artist_id=None),
        ExternalGroupRow(key="locked", name="Locked Group",
                         yt_channel_id=None, spotify_artist_id="ALREADY_SET"),
    ]
    search_calls: list[str] = []

    def sp_token_handler(kw):
        return {"access_token": "tok", "expires_in": 3600}

    def sp_search_handler(kw):
        search_calls.append(kw["params"]["q"])
        return {"artists": {"items": [{"id": "FOUND_ID", "name": "RIIZE"}]}}

    http = _make_http({
        "accounts.spotify.com/api/token": sp_token_handler,
        "api.spotify.com/v1/search": sp_search_handler,
    })
    coll = ExternalCohortCollector(
        yt_api_key=None,
        spotify_client_id="cid",
        spotify_client_secret="csec",
        http_factory=lambda: http,
    )
    statements, resolved = coll.resolve(groups)

    assert search_calls == ["RIIZE"]              # locked row not searched
    assert resolved == {"riize": "FOUND_ID"}
    assert len(statements) == 1
    sql, params = statements[0]
    assert "UPDATE external_groups" in sql
    assert params == ["FOUND_ID", "riize"]


def test_resolve_noop_without_spotify_credentials():
    coll = ExternalCohortCollector(
        yt_api_key=None,
        spotify_client_id=None,
        spotify_client_secret=None,
        http_factory=lambda: _make_http({}),
    )
    statements, resolved = coll.resolve([
        ExternalGroupRow(key="x", name="x",
                         yt_channel_id=None, spotify_artist_id=None),
    ])
    assert statements == []
    assert resolved == {}


def test_collect_records_errors_when_yt_key_missing():
    """Without YT_API_KEY the YouTube fetch should be skipped and
    surfaced in `errors`, but Spotify-only data should still be collected."""
    groups = [
        ExternalGroupRow(key="riize", name="RIIZE",
                         yt_channel_id="UC_RIIZE",
                         spotify_artist_id="SP_RIIZE"),
    ]

    def sp_token_handler(kw):
        return {"access_token": "tok", "expires_in": 3600}

    def sp_artist_handler(kw):
        return {"id": "SP_RIIZE", "followers": {"total": 1_900_000}}

    def sp_embed_handler(kw):
        return '<html>"monthly_listeners":7800000</html>'

    http = _make_http({
        "accounts.spotify.com/api/token": sp_token_handler,
        "api.spotify.com/v1/artists/": sp_artist_handler,
        "open.spotify.com/embed/artist/": sp_embed_handler,
    })
    coll = ExternalCohortCollector(
        yt_api_key=None,
        spotify_client_id="cid",
        spotify_client_secret="csec",
        http_factory=lambda: http,
    )
    result = coll.collect(groups)
    assert len(result.statements) == 1
    _, params = result.statements[0]
    assert params[2] is None                    # yt subscribers absent
    assert params[3] is None                    # yt views absent
    assert params[4] == 7_800_000               # spotify monthly listeners
    assert params[5] == 1_900_000               # spotify followers
    assert any("yt_api_key" in e for e in result.errors)


def test_scrape_monthly_listeners_falls_back_on_parse_failure():
    """If Spotify changes the embed shape and our regex misses, the
    scrape returns None and we still write the row with monthly=NULL."""
    groups = [
        ExternalGroupRow(key="riize", name="RIIZE",
                         yt_channel_id=None,
                         spotify_artist_id="SP_RIIZE"),
    ]

    def sp_token_handler(kw):
        return {"access_token": "tok", "expires_in": 3600}

    def sp_artist_handler(kw):
        return {"id": "SP_RIIZE", "followers": {"total": 1_900_000}}

    def sp_embed_handler(kw):
        # No regex match — the body lacks both "monthly_listeners":N and
        # the "X monthly listeners" meta description.
        return "<html><body>Page redesigned, no listeners number here.</body></html>"

    http = _make_http({
        "accounts.spotify.com/api/token": sp_token_handler,
        "api.spotify.com/v1/artists/": sp_artist_handler,
        "open.spotify.com/embed/artist/": sp_embed_handler,
    })
    coll = ExternalCohortCollector(
        yt_api_key=None,
        spotify_client_id="cid",
        spotify_client_secret="csec",
        http_factory=lambda: http,
    )
    result = coll.collect(groups)
    assert len(result.statements) == 1
    _, params = result.statements[0]
    assert params[4] is None                    # monthly_listeners NULL
    assert params[5] == 1_900_000               # followers still present
