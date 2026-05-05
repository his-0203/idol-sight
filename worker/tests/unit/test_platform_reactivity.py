"""Tests for cross-platform reactivity."""
from unittest.mock import MagicMock

from idol_sight.analysis.platform_reactivity import compute_reactivity


def _client(routes):
    """Mock D1 client whose execute() routes by SQL substring + optional
    params predicate. Routes is a list of (substring, predicate, rows)
    where predicate(params) -> bool.
    """
    client = MagicMock()

    def _execute(sql, params=None):
        for needle, pred, rows in routes:
            if needle in sql and (pred is None or pred(params or [])):
                return rows
        return []

    client.execute.side_effect = _execute
    return client


def test_no_viral_videos_resets_to_neutral_one():
    """Group with no viral videos → reactivity 1.0 / sample 0."""
    client = _client([
        ("FROM groups WHERE is_active=1", None, [{"key": "skinz"}]),
        ("WHERE group_key=?", None, []),  # no viral videos
    ])
    stmts = compute_reactivity(client, snapshot_at="2026-05-04T00:00:00Z")
    assert len(stmts) == 1
    sql, params = stmts[0]
    assert "UPDATE agg_summary" in sql
    # The "no viral" branch hardcodes neutral defaults right in the SQL.
    assert "reactivity_dc=1.0" in sql
    assert "reactivity_sample=0" in sql
    # WHERE clause params: group_key, snapshot_at.
    assert params == ["skinz", "2026-05-04T00:00:00Z"]


def test_high_after_low_before_yields_high_ratio():
    """1 viral video on PLAVE; DC: 5 posts before, 50 after → ratio 10
    capped to 5.0. Single-video → mean = 5.0."""
    routes = [
        ("FROM groups WHERE is_active=1", None, [{"key": "plave"}]),
        # Viral videos query
        ("WHERE group_key=?", lambda p: p[0] == "plave" and len(p) == 3, [
            {"video_id": "v1", "published_at": "2026-05-01T10:00:00Z",
             "viral_velocity_ratio": 6.0},
        ]),
        # Window counts: returned regardless of platform — we just
        # surface the same before/after for simplicity.
        ("SUM(CASE WHEN", None, [{"before_n": 5, "after_n": 50}]),
    ]
    stmts = compute_reactivity(_client(routes), snapshot_at="t")
    sql, params = stmts[0]
    # params order: dc, theqoo, instiz, naver, sample, group_key, snap.
    assert params[0] == 5.0   # dc reactivity capped at 5.0
    assert params[1] == 5.0   # theqoo
    assert params[2] == 5.0   # instiz
    assert params[3] == 5.0   # naver
    assert params[4] == 1     # sample size = 1 viral video


def test_balanced_before_after_yields_one():
    """50 before / 50 after → ratio 1.0 → "no spike from this comeback"."""
    routes = [
        ("FROM groups WHERE is_active=1", None, [{"key": "isedol"}]),
        ("WHERE group_key=?", lambda p: len(p) == 3, [
            {"video_id": "v1", "published_at": "2026-05-01T10:00:00Z",
             "viral_velocity_ratio": 3.0},
        ]),
        ("SUM(CASE WHEN", None, [{"before_n": 50, "after_n": 50}]),
    ]
    stmts = compute_reactivity(_client(routes), snapshot_at="t")
    sql, params = stmts[0]
    assert params[0] == 1.0
    assert params[3] == 1.0


def test_zero_before_zero_after_excludes_from_mean():
    """Inactive platform (0/0 in window) → not contributed to the mean.
    Average of empty list defaults to 1.0 (no signal)."""
    routes = [
        ("FROM groups WHERE is_active=1", None, [{"key": "owis"}]),
        ("WHERE group_key=?", lambda p: len(p) == 3, [
            {"video_id": "v1", "published_at": "2026-05-01T10:00:00Z",
             "viral_velocity_ratio": 4.0},
        ]),
        ("SUM(CASE WHEN", None, [{"before_n": 0, "after_n": 0}]),
    ]
    stmts = compute_reactivity(_client(routes), snapshot_at="t")
    sql, params = stmts[0]
    assert params[0] == 1.0
    assert params[1] == 1.0
    assert params[2] == 1.0
    assert params[3] == 1.0
    assert params[4] == 1   # sample (1 viral video) still counts


def test_zero_before_some_after_caps_at_five():
    """Brand-new audience post-debut → ratio capped at 5.0."""
    routes = [
        ("FROM groups WHERE is_active=1", None, [{"key": "miiwan"}]),
        ("WHERE group_key=?", lambda p: len(p) == 3, [
            {"video_id": "v1", "published_at": "2026-06-01T10:00:00Z",
             "viral_velocity_ratio": 8.0},
        ]),
        ("SUM(CASE WHEN", None, [{"before_n": 0, "after_n": 100}]),
    ]
    stmts = compute_reactivity(_client(routes), snapshot_at="t")
    _, params = stmts[0]
    assert params[0] == 5.0   # capped


def test_emits_one_update_statement_per_active_group():
    routes = [
        ("FROM groups WHERE is_active=1", None,
         [{"key": "plave"}, {"key": "isedol"}, {"key": "owis"}]),
        ("WHERE group_key=?", None, []),  # no viral for any
    ]
    stmts = compute_reactivity(_client(routes), snapshot_at="t")
    assert len(stmts) == 3
    keys = sorted(s[1][0] for s in stmts)
    assert keys == ["isedol", "owis", "plave"]
