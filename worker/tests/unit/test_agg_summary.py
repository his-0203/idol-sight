from unittest.mock import MagicMock

from idol_sight.analysis.agg_summary import build_agg_summary


def _client_returning(rows_by_query: dict[str, list[dict]]):
    """Return a mock D1 client whose execute() returns mock rows for matching SQL."""
    client = MagicMock()
    def _execute(sql: str, params: list | None = None):
        for needle, rows in rows_by_query.items():
            if needle in sql:
                return rows
        return []
    client.execute.side_effect = _execute
    return client


def test_build_agg_summary_emits_one_upsert_per_group():
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
        "youtube_videos": [
            {"group_key": "plave", "n_videos": 24, "total_views": 160608883,
             "total_likes": 4_500_000, "total_comments": 320_000,
             "subscribers": 1140000},
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
