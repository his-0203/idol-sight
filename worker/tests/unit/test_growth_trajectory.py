"""Tests for growth trajectory analysis module."""
import json
import pytest
from unittest.mock import MagicMock

from idol_sight.analysis.growth_trajectory import (
    MIN_HISTORY_DAYS,
    _kst_day,
    acceleration,
    build_growth_trajectory,
    classify_accel,
    classify_direction,
    compute_pillars,
    incremental_er,
    relative_slope,
    resample_daily,
    synthesize_posture,
    weekly_flow,
)


def test_kst_day_shifts_utc_into_kst():
    # 2026-06-07T15:30:00Z is 2026-06-08 00:30 KST → KST day 2026-06-08
    assert _kst_day("2026-06-07T15:30:00Z") == "2026-06-08"
    assert _kst_day("2026-06-07T13:00:00Z") == "2026-06-07"


def test_resample_daily_keeps_latest_snapshot_per_kst_day():
    rows = [
        {"snapshot_at": "2026-06-07T01:00:00Z", "yt_subscribers": 100},
        {"snapshot_at": "2026-06-07T13:00:00Z", "yt_subscribers": 110},  # later same KST day
        {"snapshot_at": "2026-06-08T02:00:00Z", "yt_subscribers": 130},
    ]
    out = resample_daily(rows)
    assert [r["day"] for r in out] == ["2026-06-07", "2026-06-08"]
    assert out[0]["yt_subscribers"] == 110   # latest snapshot of 06-07 KST
    assert out[1]["yt_subscribers"] == 130


def test_relative_slope_positive_for_rising_series():
    # rising by +10/day over 28 pts → slope_per_day=10, mean=235 → *7/235 ≈ 0.298
    # plan comment said "mean ~ 145" (arithmetic error in plan); correct mean is 235.
    # boundary adjusted from >0.3 to >0.25 — still unambiguously "strongly climbing".
    vals = [100 + 10 * i for i in range(28)]
    rs = relative_slope(vals, window_days=28)
    assert rs is not None and rs > 0.25   # strongly climbing


def test_relative_slope_zero_for_flat_series():
    assert relative_slope([50.0] * 28, window_days=28) == 0.0


def test_relative_slope_none_when_too_short_or_zero_mean():
    assert relative_slope([1.0], window_days=28) is None
    assert relative_slope([0.0, 0.0], window_days=28) is None


def test_weekly_flow_is_7day_first_difference():
    # contiguous daily levels rising +5/day → 7-day flow = 35 once d-7 exists
    levels = [float(100 + 5 * i) for i in range(14)]
    flows = weekly_flow(levels, lag=7)
    # first 7 entries have no d-7 counterpart → dropped; rest are 35
    assert flows == [35.0] * 7


def test_acceleration_positive_when_recent_flow_exceeds_prior():
    # prior 14 ≈ 10, recent 14 ≈ 20 → accel ≈ +10
    series = [10.0] * 14 + [20.0] * 14
    assert acceleration(series, half=14) == 10.0


def test_acceleration_zero_when_insufficient():
    assert acceleration([1.0, 2.0], half=14) == 0.0


@pytest.mark.parametrize("rs,expected", [
    (0.20, "climbing"), (0.05001, "climbing"),
    (0.0, "plateau"), (0.05, "plateau"), (-0.05, "plateau"),
    (-0.20, "declining"), (None, "unknown"),
])
def test_classify_direction(rs, expected):
    assert classify_direction(rs) == expected


@pytest.mark.parametrize("a,expected", [
    (5.0, "accelerating"), (-5.0, "decelerating"), (0.0, "flat"),
])
def test_classify_accel(a, expected):
    assert classify_accel(a, deadband=1.0) == expected


def test_incremental_er_uses_deltas_over_window():
    # views +100000, likes+comments +5000 over window → ER = 0.05
    daily = [
        {"yt_total_views": 1_000_000, "yt_likes_total": 40_000, "yt_comments_total": 5_000},
        {"yt_total_views": 1_100_000, "yt_likes_total": 44_000, "yt_comments_total": 6_000},
    ]
    er = incremental_er(daily, window=1)
    assert er is not None and abs(er - 0.05) < 1e-9


