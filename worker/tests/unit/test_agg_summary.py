from unittest.mock import MagicMock

from idol_sight.analysis.agg_summary import build_agg_summary


def _client_returning(rows_by_query: dict[str, list[dict]]):
    """Return a mock D1 client whose execute() returns mock rows for matching SQL.

    Substring matching is order-sensitive against ``rows_by_query`` insertion
    order, so put more-specific needles before more-general ones (e.g.
    "youtube_channel_stats" before "youtube_videos").
    """
    client = MagicMock()
    def _execute(sql: str, params: list | None = None):
        for needle, rows in rows_by_query.items():
            if needle in sql:
                return rows
        return []
    client.execute.side_effect = _execute
    return client


def test_build_agg_summary_emits_one_upsert_per_group():
    # NB. The YouTube totals query was split into two as of the
    # multi-channel SUM fix: one for video count + likes/comments
    # (matches "youtube_video_stats") and one for distinct-channel
    # subscribers/total_views SUM (matches "youtube_channel_stats").
    # Routing on the more-specific needle first gets each query the
    # correct fixture row.
    client = _client_returning({
        # community_posts counts grouped by platform
        "platform": [
            {"group_key": "plave",  "platform": "dc",     "n": 89663},
            {"group_key": "plave",  "platform": "theqoo", "n": 20219},
            {"group_key": "plave",  "platform": "instiz", "n": 35454},
            {"group_key": "isedol", "platform": "dc",     "n": 12500},
        ],
        "naver_articles": [
            {"group_key": "plave",  "n": 282},
            {"group_key": "isedol", "n": 365},
        ],
        # Distinct-channel SUM query (subscribers / total_views).
        "youtube_channel_stats": [
            {"group_key": "plave",
             "subscribers": 1140000, "total_views": 160608883},
        ],
        # Video count + likes/comments query.
        "youtube_video_stats": [
            {"group_key": "plave", "n_videos": 24,
             "total_likes": 4_500_000, "total_comments": 320_000},
        ],
        "twitter_posts": [
            {"group_key": "plave", "n": 30, "controversy_count": 0},
        ],
    })

    result = build_agg_summary(client, snapshot_at="2026-05-04T00:00:00Z")

    # One INSERT per group seen across queries.
    statements = result.statements
    upserts = [s for s, _ in statements if "agg_summary" in s and "INSERT" in s.upper()]
    assert len(upserts) == 2   # plave + isedol

    # Find PLAVE row params and verify counts.
    for _sql, params in statements:
        if "plave" in params:
            # params order: group_key, snapshot_at,
            #   yt_videos, yt_views, yt_subs,
            #   yt_likes, yt_comments,
            #   dc_posts, theqoo_posts, instiz_posts,
            #   naver, twitter, controversy
            assert params[0] == "plave"
            assert params[1] == "2026-05-04T00:00:00Z"
            assert params[2] == 24
            assert params[3] == 160608883
            assert params[4] == 1140000
            assert params[5] == 4_500_000
            assert params[6] == 320_000
            assert params[7] == 89663
            assert params[8] == 20219
            assert params[9] == 35454
            assert params[10] == 282
            assert params[11] == 30
            assert params[12] == 0
            break
    else:
        raise AssertionError("plave row not found in statements")


def test_build_agg_summary_sums_member_channels_for_segmentary_groups():
    """ISEDOL/STELLIVE-style: multiple distinct channels stamped to the
    same group_key (group + member solo channels). The legacy MAX query
    silently picked the largest single channel; the SUM fix rolls them
    all up.

    Mock the channel-stats SUM query directly — the inner DISTINCT
    subquery + outer SUM happens at SQL level, so we just supply the
    aggregated row the database would have produced.
    """
    client = _client_returning({
        "platform": [],
        "naver_articles": [],
        "youtube_channel_stats": [
            # ISEDOL: group(120K) + 6 members(~1.3M each) ≈ 8M total subs.
            # The legacy MAX query would have returned ~1_300_000 here
            # (single biggest member). The SUM query rolls up correctly.
            {"group_key": "isedol",
             "subscribers": 8_120_000,
             "total_views": 1_200_000_000},
            # STELLIVE: heavier member skew on confederation model.
            {"group_key": "stellive",
             "subscribers": 5_500_000,
             "total_views": 800_000_000},
            # PLAVE: corporate — only group channel; SUM == single value.
            {"group_key": "plave",
             "subscribers": 1_140_000,
             "total_views": 160_000_000},
        ],
        "youtube_video_stats": [
            {"group_key": "isedol", "n_videos": 320,
             "total_likes": 12_000_000, "total_comments": 800_000},
            {"group_key": "stellive", "n_videos": 250,
             "total_likes": 9_000_000, "total_comments": 600_000},
            {"group_key": "plave", "n_videos": 24,
             "total_likes": 4_500_000, "total_comments": 320_000},
        ],
        "twitter_posts": [],
    })

    result = build_agg_summary(client, snapshot_at="2026-05-04T00:00:00Z")

    by_group = {params[0]: params for _sql, params in result.statements}

    # ISEDOL — multi-channel SUM survives (8.12M, not the largest single
    # member ~1.3M that MAX would have surfaced).
    assert by_group["isedol"][3] == 1_200_000_000   # views (sum)
    assert by_group["isedol"][4] == 8_120_000       # subs  (sum)

    # STELLIVE — same.
    assert by_group["stellive"][3] == 800_000_000
    assert by_group["stellive"][4] == 5_500_000

    # PLAVE — corporate single-channel; sum collapses to the channel
    # value, matching legacy MAX.
    assert by_group["plave"][3] == 160_000_000
    assert by_group["plave"][4] == 1_140_000


def test_build_agg_summary_passes_null_when_channel_stats_missing():
    """A group that has community/news activity but no channel_stats row
    yet (e.g. wegosix before its first channel-stats cron) writes NULL
    for views/subs so the API forward-fill picks up the SB backfill row
    instead of overwriting it with 0.
    """
    client = _client_returning({
        "platform": [
            {"group_key": "wegosix", "platform": "dc", "n": 100},
        ],
        "naver_articles": [
            {"group_key": "wegosix", "n": 12},
        ],
        # No row for wegosix in either YouTube query → defaults from
        # the defaultdict factory (yt_views=None, yt_subs=None).
        "youtube_channel_stats": [],
        "youtube_video_stats": [],
        "twitter_posts": [],
    })
    result = build_agg_summary(client, snapshot_at="2026-05-04T00:00:00Z")
    by_group = {params[0]: params for _sql, params in result.statements}
    # views/subs are None — accurate "no data yet" signal.
    assert by_group["wegosix"][3] is None
    assert by_group["wegosix"][4] is None
    # Other counts still flow.
    assert by_group["wegosix"][7] == 100   # dc_total_posts
    assert by_group["wegosix"][10] == 12   # naver
