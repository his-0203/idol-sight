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
    """Channel UC_PLAVE: viral_one=1.5M + four others at 250K (n=5, sum=2.5M).
    Leave-one-out mean for viral_one = (2.5M - 1.5M)/4 = 250K → ratio = 6.0.
    Means are now computed in-memory from the persisted rows (no AVG query)."""
    others = [
        {"video_id": f"o{i}", "channel_id": "UC_PLAVE", "view_count_24h": 250_000}
        for i in range(4)
    ]
    client = _client({
        "WHERE published_at IS NOT NULL": [],
        "WHERE view_count_24h IS NOT NULL": [
            {"video_id": "viral_one", "channel_id": "UC_PLAVE",
             "view_count_24h": 1_500_000},
            *others,
        ],
    })
    result = compute_velocity(client)
    pass2 = {s[1][1]: s[1][0] for s in result.statements
             if "viral_velocity_ratio=" in s[0]}
    assert abs(pass2["viral_one"] - 6.0) < 1e-3


def test_pass2_skips_when_only_one_video_in_channel():
    """Single-video channel → leave-one-out mean is undefined → skip."""
    client = _client({
        "WHERE published_at IS NOT NULL": [],
        "WHERE view_count_24h IS NOT NULL": [
            {"video_id": "lonely", "channel_id": "UC_PLAVE",
             "view_count_24h": 500_000},
        ],
    })
    result = compute_velocity(client)
    pass2 = [s for s in result.statements if "viral_velocity_ratio=" in s[0]]
    assert pass2 == []


def test_pass2_uses_this_cycle_fresh_v24_not_stale_persisted():
    """Staleness fix: a video's ratio must use the v24 computed THIS cycle
    (Pass 1), not the stale persisted value. v_fresh's fresh v24=2M overrides a
    persisted 100K: LOO mean = (2.1M-2M)/1 = 100K → ratio 20.0 (not 1.0)."""
    by_param = {
        ("FROM youtube_video_stats", "v_fresh"):
            [{"views": 2_000_000, "delta": 0.05}],
    }
    client = _client(
        rows_by_query={
            "WHERE published_at IS NOT NULL": [
                {"video_id": "v_fresh", "channel_id": "UC", "group_key": "plave",
                 "published_at": "2026-05-01T10:00:00Z"},
            ],
            "WHERE view_count_24h IS NOT NULL": [
                {"video_id": "v_fresh", "channel_id": "UC",
                 "view_count_24h": 100_000},   # STALE persisted value
                {"video_id": "other", "channel_id": "UC",
                 "view_count_24h": 100_000},
            ],
        },
        by_param=by_param,
    )
    result = compute_velocity(client)
    pass2 = {s[1][1]: s[1][0] for s in result.statements
             if "viral_velocity_ratio=" in s[0]}
    assert abs(pass2["v_fresh"] - 20.0) < 1e-3   # 1.0 if it used stale 100K


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