def test_incremental_er_none_when_no_new_views():
    daily = [
        {"yt_total_views": 1_000_000, "yt_likes_total": 40_000, "yt_comments_total": 5_000},
        {"yt_total_views": 1_000_000, "yt_likes_total": 40_010, "yt_comments_total": 5_000},
    ]
    assert incremental_er(daily, window=1) is None


def _rising_daily(n=40):
    """n contiguous KST days with accelerating growth so weekly-flow slopes up.

    plan originally used constant-rate growth (+300/day) which yields flat
    weekly-flow → 'plateau'; changed to quadratic (+i*30/day) so flow itself
    rises → reach direction='climbing' as the test asserts.
    """
    rows = []
    for i in range(n):
        rows.append({
            "day": f"2026-04-{i + 1:02d}" if i < 30 else f"2026-05-{i - 29:02d}",
            "yt_subscribers": 5000 + 15 * i * i,   # quadratic → rising flow
            "yt_total_views": 900_000 + 80_000 * i + 2000 * i * i,
            "yt_likes_total": 8000 + 400 * i + 10 * i * i,
            "yt_comments_total": 500 + 30 * i + i * i,
            "dc_total_posts": 30 + 2 * i,
            "theqoo_posts": 0, "instiz_posts": 0, "twitter_posts": 0,
            "negative_ratio": 0.0,
        })
    return rows


def _rising_series(n=40):
    """A rising community-activity series for compute_pillars' community arg."""
    return [float(i + 1) for i in range(n)]


def test_reach_noise_floor_forces_plateau_on_frozen_quantized_data():
    from idol_sight.analysis.growth_trajectory import _pillar_from_levels
    # YouTube rounds large-channel subs → frozen series. Tiny/zero 4-week move
    # must read 유지, not an amplified climbing/declining.
    p = _pillar_from_levels("reach", [1_180_000.0] * 40, noise_floor=0.02)
    assert p["direction"] == "plateau"
    assert p["accel_dir"] == "flat"


def test_reach_noise_floor_allows_real_accelerating_growth():
    from idol_sight.analysis.growth_trajectory import _pillar_from_levels
    levels = [10_000.0 + 50 * i * i for i in range(40)]   # rising flow → climbing
    p = _pillar_from_levels("reach", levels, noise_floor=0.02)
    assert p["direction"] == "climbing"


def test_reach_without_noise_floor_keeps_slope_classification():
    from idol_sight.analysis.growth_trajectory import _pillar_from_levels
    p = _pillar_from_levels("reach", [1_180_000.0] * 40)   # no floor → unmodified
    assert p["direction"] == "unknown"   # frozen flow → slope None → unknown


def test_community_low_volume_marks_unknown():
    daily = _rising_daily()
    low = [2.0] * len(daily)   # current 7-day volume 2 < MIN_COMMUNITY_VOLUME
    community = next(p for p in compute_pillars(daily, low) if p["key"] == "community")
    assert community["direction"] == "unknown"


def test_community_short_active_history_marks_unknown():
    daily = _rising_daily()   # 40-day timeline
    series = [0.0] * 30 + [float(i) for i in range(1, 11)]   # activity only last 10 days
    community = next(p for p in compute_pillars(daily, series) if p["key"] == "community")
    assert community["direction"] == "unknown"


def test_community_healthy_volume_not_suppressed():
    daily = _rising_daily()
    series = [float(10 + i) for i in range(len(daily))]   # ample volume, full history
    community = next(p for p in compute_pillars(daily, series) if p["key"] == "community")
    assert community["direction"] != "unknown"


def test_compute_pillars_returns_four_keyed_pillars_climbing():
    pillars = compute_pillars(_rising_daily(), _rising_series())
    keys = {p["key"] for p in pillars}
    assert keys == {"reach", "engagement", "community", "sentiment"}
    reach = next(p for p in pillars if p["key"] == "reach")
    assert reach["direction"] == "climbing"
    # every pillar dict has the contract fields
    for p in pillars:
        assert set(p) >= {"key", "level", "wow_growth", "slope_4w", "accel",
                          "direction", "accel_dir"}


def _pillar(key, direction, accel_dir, slope=0.1, accel=1.0):
    return {"key": key, "direction": direction, "accel_dir": accel_dir,
            "slope_4w": slope, "accel": accel}


