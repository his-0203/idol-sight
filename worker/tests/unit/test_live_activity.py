# (test_live_activity.py — 전 마이그레이션 :memory: 적용, test_live_chat_migration.py 미러)
import sqlite3
from pathlib import Path

import pytest

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _apply_all():
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def test_migration_creates_live_activity_tables():
    conn = _apply_all()
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"agg_live_activity", "agg_live_activity_summary"} <= tables
    ala_cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_live_activity)")}
    assert {"group_key", "video_id", "ended_at", "unique_chatters", "total_messages",
            "msgs_per_chatter", "peak_msgs_per_min", "returning_rate", "basis",
            "generated_at"} <= ala_cols
    sum_cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_live_activity_summary)")}
    assert {"group_key", "generated_at", "window_days", "broadcast_count",
            "median_unique_chatters", "median_msgs_per_chatter", "median_returning_rate",
            "median_peak_msgs_per_min", "core_fan_count", "core_fan_share",
            "est_engaged_fans", "est_active_core", "view_through", "like_rate",
            "comment_rate", "basis"} <= sum_cols


def test_migration_agg_live_activity_pk_composite():
    conn = _apply_all()
    ins = ("INSERT INTO agg_live_activity (group_key, video_id, basis, generated_at) "
           "VALUES ('miiwan','v1','scored','2026-06-27T00:00:00Z')")
    conn.execute(ins)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(ins)


# ---------------------------------------------------------------------------
# 순수 컴퓨트 + _FakeClient 섹션 (test_loyalty.py 미러)
# ---------------------------------------------------------------------------
from idol_sight.analysis.live_activity import (  # noqa: E402
    build_live_activity,
    compute_broadcast_activity,
    compute_live_activity,
    estimate_video_engagement,
    window_core_fans,
)


def test_compute_broadcast_activity_basic_and_peak_excludes_null_offset():
    messages = [
        {"author": "a", "offset_ms": 1000},
        {"author": "b", "offset_ms": 2000},
        {"author": "a", "offset_ms": 3000},
        {"author": "c", "offset_ms": 65000},
        {"author": "d", "offset_ms": None},
    ]
    out = compute_broadcast_activity(messages, prev_chatters=None)
    assert out["total_messages"] == 5
    assert out["unique_chatters"] == 4
    assert out["msgs_per_chatter"] == pytest.approx(1.2)
    assert out["peak_msgs_per_min"] == 3
    assert out["returning_rate"] is None
    assert out["chatters"] == {"a", "b", "c", "d"}


def test_compute_broadcast_activity_returning_rate_intersection():
    messages = [{"author": x, "offset_ms": 1000} for x in ("a", "b", "c", "d")]
    out = compute_broadcast_activity(messages, prev_chatters={"a", "b", "x"})
    assert out["returning_rate"] == pytest.approx(0.5)


def test_compute_broadcast_activity_no_chatters():
    msgs = [{"author": None, "offset_ms": 1000}, {"author": "", "offset_ms": 2000}]
    out = compute_broadcast_activity(msgs, prev_chatters={"a"})
    assert out["unique_chatters"] == 0 and out["msgs_per_chatter"] is None
    assert out["returning_rate"] is None and out["peak_msgs_per_min"] == 2


def test_window_core_fans_two_or_more_broadcasts():
    count, share = window_core_fans([{"a", "b", "c"}, {"a", "b", "d"}, {"a", "e"}])
    assert count == 2 and share == pytest.approx(0.4)


def test_estimate_video_engagement_medians_and_rates():
    videos = [
        {"views": 1000, "likes": 100, "comments": 10},
        {"views": 2000, "likes": 200, "comments": 20},
        {"views": 3000, "likes": 300, "comments": 30},
    ]
    out = estimate_video_engagement(videos, subscribers=100_000)
    assert out["est_engaged_fans"] == 200 and out["est_active_core"] == 20
    assert out["view_through"] == pytest.approx(0.02)
    assert out["like_rate"] == pytest.approx(0.1)
    assert out["comment_rate"] == pytest.approx(0.01)


def test_estimate_subscribers_nonpositive_and_zero_view():
    assert estimate_video_engagement(
        [{"views": 1000, "likes": 100, "comments": 10}], 0
    )["view_through"] is None
    out = estimate_video_engagement(
        [
            {"views": 1000, "likes": 100, "comments": 10},
            {"views": 0, "likes": 0, "comments": 0},
            {"views": 1000, "likes": 100, "comments": 10},
        ],
        100_000,
    )
    assert out["like_rate"] == pytest.approx(0.1)


