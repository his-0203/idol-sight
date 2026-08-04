"""전 그룹 추정 코어팬 — compute 순수 + build D1 + migration 0101.

test_awareness.py(compute 순수 + _FakeClient build + _apply_all 스모크)
컨벤션 미러.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from idol_sight.analysis.core_fan_estimate import (
    build_core_fan_estimate,
    compute_core_fan_estimate,
    select_organic_videos,
)

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


# ---------------------------------------------------------------------------
# compute_core_fan_estimate (순수)
# ---------------------------------------------------------------------------


def _make_video(likes: float, comments: float, views: float) -> dict[str, Any]:
    return {"views": views, "likes": likes, "comments": comments}


def test_compute_median_and_basis_scored() -> None:
    """영상이 있으면 basis='scored', median 정수화."""
    videos = [
        _make_video(100, 10, 5000),
        _make_video(200, 20, 8000),
        _make_video(150, 15, 6000),
    ]
    rows = compute_core_fan_estimate([{"key": "plave", "videos": videos}])
    assert len(rows) == 1
    r = rows[0]
    assert r["group_key"] == "plave"
    assert r["basis"] == "scored"
    assert r["est_engaged_fans"] == 150  # median(100,150,200)
    assert r["est_active_core"] == 15   # median(10,15,20)
    assert r["video_count"] == 3
    assert r["like_rate"] is not None
    assert r["comment_rate"] is not None


def test_compute_basis_insufficient_when_no_videos() -> None:
    """영상 없음 → basis='insufficient', 수치 전부 None."""
    rows = compute_core_fan_estimate([{"key": "ghost", "videos": []}])
    r = rows[0]
    assert r["basis"] == "insufficient"
    assert r["est_engaged_fans"] is None
    assert r["est_active_core"] is None
    assert r["like_rate"] is None
    assert r["comment_rate"] is None
    assert r["video_count"] == 0


def test_compute_views_zero_excluded_from_rates() -> None:
    """views=0 영상은 like_rate / comment_rate 비율 산출에서만 제외."""
    videos = [
        _make_video(100, 10, 0),    # views=0 → 비율 제외
        _make_video(200, 20, 4000),
    ]
    rows = compute_core_fan_estimate([{"key": "miiwan", "videos": videos}])
    r = rows[0]
    assert r["basis"] == "scored"
    assert r["est_engaged_fans"] == round((100 + 200) / 2)  # median of 2 values
    # like_rate 는 views>0 인 영상(1개)만: 200/4000
    assert r["like_rate"] == pytest.approx(200 / 4000, rel=1e-4)
    # comment_rate: 20/4000
    assert r["comment_rate"] == pytest.approx(20 / 4000, rel=1e-4)
    assert r["video_count"] == 2


def test_compute_null_likes_treated_as_zero() -> None:
    """NULL likes/comments → 0 처리."""
    videos = [
        {"views": 5000, "likes": None, "comments": None},
        {"views": 4000, "likes": 100, "comments": 10},
    ]
    rows = compute_core_fan_estimate([{"key": "skinz", "videos": videos}])
    r = rows[0]
    assert r["basis"] == "scored"
    assert r["est_engaged_fans"] == round((0 + 100) / 2)
    assert r["est_active_core"] == round((0 + 10) / 2)


def test_compute_multiple_groups() -> None:
    """여러 그룹 입력 → 동일 개수 출력, 각 그룹 독립 계산."""
    group_videos = [
        {"key": "a", "videos": [_make_video(100, 10, 5000)]},
        {"key": "b", "videos": []},
        {"key": "c", "videos": [_make_video(200, 20, 8000), _make_video(300, 30, 9000)]},
    ]
    rows = compute_core_fan_estimate(group_videos)
    assert len(rows) == 3
    by_key = {r["group_key"]: r for r in rows}
    assert by_key["a"]["basis"] == "scored"
    assert by_key["b"]["basis"] == "insufficient"
    assert by_key["c"]["basis"] == "scored"
    assert by_key["c"]["est_engaged_fans"] == 250  # median(200,300)


def test_compute_missing_videos_key_treated_as_empty() -> None:
    """'videos' 키가 없으면 빈 것으로 취급 → insufficient."""
    rows = compute_core_fan_estimate([{"key": "nokey"}])
    assert rows[0]["basis"] == "insufficient"


# ---------------------------------------------------------------------------
# build_core_fan_estimate (D1, _FakeClient)
# ---------------------------------------------------------------------------


class _FakeClient:
    """테스트용 D1 클라이언트. window SQL과 fallback SQL을 그룹키로 분리 반환."""

    def __init__(
        self,
        groups: list[dict[str, Any]],
        videos_window: dict[str, list[dict[str, Any]]],
        videos_fallback: dict[str, list[dict[str, Any]]] | None = None,
    ) -> None:
        self._groups = groups
        self._videos_window = videos_window
        self._videos_fallback = videos_fallback if videos_fallback is not None else videos_window
        self._calls: list[tuple[str, list[Any] | None]] = []

    def execute(
        self, sql: str, params: list[Any] | None = None
    ) -> list[dict[str, Any]]:
        self._calls.append((sql, params))
        # mig 0107 미적용 D1 모사: adj 컬럼 probe 는 raise → base INSERT 경로 사용.
        if "est_engaged_fans_adj" in sql:
            raise RuntimeError("no such column: est_engaged_fans_adj")
        # organicity 판정 로드: 이 fixture 엔 suspect 없음.
        if "debut_window_video_organicity" in sql:
            return []
        if "FROM groups" in sql:
            return list(self._groups)
        # video 쿼리: params[0] = group_key
        key: str = str(params[0]) if params else ""
        if "LIMIT" in sql:
            return list(self._videos_fallback.get(key, []))
        return list(self._videos_window.get(key, []))


def _three_videos() -> list[dict[str, Any]]:
    return [
        {"views": 5000, "likes": 100, "comments": 10},
        {"views": 6000, "likes": 150, "comments": 15},
        {"views": 4000, "likes": 120, "comments": 12},
    ]


def _simple_client(keys: list[str]) -> _FakeClient:
    videos = {k: _three_videos() for k in keys}
    return _FakeClient(
        groups=[{"key": k} for k in keys],
        videos_window=videos,
    )


def test_build_delete_leads_and_snapshot_keyed() -> None:
    """DELETE は statements[0]、snapshot_at でキー."""
    snap = "2026-06-27T00:00:00Z"
    res = build_core_fan_estimate(_simple_client(["plave"]), snapshot_at=snap)
    assert len(res.statements) >= 1
    sql0, params0 = res.statements[0]
    assert sql0.strip().upper().startswith("DELETE")
    assert "snapshot_at" in sql0
    assert params0 == [snap]


def test_build_one_insert_per_group() -> None:
    """그룹 수 만큼 INSERT + DELETE 1개."""
    snap = "2026-06-27T00:00:00Z"
    res = build_core_fan_estimate(_simple_client(["plave", "miiwan", "skinz"]), snapshot_at=snap)
    # DELETE(1) + INSERT*3
    assert len(res.statements) == 4
    group_keys = [st[1][0] for st in res.statements[1:]]
    assert set(group_keys) == {"plave", "miiwan", "skinz"}
    # snapshot_at 은 각 INSERT[1]
    for st in res.statements[1:]:
        assert st[1][1] == snap


def test_build_idempotent_same_inputs_same_output() -> None:
    """같은 입력으로 두 번 호출해도 같은 DELETE+INSERT 집합."""
    snap = "2026-06-27T00:00:00Z"
    client = _simple_client(["plave"])
    a = build_core_fan_estimate(client, snapshot_at=snap)
    b = build_core_fan_estimate(client, snapshot_at=snap)
    assert len(a.statements) == len(b.statements)
    # DELETE 동일
    assert a.statements[0][0] == b.statements[0][0]
    assert a.statements[0][1] == b.statements[0][1]
    # INSERT 의 group_key~video_count 동일 (generated_at 제외, 마지막 위치)
    a_row = a.statements[1][1][:-1]
    b_row = b.statements[1][1][:-1]
    assert a_row == b_row


def test_build_fallback_when_window_has_fewer_than_3_videos() -> None:
    """윈도우 영상 < 3 → fallback SQL 호출, fallback 영상 수 반영."""
    fallback_videos = [{"views": 3000, "likes": 50, "comments": 5}] * 12
    client = _FakeClient(
        groups=[{"key": "miiwan"}],
        videos_window={"miiwan": [{"views": 1000, "likes": 30, "comments": 3}]},  # 1개
        videos_fallback={"miiwan": fallback_videos},
    )
    res = build_core_fan_estimate(client, snapshot_at="2026-06-27T00:00:00Z")
    insert = res.statements[1]
    # video_count = index 6 in INSERT params (after group_key, snapshot_at, ef, ac, lr, cr)
    assert insert[1][6] == 12


def test_build_window_sufficient_no_fallback() -> None:
    """윈도우 영상 ≥ 3 이면 fallback SQL 호출 없음."""
    client = _FakeClient(
        groups=[{"key": "plave"}],
        videos_window={"plave": _three_videos()},
        videos_fallback={"plave": [{"views": 100, "likes": 1, "comments": 0}] * 12},
    )
    build_core_fan_estimate(client, snapshot_at="2026-06-27T00:00:00Z")
    # video 폴백 쿼리만 판별 (adj-probe SQL도 LIMIT 1 을 포함하므로 테이블로 구분).
    fallback_calls = [
        c for c in client._calls
        if "youtube_videos" in c[0] and "LIMIT" in c[0]
    ]
    assert len(fallback_calls) == 0


def test_build_insufficient_group_written_with_null_values() -> None:
    """영상 없는 그룹도 insufficient row 로 적재(NULL 값)."""
    client = _FakeClient(
        groups=[{"key": "ghost"}],
        videos_window={"ghost": []},
        videos_fallback={"ghost": []},
    )
    res = build_core_fan_estimate(client, snapshot_at="2026-06-27T00:00:00Z")
    # DELETE + 1 INSERT
    assert len(res.statements) == 2
    insert = res.statements[1]
    params = insert[1]
    # est_engaged_fans=params[2], est_active_core=params[3]
    assert params[2] is None
    assert params[3] is None
    assert params[7] == "insufficient"  # basis


# ---------------------------------------------------------------------------
# migration 0101 (_apply_all 스모크)
# ---------------------------------------------------------------------------


def _apply_all() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def test_migration_creates_agg_core_fan_estimate_table() -> None:
    conn = _apply_all()
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    assert "agg_core_fan_estimate" in tables
    cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_core_fan_estimate)")}
    assert {
        "group_key", "snapshot_at", "est_engaged_fans", "est_active_core",
        "like_rate", "comment_rate", "video_count", "basis", "generated_at",
    } <= cols
    indexes = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND tbl_name='agg_core_fan_estimate'"
    )}
    assert "idx_cfe_snapshot" in indexes


def test_migration_agg_core_fan_estimate_pk_is_group_key_snapshot() -> None:
    conn = _apply_all()
    pk_cols = {
        r[1]
        for r in conn.execute("PRAGMA table_info(agg_core_fan_estimate)")
        if r[5] > 0
    }
    assert pk_cols == {"group_key", "snapshot_at"}
    ins = (
        "INSERT INTO agg_core_fan_estimate "
        "(group_key, snapshot_at, est_engaged_fans, est_active_core, "
        " like_rate, comment_rate, video_count, basis, generated_at) "
        "VALUES ('plave','2026-06-27T00:00:00Z',150,15,0.03,0.003,3,"
        "'scored','2026-06-27T01:00:00Z')"
    )
    conn.execute(ins)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(ins)


# ---------------------------------------------------------------------------
# ── V2.53 Organic Trust Layer ──────────────────────────────────────
# ---------------------------------------------------------------------------


def _vid(i, views=1000, likes=50, comments=10):
    return {"video_id": f"v{i}", "published_at": "2026-07-01T00:00:00Z",
            "views": views, "likes": likes, "comments": comments}


def test_select_organic_videos_filters_suspects():
    window = [_vid(1), _vid(2), _vid(3), _vid(4)]
    out = select_organic_videos(window, [], {"v4"})
    assert out is not None
    assert [v["video_id"] for v in out] == ["v1", "v2", "v3"]


def test_select_organic_videos_falls_back_then_none():
    window = [_vid(1), _vid(2), _vid(3)]
    fallback = [_vid(1), _vid(2), _vid(3), _vid(4), _vid(5)]
    # window 필터 후 1편 → 폴백 필터 적용 3편 → 폴백 채택
    out = select_organic_videos(window, fallback, {"v2", "v3"})
    assert out is not None
    assert [v["video_id"] for v in out] == ["v1", "v4", "v5"]
    # 폴백도 2편뿐 → None
    assert select_organic_videos(window, fallback[:4], {"v2", "v3", "v4"}) is None


def test_compute_adj_excludes_paid_medians():
    videos = [_vid(1, likes=100, comments=20), _vid(2, likes=110, comments=22),
              _vid(3, likes=90, comments=18),
              _vid(4, likes=9000, comments=2)]   # 팜 의심 (likes 폭발)
    rows = compute_core_fan_estimate([
        {"key": "g", "videos": videos, "videos_adj": videos[:3]},
    ])
    r = rows[0]
    assert r["basis"] == "scored"
    assert r["est_engaged_fans_adj"] == 100     # median(100,110,90)
    assert r["est_active_core_adj"] == 20
    assert r["organic_video_count"] == 3
    # 원값 경로는 불변 (4편 전체 median)
    assert r["est_engaged_fans"] == 105


def test_compute_insufficient_organic_basis():
    videos = [_vid(1), _vid(2), _vid(3)]
    rows = compute_core_fan_estimate([
        {"key": "g", "videos": videos, "videos_adj": None},
    ])
    r = rows[0]
    assert r["basis"] == "insufficient_organic"
    assert r["est_engaged_fans_adj"] is None
    assert r["est_engaged_fans"] is not None    # 원값은 유지 저장


def test_compute_missing_videos_adj_key_backward_compat():
    # videos_adj 키 자체가 없으면 videos 전체를 adj 로 간주 (기존 호출 호환)
    videos = [_vid(1), _vid(2), _vid(3)]
    rows = compute_core_fan_estimate([{"key": "g", "videos": videos}])
    assert rows[0]["basis"] == "scored"
    assert rows[0]["est_engaged_fans_adj"] == rows[0]["est_engaged_fans"]


# ---------------------------------------------------------------------------
# build_core_fan_estimate — V2.53 suspect 필터 + graceful adj INSERT
# ---------------------------------------------------------------------------


class _OrganicFakeClient:
    """V2.53 확장 FakeClient. suspect 판정 로드 + adj 컬럼 감지(probe) 제어."""

    def __init__(
        self,
        groups: list[dict[str, Any]],
        videos_window: dict[str, list[dict[str, Any]]],
        videos_fallback: dict[str, list[dict[str, Any]]] | None = None,
        suspect_ids: set[str] | None = None,
        has_adj: bool = True,
        suspect_raises: bool = False,
    ) -> None:
        self._groups = groups
        self._videos_window = videos_window
        self._videos_fallback = (
            videos_fallback if videos_fallback is not None else videos_window
        )
        self._suspect_ids = suspect_ids or set()
        self._has_adj = has_adj
        self._suspect_raises = suspect_raises
        self._calls: list[tuple[str, list[Any] | None]] = []

    def execute(
        self, sql: str, params: list[Any] | None = None
    ) -> list[dict[str, Any]]:
        self._calls.append((sql, params))
        # suspect 판정 로드 (params 없음)
        if "debut_window_video_organicity" in sql:
            if self._suspect_raises:
                raise RuntimeError("no such table: debut_window_video_organicity")
            return [{"video_id": vid} for vid in self._suspect_ids]
        # adj 컬럼 감지 probe (params 없음, LIMIT 포함 — video 분기보다 앞에)
        if "FROM agg_core_fan_estimate" in sql:
            if not self._has_adj:
                raise RuntimeError("no such column: est_engaged_fans_adj")
            return []
        if "FROM groups" in sql:
            return list(self._groups)
        key: str = str(params[0]) if params else ""
        if "LIMIT" in sql:
            return list(self._videos_fallback.get(key, []))
        return list(self._videos_window.get(key, []))


def test_build_suspect_filter_reflected_in_adj_insert_params():
    """suspect 영상 제외분이 adj INSERT 파라미터에 반영(원값은 전체 유지)."""
    window = [_vid(1, likes=100, comments=20), _vid(2, likes=110, comments=22),
              _vid(3, likes=90, comments=18), _vid(4, likes=9000, comments=2)]
    client = _OrganicFakeClient(
        groups=[{"key": "plave"}],
        videos_window={"plave": window},
        suspect_ids={"v4"},
        has_adj=True,
    )
    res = build_core_fan_estimate(client, snapshot_at="2026-06-27T00:00:00Z")
    insert_sql, params = res.statements[1]
    assert insert_sql.count("?") == 12          # 확장 INSERT (9 + adj 3)
    # 원값 경로 불변: 전체 4편 median
    assert params[2] == 105                      # est_engaged_fans (full)
    assert params[6] == 4                        # video_count (full)
    assert params[7] == "scored"                 # basis
    # adj 경로: suspect(v4) 제외 3편
    assert params[9] == 100                      # est_engaged_fans_adj
    assert params[10] == 20                      # est_active_core_adj
    assert params[11] == 3                       # organic_video_count
    # fallback 불필요 (window ≥3 이고 필터 후에도 ≥3) — video 폴백 쿼리만 판별.
    assert [c for c in client._calls
            if "youtube_videos" in c[0] and "LIMIT" in c[0]] == []


def test_build_no_adj_columns_falls_back_to_base_insert():
    """adj 컬럼 미존재(mig 0107 미적용) → 기존 9-컬럼 INSERT 로 graceful."""
    window = [_vid(1), _vid(2), _vid(3), _vid(4)]
    client = _OrganicFakeClient(
        groups=[{"key": "plave"}],
        videos_window={"plave": window},
        suspect_ids={"v4"},
        has_adj=False,
    )
    res = build_core_fan_estimate(client, snapshot_at="2026-06-27T00:00:00Z")
    insert_sql, params = res.statements[1]
    assert insert_sql.count("?") == 9            # 기존 INSERT (adj 없음)
    assert len(params) == 9
    assert params[7] == "scored"                 # basis 위치 불변


def test_build_suspect_load_failure_falls_back_to_no_filter():
    """organicity 쿼리 raise → suspect_ids=set() 폴백, 필터 없이 전 영상 organic."""
    window = [_vid(1), _vid(2), _vid(3)]
    client = _OrganicFakeClient(
        groups=[{"key": "plave"}],
        videos_window={"plave": window},
        suspect_ids={"v1"},          # 있어도 로드 실패면 무시돼야 함
        has_adj=True,
        suspect_raises=True,
    )
    res = build_core_fan_estimate(client, snapshot_at="2026-06-27T00:00:00Z")
    _, params = res.statements[1]
    # suspect 로드 실패 → 제외 없음, 전체 3편이 adj 표본
    assert params[7] == "scored"                 # basis
    assert params[6] == 3                        # video_count (full)
    assert params[11] == 3                       # organic_video_count (필터 없음)


# -- v2(2026-08): 반응 상위 5편 median — 볼륨 역상관 제거 --

def _vids(pairs):
    """[(likes, comments), ...] → 영상 행 목록."""
    return [{"video_id": f"v{i}", "views": 1000, "likes": lk, "comments": cm}
            for i, (lk, cm) in enumerate(pairs)]


def test_top5_median_ignores_low_engagement_tail():
    """일상 클립 다수(꼬리)가 median 을 희석하지 못한다 — 지표는 반응 상위
    5편의 median. 댓글 [50,40,30,20,10, 1,1,1,1,1] → top5 median 30
    (구산식 전체 median 은 5.5)."""
    rows = compute_core_fan_estimate([{
        "key": "g",
        "videos": _vids([(500, 50), (400, 40), (300, 30), (200, 20),
                         (100, 10), (1, 1), (1, 1), (1, 1), (1, 1), (1, 1)]),
    }])
    assert rows[0]["est_active_core"] == 30
    assert rows[0]["est_engaged_fans"] == 300
    assert rows[0]["video_count"] == 10   # 표본 수 표기는 전체 유지


def test_top5_selection_is_per_signal():
    """좋아요 상위 5편과 댓글 상위 5편은 독립 선별 — 각 지표가 자기 신호
    기준 '가장 동원된 5편'을 본다."""
    rows = compute_core_fan_estimate([{
        "key": "g",
        # 좋아요는 앞 5편이 높고, 댓글은 뒤 5편이 높다.
        "videos": _vids([(900, 1), (800, 1), (700, 1), (600, 1), (500, 1),
                         (1, 90), (1, 80), (1, 70), (1, 60), (1, 50)]),
    }])
    assert rows[0]["est_engaged_fans"] == 700   # median(900..500)
    assert rows[0]["est_active_core"] == 70     # median(90..50)


def test_volume_monotonicity_adding_videos_never_lowers_estimates():
    """핵심 성질: 표본이 이미 K(=5)편 이상이면 영상을 추가해도 추정치가
    내려가지 않는다(약단조) — '많이 올릴수록 불리' 구조 소멸의 회귀 가드.
    (표본 <K 구간은 top-K 가 저반응 영상으로 채워지며 하락 가능 — 전체
    median 과 동일한 경계 특성이라 예외로 둔다.)"""
    base = _vids([(500, 50), (400, 40), (300, 30), (200, 20), (100, 10)])
    more = base + _vids([(1, 1)] * 20)
    r_base = compute_core_fan_estimate([{"key": "g", "videos": base}])[0]
    r_more = compute_core_fan_estimate([{"key": "g", "videos": more}])[0]
    assert r_more["est_active_core"] >= r_base["est_active_core"]
    assert r_more["est_engaged_fans"] >= r_base["est_engaged_fans"]


def test_top5_with_fewer_than_five_videos_matches_plain_median():
    """표본 <5편이면 있는 만큼 — 현행 median 과 동일(연속성)."""
    rows = compute_core_fan_estimate([{
        "key": "g", "videos": _vids([(10, 3), (20, 5), (30, 7)]),
    }])
    assert rows[0]["est_active_core"] == 5
    assert rows[0]["est_engaged_fans"] == 20


def test_top5_applies_to_adj_sample_after_suspect_filter():
    """adj 경로: 유료 의심 제외 후 남은 표본에 동일 top-5 — 의심 영상이
    상위권이었다면 제외 후 median 이 내려간다."""
    videos = _vids([(500, 50), (400, 40), (300, 30), (200, 20),
                    (100, 10), (1, 1)])
    rows = compute_core_fan_estimate([{
        "key": "g",
        "videos": videos,
        "videos_adj": videos[2:],   # 상위 2편이 유료 의심으로 제외됐다고 가정
    }])
    assert rows[0]["est_active_core"] == 30        # 원값: top5 of 전체
    assert rows[0]["est_active_core_adj"] == 15    # adj: median(30,20,10,1 → top5=4편)