def test_posture_growth_accelerating_and_weakest_is_declining():
    pillars = [
        _pillar("reach", "climbing", "accelerating", 0.3, 5.0),
        _pillar("engagement", "climbing", "flat", 0.1, 0.0),
        _pillar("community", "declining", "decelerating", -0.2, -3.0),
        _pillar("sentiment", "plateau", "flat", 0.0, 0.0),
    ]
    label, weakest = synthesize_posture(pillars)
    assert label == "성장 가속"
    assert weakest == "community"   # the only pillar with a negative combined score


def test_posture_slowing_label_uses_growth_rate_framing_not_decline():
    # All cumulative pillars → a negative flow-slope means growth SLOWING, never
    # absolute decline. Label must never say 하락/악화.
    pillars = [
        _pillar("reach", "declining", "decelerating", -0.3, -5.0),
        _pillar("engagement", "declining", "decelerating", -0.2, -3.0),
        _pillar("community", "plateau", "flat", 0.0, 0.0),
        _pillar("sentiment", "plateau", "flat", 0.0, 0.0),
    ]
    label, _ = synthesize_posture(pillars)
    assert label == "성장 둔화 심화"
    assert "하락" not in label and "악화" not in label


def test_posture_weakest_is_none_when_all_pillars_healthy():
    # MiiWAN-like: everything climbing/plateau, no pillar genuinely weak → no flag.
    pillars = [
        _pillar("reach", "climbing", "accelerating"),
        _pillar("engagement", "plateau", "accelerating"),
        _pillar("community", "climbing", "flat"),
        _pillar("sentiment", "plateau", "flat"),
    ]
    _, weakest = synthesize_posture(pillars)
    assert weakest is None


def test_posture_weakest_excludes_unknown_pillars():
    # An 'unknown' (no-signal) pillar must never be picked as the weakest.
    pillars = [
        _pillar("reach", "climbing", "accelerating"),
        _pillar("engagement", "unknown", "flat"),
        _pillar("community", "declining", "flat"),
        _pillar("sentiment", "plateau", "flat"),
    ]
    _, weakest = synthesize_posture(pillars)
    assert weakest == "community"


@pytest.mark.parametrize("dirs,accs,expected", [
    (["climbing"] * 4, ["accelerating"] * 4, "성장 가속"),
    (["climbing"] * 4, ["flat"] * 4, "성장 확대"),
    (["climbing"] * 4, ["decelerating"] * 4, "성장 확대(둔화 조짐)"),
    (["plateau"] * 4, ["flat"] * 4, "성장 유지"),
    (["declining"] * 4, ["flat"] * 4, "성장 둔화"),
    (["declining"] * 4, ["decelerating"] * 4, "성장 둔화 심화"),
    # slowing but deceleration reversing → stays 둔화 (not 심화), shares the
    # acc>=−0.15 branch with the flat case; guard that distinction.
    (["declining"] * 4, ["accelerating"] * 4, "성장 둔화"),
])
def test_posture_label_vocabulary(dirs, accs, expected):
    keys = ["reach", "engagement", "community", "sentiment"]
    pillars = [_pillar(k, d, a) for k, d, a in zip(keys, dirs, accs)]
    label, _ = synthesize_posture(pillars)
    assert label == expected


def test_change_4w_relative_for_levels_absolute_for_values():
    from idol_sight.analysis.growth_trajectory import _change_4w
    # relative: base is the point ~28 days back (index -29 over a 29-long series)
    levels = [100.0] + [0.0] * 27 + [120.0]   # len 29, base = levels[-29] = 100
    assert abs(_change_4w(levels, relative=True) - 0.2) < 1e-9
    # absolute delta for ratio pillars
    vals = [0.03] + [0.0] * 27 + [0.05]
    assert abs(_change_4w(vals, relative=False) - 0.02) < 1e-9
    # short history → falls back to the earliest point
    assert _change_4w([100.0, 110.0], relative=True) == 0.1
    # guards: too short, zero base
    assert _change_4w([100.0], relative=True) is None
    assert _change_4w([0.0] * 29, relative=True) is None


def test_pillars_carry_change_4w_field():
    pillars = compute_pillars(_rising_daily(), _rising_series())
    for p in pillars:
        assert "change_4w" in p


def test_compute_pillars_sentiment_zero_is_healthy_plateau_not_unknown():
    # negative_ratio flat at 0 is the healthiest state, not a data gap → plateau.
    pillars = compute_pillars(_rising_daily(), _rising_series())
    sentiment = next(p for p in pillars if p["key"] == "sentiment")
    assert sentiment["direction"] == "plateau"


