"""Tests for the 24h velocity computation."""
from unittest.mock import MagicMock

from idol_sight.analysis.video_velocity import compute_velocity


def _client(rows_by_query, by_param=None):
    client = MagicMock()

    def _execute(sql, params=None):
        if by_param:
            for (needle, first_param), rows in by_param.items():
                if needle in sql and params and params[1] == first_param:
                    return rows
        for needle, rows in rows_by_query.items():
            if needle in sql:
                return rows
        return []

    client.execute.side_effect = _execute
    return client


def test_pass1_emits_view_count_update_per_video():
    """For each recent video, find the closest +24h snapshot and emit
    UPDATE youtube_videos SET view_count_24h=...
    """
    by_param = {
        # Video 'v1' uploaded T+0; closest +24h snapshot has views=500K.
        ("FROM youtube_video_stats", "v1"):
            [{"views": 500_000, "delta": 0.05}],
        ("FROM youtube_video_stats", "v2"):
            [{"views": 1_500_000, "delta": 0.1}],
    }
    client = _client(
        rows_by_query={
            "WHERE published_at IS NOT NULL": [
                {"video_id": "v1", "channel_id": "UC_PLAVE",
                 "group_key": "plave", "published_at": "2026-05-01T10:00:00Z"},
                {"video_id": "v2", "channel_id": "UC_PLAVE",
                 "group_key": "plave", "published_at": "2026-05-02T10:00:00Z"},
            ],
            "AVG(view_count_24h)": [
                {"channel_id": "UC_PLAVE", "m": 200_000.0, "n": 5},
            ],
            "WHERE view_count_24h IS NOT NULL": [],
        },
        by_param=by_param,
    )
    result = compute_velocity(client)
    # Two pass-1 UPDATEs (one per video).
    pass1 = [s for s in result.statements
             if "view_count_24h=" in s[0] and "viral_velocity_ratio" not in s[0]]
    assert len(pass1) == 2
    by_vid = {s[1][1]: s[1][0] for s in pass1}
    assert by_vid["v1"] == 500_000
    assert by_vid["v2"] == 1_500_000


def test_pass2_emits_velocity_ratio_with_leave_one_out_mean():
    """Channel mean (m, n)=(500K, 5). For a video with v24=1.5M:
    leave-one-out mean = (500K*5 - 1.5M)/4 = (2.5M - 1.5M)/4 = 250K.
    ratio = 1.5M / 250K = 6.0 (very viral).
    """
    client = _client({
        "WHERE published_at IS NOT NULL": [],
        "AVG(view_count_24h)": [
            {"channel_id": "UC_PLAVE", "m": 500_000.0, "n": 5},
        ],
        "WHERE view_count_24h IS NOT NULL": [
            {"video_id": "viral_one", "channel_id": "UC_PLAVE",
             "view_count_24h": 1_500_000},
        ],
    })
    result = compute_velocity(client)
    pass2 = [s for s in result.statements if "viral_velocity_ratio=" in s[0]]
    assert len(pass2) == 1
    sql, params = pass2[0]
    # ratio = 1_500_000 / 250_000 = 6.0
    assert abs(params[0] - 6.0) < 1e-3
    assert params[1] == "viral_one"


def test_pass2_skips_when_only_one_video_in_channel():
    """Single-video channel → leave-one-out mean is undefined → skip."""
    client = _client({
        "WHERE published_at IS NOT NULL": [],
        "AVG(view_count_24h)": [
            {"channel_id": "UC_PLAVE", "m": 500_000.0, "n": 1},
        ],
        "WHERE view_count_24h IS NOT NULL": [
            {"video_id": "lonely", "channel_id": "UC_PLAVE",
             "view_count_24h": 500_000},
        ],
    })
    result = compute_velocity(client)
    pass2 = [s for s in result.statements if "viral_velocity_ratio=" in s[0]]
    assert pass2 == []


def test_skips_videos_with_no_close_snapshot():
    """Video uploaded so recently we don't have a +24h stats row yet
    → no UPDATE for that row (its view_count_24h stays NULL)."""
    client = _client({
        "WHERE published_at IS NOT NULL": [
            {"video_id": "fresh", "channel_id": "UC_X",
             "group_key": "plave", "published_at": "2026-05-04T22:00:00Z"},
        ],
        "FROM youtube_video_stats": [],   # no stats in window
        "AVG(view_count_24h)": [],
        "WHERE view_count_24h IS NOT NULL": [],
    })
    result = compute_velocity(client)
    assert result.statements == []
