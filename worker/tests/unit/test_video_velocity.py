"""Tests for the 24h velocity computation."""
from unittest.mock import MagicMock

from idol_sight.analysis.video_velocity import _interpolate_v24, compute_velocity


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
    """For each recent video, bracket the +24h mark and emit
    UPDATE youtube_videos SET view_count_24h=... (single-side rows here
    → fallback to that raw value, preserving the old asserted v24)."""
    by_param = {
        ("FROM youtube_video_stats", "v1"):
            [{"views": 500_000, "offset_days": -0.05}],
        ("FROM youtube_video_stats", "v2"):
            [{"views": 1_500_000, "offset_days": 0.1}],
    }
    client = _client(
        rows_by_query={
            "WHERE published_at IS NOT NULL": [
                {"video_id": "v1", "channel_id": "UC_PLAVE",
                 "group_key": "plave", "published_at": "2026-05-01T10:00:00Z"},
                {"video_id": "v2", "channel_id": "UC_PLAVE",
                 "group_key": "plave", "published_at": "2026-05-02T10:00:00Z"},
            ],
            "WHERE view_count_24h IS NOT NULL": [],
        },
        by_param=by_param,
    )
    result = compute_velocity(client)
    pass1 = [s for s in result.statements
             if "view_count_24h=" in s[0] and "viral_velocity_ratio" not in s[0]]
    assert len(pass1) == 2
    # params: [v24, interpolated_int, vid]
    by_vid = {s[1][2]: s[1][0] for s in pass1}
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
    """Staleness fix: ratio must use THIS cycle's v24 (Pass 1), not stale
    persisted. Single-side fallback gives fresh v24=2M overriding persisted
    100K: LOO mean = (2.1M-2M)/1 = 100K → ratio 20.0 (not 1.0)."""
    by_param = {
        ("FROM youtube_video_stats", "v_fresh"):
            [{"views": 2_000_000, "offset_days": -0.05}],
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


# === Task 8: _interpolate_v24 helper unit tests ===

def test_interpolate_both_sides_returns_time_weighted_value():
    # T+6h (offset -0.75, 300K) + T+42h (offset +0.75, 900K): +24h가 정확히
    # 중간 → 600K. 교정 전(최근접 단일행) 코드는 끝값(300K 또는 900K)을 반환했다.
    v24, interpolated = _interpolate_v24([
        {"views": 300_000, "offset_days": -0.75},
        {"views": 900_000, "offset_days": 0.75},
    ])
    assert v24 == 600_000
    assert interpolated is True


def test_interpolate_single_side_falls_back_with_low_confidence_flag():
    # 한쪽 스냅샷만 존재 → 보간 불가 → raw 값 폴백 + 저신뢰 플래그(False).
    v24, interpolated = _interpolate_v24([
        {"views": 500_000, "offset_days": -0.3},
    ])
    assert v24 == 500_000
    assert interpolated is False


def test_interpolate_no_rows_returns_none():
    assert _interpolate_v24([]) is None


# === Task 9: regression pin — interpolation vs old nearest-single code ===

def test_interpolation_changes_v24_and_ratio_vs_old_nearest_single():
    """Regression pin for the +24h interpolation fix (design §3.4).

    vA has snapshots straddling +24h at T+12h (400K, offset -0.5) and T+30h
    (700K, offset +0.25). The OLD code picked the single nearest row →
    v24=700K (T+30h is closer). The NEW code time-weights them to the +24h
    mark → v24=600K. With vB's single-side fallback v24=300K in the same
    channel, vA's leave-one-out ratio moves from 2.333 (old) to 2.0 (new)
    — an intended correction.
    """
    by_param = {
        ("FROM youtube_video_stats", "vA"): [
            {"views": 400_000, "offset_days": -0.5},   # T+12h
            {"views": 700_000, "offset_days": 0.25},   # T+30h
        ],
        ("FROM youtube_video_stats", "vB"): [
            {"views": 300_000, "offset_days": -0.1},    # single side → fallback
        ],
    }
    client = _client(
        rows_by_query={
            "WHERE published_at IS NOT NULL": [
                {"video_id": "vA", "channel_id": "UC", "group_key": "plave",
                 "published_at": "2026-05-01T10:00:00Z"},
                {"video_id": "vB", "channel_id": "UC", "group_key": "plave",
                 "published_at": "2026-05-02T10:00:00Z"},
            ],
            "WHERE view_count_24h IS NOT NULL": [],
        },
        by_param=by_param,
    )
    result = compute_velocity(client)
    # params: [v24, interpolated_int, vid]
    v24 = {s[1][2]: s[1][0] for s in result.statements
           if "view_count_24h=" in s[0] and "viral_velocity_ratio" not in s[0]}
    assert v24["vA"] == 600_000     # 700_000 under the old nearest-single code
    assert v24["vB"] == 300_000     # single-side fallback
    ratio = {s[1][1]: s[1][0] for s in result.statements
             if "viral_velocity_ratio=" in s[0]}
    assert abs(ratio["vA"] - 2.0) < 1e-3    # 2.333 under the old code


# === Task 7: module docstring describes interpolation, not single row ===

def test_module_docstring_describes_interpolation_not_single_row():
    """Design §3.4: the docstring used to claim we 'pick the row closest to
    (T+24h)' (single nearest row). After the fix it must describe the
    time-weighted interpolation behaviour instead."""
    import idol_sight.analysis.video_velocity as vv
    doc = vv.__doc__ or ""
    assert "pick the row closest" not in doc
    assert "interpolat" in doc.lower()


# === T4: view_count_24h_interpolated 컬럼 저장 검증 ===

def test_pass1_stores_interpolated_flag_both_sides():
    """양측 bracket 보간 케이스 → view_count_24h_interpolated=1 저장."""
    by_param = {
        ("FROM youtube_video_stats", "vX"): [
            {"views": 300_000, "offset_days": -0.5},
            {"views": 900_000, "offset_days": 0.5},
        ],
    }
    client = _client(
        rows_by_query={
            "WHERE published_at IS NOT NULL": [
                {"video_id": "vX", "channel_id": "UC", "group_key": "g",
                 "published_at": "2026-05-01T10:00:00Z"},
            ],
            "WHERE view_count_24h IS NOT NULL": [],
        },
        by_param=by_param,
    )
    result = compute_velocity(client)
    pass1 = [s for s in result.statements
             if "view_count_24h_interpolated" in s[0]]
    assert len(pass1) == 1
    # params: [v24, interpolated_int, vid]
    assert pass1[0][1][1] == 1    # 양측 보간 성공 → 1
    assert pass1[0][1][2] == "vX"
    assert pass1[0][1][0] == 600_000  # 선형 보간값 확인


def test_pass1_stores_interpolated_flag_single_side():
    """단측 스냅샷 폴백 케이스 → view_count_24h_interpolated=0 저장."""
    by_param = {
        ("FROM youtube_video_stats", "vY"): [
            {"views": 500_000, "offset_days": -0.3},   # before only
        ],
    }
    client = _client(
        rows_by_query={
            "WHERE published_at IS NOT NULL": [
                {"video_id": "vY", "channel_id": "UC", "group_key": "g",
                 "published_at": "2026-05-02T10:00:00Z"},
            ],
            "WHERE view_count_24h IS NOT NULL": [],
        },
        by_param=by_param,
    )
    result = compute_velocity(client)
    pass1 = [s for s in result.statements
             if "view_count_24h_interpolated" in s[0]]
    assert len(pass1) == 1
    assert pass1[0][1][1] == 0    # 단측 폴백 → 0
    assert pass1[0][1][2] == "vY"
    assert pass1[0][1][0] == 500_000


def test_migration_0098_adds_interpolated_column():
    """0098 마이그레이션이 youtube_videos에 view_count_24h_interpolated 컬럼을 추가한다."""
    import sqlite3
    from pathlib import Path

    migrations = Path(__file__).resolve().parents[3] / "migrations"
    conn = sqlite3.connect(":memory:")
    conn.executescript((migrations / "0001_init.sql").read_text())
    conn.executescript((migrations / "0098_video_velocity_interpolated.sql").read_text())
    cols = [r[1] for r in conn.execute(
        "PRAGMA table_info(youtube_videos)"
    ).fetchall()]
    assert "view_count_24h_interpolated" in cols