def _fetch_rows_for(group, n):
    """Generate n rows starting 2026-03-01 (March has 31 days; up to ~60 rows safe)."""
    from datetime import date, timedelta
    base = date(2026, 3, 1)
    rows = []
    for i in range(n):
        d = base + timedelta(days=i)
        rows.append({
            "group_key": group,
            "snapshot_at": f"{d.isoformat()}T13:00:00Z",
            "yt_subscribers": 5000 + 300 * i,
            "yt_total_views": 900_000 + 80_000 * i,
            "yt_likes_total": 8000 + 400 * i,
            "yt_comments_total": 500 + 30 * i,
            "dc_total_posts": 30 + 2 * i, "theqoo_posts": 0,
            "instiz_posts": 0, "twitter_posts": 0, "negative_ratio": 0.0,
        })
    return rows


def _client(rows, community_rows=None):
    client = MagicMock()

    def _exec(sql, params=None):
        if "community_posts" in sql:
            return community_rows or []
        return rows

    client.execute.side_effect = _exec
    return client


def test_shift_day():
    from idol_sight.analysis.growth_trajectory import _shift_day
    assert _shift_day("2026-06-08", -7) == "2026-06-01"
    assert _shift_day("2026-03-01", -1) == "2026-02-28"


def test_community_activity_series_counts_trailing_window():
    from idol_sight.analysis.growth_trajectory import community_activity_series
    posts = {"2026-06-01": 3, "2026-06-05": 2, "2026-06-08": 4}
    # 06-07 window = 06-01..06-07 → 3+2 = 5 ; 06-08 window = 06-02..06-08 → 2+4 = 6
    assert community_activity_series(posts, ["2026-06-07", "2026-06-08"], window=7) == [5.0, 6.0]
    # posts outside the trailing window are excluded
    assert community_activity_series({"2026-05-01": 9}, ["2026-06-08"], window=7) == [0.0]


def test_build_community_pillar_uses_posted_at_volume_not_cumulative():
    from datetime import date, timedelta
    agg = _fetch_rows_for("miiwan", 40)
    # rising daily posting volume (by posted_at) → recent-volume trend climbs
    community_rows = [
        {"group_key": "miiwan",
         "pday": (date(2026, 3, 1) + timedelta(days=i)).isoformat(),
         "n": 1 + i}
        for i in range(40)
    ]
    result = build_growth_trajectory(_client(agg, community_rows))
    upsert = next(s for s in result.statements if "INSERT INTO" in s[0])
    pillars = json.loads(upsert[1][6])
    community = next(p for p in pillars if p["key"] == "community")
    assert community["direction"] == "climbing"
    assert community["level"] is not None   # current trailing-window volume


def test_build_emits_delete_then_per_group_upserts():
    rows = _fetch_rows_for("miiwan", 30) + _fetch_rows_for("bthd", 5)
    result = build_growth_trajectory(_client(rows))
    sqls = [s[0] for s in result.statements]
    assert "DELETE FROM group_growth_trajectory" in sqls[0]
    # one upsert per group
    upserts = [s for s in result.statements if "INSERT INTO group_growth_trajectory" in s[0]]
    assert len(upserts) == 2
    by_group = {s[1][0]: s[1] for s in upserts}
    assert set(by_group) == {"miiwan", "bthd"}


def test_build_marks_thin_history_insufficient():
    rows = _fetch_rows_for("bthd", MIN_HISTORY_DAYS - 1)
    result = build_growth_trajectory(_client(rows))
    upsert = next(s for s in result.statements if "INSERT INTO" in s[0])
    params = upsert[1]
    # params: group_key, computed_at, status, history_days, posture, weakest, pillars
    assert params[0] == "bthd"
    assert params[2] == "insufficient_history"
    assert params[4] is None and params[5] is None


def test_build_marks_ok_status_and_emits_posture_for_rich_history():
    rows = _fetch_rows_for("miiwan", 40)
    result = build_growth_trajectory(_client(rows))
    upsert = next(s for s in result.statements if "INSERT INTO" in s[0])
    params = upsert[1]
    assert params[2] == "ok"
    assert params[4] is not None        # posture_label
    pillars = json.loads(params[6])
    assert len(pillars) == 4
