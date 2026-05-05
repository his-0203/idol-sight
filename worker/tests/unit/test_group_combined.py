"""Tests for the dual-entity group/member combined view builder."""
from unittest.mock import MagicMock

from idol_sight.analysis.group_combined import (
    MEMBER_WEIGHT,
    build_agg_group_combined,
)


def _client(rows_by_query, by_param=None):
    """Mock D1 client. ``rows_by_query`` matches by SQL substring;
    ``by_param`` keys on a (sql_substring, first_param) tuple for
    more precise routing (used when we query stats for many channels)."""
    client = MagicMock()

    def _execute(sql, params=None):
        if by_param:
            for (needle, first_param), rows in by_param.items():
                if needle in sql and params and params[0] == first_param:
                    return rows
        for needle, rows in rows_by_query.items():
            if needle in sql:
                return rows
        return []

    client.execute.side_effect = _execute
    return client


def test_emits_three_rows_per_group():
    """Group with members → exactly 3 rows (group_only/sum/weighted)."""
    client = _client(
        rows_by_query={
            "FROM groups WHERE is_active=1": [
                {"key": "isedol", "yt_channel_id": "UC_ISEDOL_GROUP"},
            ],
            "FROM members": [
                {"yt_channel_id": "UC_M1"},
                {"yt_channel_id": "UC_M2"},
            ],
            # Both stats and video-count queries fall through to this
            # generic route — by_param overrides for specific channels
            # below.
            "FROM youtube_channel_stats": [
                {"subscribers": 100, "total_views": 1000},
            ],
            "FROM youtube_videos WHERE channel_id=?": [
                {"n": 5},
            ],
        },
    )
    result = build_agg_group_combined(client, snapshot_at="2026-05-04T00:00:00Z")
    methods = [s[1][2] for s in result.statements]
    assert methods.count("group_only") == 1
    assert methods.count("sum") == 1
    assert methods.count("weighted") == 1


def test_combined_methods_produce_expected_arithmetic():
    """group=1000 subs / member1=2000 / member2=3000.
    group_only=1000, sum=6000, weighted=1000+(5000*0.7)=4500.
    """
    by_param = {
        ("FROM youtube_channel_stats", "UC_GROUP"):
            [{"subscribers": 1000, "total_views": 10_000}],
        ("FROM youtube_channel_stats", "UC_M1"):
            [{"subscribers": 2000, "total_views": 20_000}],
        ("FROM youtube_channel_stats", "UC_M2"):
            [{"subscribers": 3000, "total_views": 30_000}],
        ("FROM youtube_videos WHERE channel_id=?", "UC_GROUP"): [{"n": 10}],
        ("FROM youtube_videos WHERE channel_id=?", "UC_M1"):    [{"n": 20}],
        ("FROM youtube_videos WHERE channel_id=?", "UC_M2"):    [{"n": 30}],
    }
    client = _client(
        rows_by_query={
            "FROM groups WHERE is_active=1": [
                {"key": "isedol", "yt_channel_id": "UC_GROUP"},
            ],
            "FROM members": [
                {"yt_channel_id": "UC_M1"},
                {"yt_channel_id": "UC_M2"},
            ],
        },
        by_param=by_param,
    )
    result = build_agg_group_combined(client, snapshot_at="2026-05-04T00:00:00Z")
    by_method = {s[1][2]: s[1] for s in result.statements}

    # params = [group_key, snapshot_at, method,
    #           yt_subs_combined, yt_views_combined, yt_videos_combined,
    #           group_subs, member_subs, active_member_channel_count]
    assert by_method["group_only"][3] == 1000           # subs
    assert by_method["group_only"][4] == 10_000         # views
    assert by_method["group_only"][5] == 10             # videos

    assert by_method["sum"][3] == 1000 + 2000 + 3000    # 6000
    assert by_method["sum"][4] == 10_000 + 20_000 + 30_000
    assert by_method["sum"][5] == 10 + 20 + 30          # 60

    expected_weighted_subs = 1000 + int(5000 * MEMBER_WEIGHT)   # 4500
    expected_weighted_views = 10_000 + int(50_000 * MEMBER_WEIGHT)
    assert by_method["weighted"][3] == expected_weighted_subs
    assert by_method["weighted"][4] == expected_weighted_views

    # Composition: group_subs / member_subs / active_member_channel_count.
    for params in by_method.values():
        assert params[6] == 1000     # group_subs
        assert params[7] == 5000     # member_subs (sum across 2 members)
        assert params[8] == 2        # 2 member channels


def test_skips_groups_with_no_channels():
    """If a group has no yt_channel_id and no member channels, emit
    nothing for it (no point in writing all-zero rows)."""
    client = _client({
        "FROM groups WHERE is_active=1": [
            {"key": "ghost", "yt_channel_id": None},
        ],
        "FROM members": [],   # no solo channels either
    })
    result = build_agg_group_combined(client, snapshot_at="2026-05-04T00:00:00Z")
    assert result.statements == []


def test_corporate_group_with_no_member_channels():
    """PLAVE-style: yt_channel_id present, members all have NULL solo
    channels. group_only == sum == weighted (no member contribution).
    """
    by_param = {
        ("FROM youtube_channel_stats", "UC_PLAVE"):
            [{"subscribers": 1_140_000, "total_views": 160_000_000}],
        ("FROM youtube_videos WHERE channel_id=?", "UC_PLAVE"): [{"n": 24}],
    }
    client = _client(
        rows_by_query={
            "FROM groups WHERE is_active=1": [
                {"key": "plave", "yt_channel_id": "UC_PLAVE"},
            ],
            "FROM members": [],   # WHERE yt_channel_id IS NOT NULL → empty
        },
        by_param=by_param,
    )
    result = build_agg_group_combined(client, snapshot_at="2026-05-04T00:00:00Z")
    by_method = {s[1][2]: s[1] for s in result.statements}
    # All three methods identical when there are no member channels.
    assert by_method["group_only"][3] == by_method["sum"][3]
    assert by_method["group_only"][3] == by_method["weighted"][3]
    assert by_method["group_only"][3] == 1_140_000
    # active_member_channel_count = 0
    assert by_method["group_only"][8] == 0