def _bc(vid, ended, ao):
    return {
        "video_id": vid,
        "ended_at": ended,
        "messages": [{"author": a, "offset_ms": o} for a, o in ao],
    }


def test_compute_live_activity_scored_two_broadcasts():
    bc = [
        _bc("v1", "2026-06-16T12:00:00Z", [("a", 1000), ("b", 2000), ("c", 3000)]),
        _bc("v2", "2026-06-17T12:00:00Z", [("a", 1000), ("b", 2000), ("d", 3000)]),
    ]
    videos = [
        {"views": 1000, "likes": 100, "comments": 10},
        {"views": 2000, "likes": 200, "comments": 20},
        {"views": 3000, "likes": 300, "comments": 30},
    ]
    per_b, s = compute_live_activity(bc, videos, 100_000)
    assert [r["basis"] for r in per_b] == ["low_confidence", "scored"]
    assert per_b[1]["returning_rate"] == pytest.approx(0.6667, abs=1e-4)
    assert s["basis"] == "scored"
    assert s["median_unique_chatters"] == 3
    assert s["median_peak_msgs_per_min"] == 3
    assert s["core_fan_count"] == 2
    assert s["core_fan_share"] == pytest.approx(0.5)
    assert s["est_engaged_fans"] == 200


def test_compute_live_activity_low_confidence_single():
    per_b, s = compute_live_activity(
        [_bc("v1", "2026-06-16T12:00:00Z", [("a", 1000), ("b", 2000)])],
        [],
        100_000,
    )
    assert s["basis"] == "low_confidence"
    assert s["median_returning_rate"] is None
    assert s["core_fan_count"] is None


def test_compute_live_activity_insufficient_no_broadcast():
    per_b, s = compute_live_activity(
        [], [{"views": 1000, "likes": 100, "comments": 10}], 100_000
    )
    assert per_b == []
    assert s["basis"] == "insufficient"
    assert s["broadcast_count"] == 0
    assert s["est_engaged_fans"] == 100


class _FakeClient:
    def __init__(self, reports, messages, videos, subs):
        self._r, self._m, self._v, self._s = reports, messages, videos, subs

    def execute(self, sql, params=None):
        if "live_chat_reports" in sql:
            return self._r
        if "live_chat_messages" in sql:
            return self._m
        if "youtube_videos" in sql:
            return self._v
        if "agg_summary" in sql:
            return self._s
        return []


def _miiwan_client():
    return _FakeClient(
        reports=[
            {"video_id": "v1", "ended_at": "2026-06-16T12:00:00Z"},
            {"video_id": "v2", "ended_at": "2026-06-17T12:00:00Z"},
        ],
        messages=(
            [{"video_id": "v1", "author": a, "offset_ms": o}
             for a, o in [("a", 1000), ("b", 2000), ("c", 3000)]]
            + [{"video_id": "v2", "author": a, "offset_ms": o}
               for a, o in [("a", 1000), ("b", 2000), ("d", 3000)]]
        ),
        videos=[
            {"video_id": "y1", "views": 1000, "likes": 100, "comments": 10},
            {"video_id": "y2", "views": 2000, "likes": 200, "comments": 20},
            {"video_id": "y3", "views": 3000, "likes": 300, "comments": 30},
        ],
        subs=[{"yt_subscribers": 100_000, "snapshot_at": "2026-06-20T00:00:00Z"}],
    )


def test_build_live_activity_statements_shape():
    stmts = build_live_activity(_miiwan_client(), group_key="miiwan").statements
    assert len(stmts) == 5
    assert stmts[0][0].startswith("DELETE FROM agg_live_activity ")
    assert stmts[0][1] == ["miiwan"]
    sql, params = stmts[-1]
    assert "agg_live_activity_summary" in sql
    assert params[3] == 2      # broadcast_count
    assert params[8] == 2      # core_fan_count
    assert params[10] == 200   # est_engaged_fans
    assert params[-1] == "scored"


def test_build_live_activity_idempotent_row_count():
    r1 = build_live_activity(_miiwan_client(), group_key="miiwan")
    r2 = build_live_activity(_miiwan_client(), group_key="miiwan")
    assert len(r1.statements) == len(r2.statements)
    s1 = next(p for s, p in r1.statements if "agg_live_activity_summary" in s)
    s2 = next(p for s, p in r2.statements if "agg_live_activity_summary" in s)
    assert s1[2:] == s2[2:]


def test_build_live_activity_empty_group_insufficient():
    res = build_live_activity(_FakeClient([], [], [], []), group_key="plave")
    assert len(res.statements) == 3
    assert res.statements[-1][1][-1] == "insufficient"
