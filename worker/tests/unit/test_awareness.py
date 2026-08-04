"""Awareness Index (P2b) — compute 순수 + build D1 + migration 0097.

test_loyalty.py(compute 순수 + _FakeClient build) / test_live_chat_migration.py
(_apply_all 스모크) 컨벤션 미러.
"""
import math
import sqlite3
from pathlib import Path

import pytest

from idol_sight.analysis.awareness import (
    AWARENESS_WEIGHTS,
    build_awareness,
    compute_awareness,
)

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _by_key(rows):
    return {r["group_key"]: r for r in rows}


# -- compute_awareness (순수) --

def test_compute_leader_normalized_to_one_each_signal():
    groups = [
        {"key": "plave", "group_model": "corporate",
         "yt_subscribers": 1_000_000, "yt_total_views": 160_000_000,
         "naver_total_news": 300},
        {"key": "skinz", "group_model": "corporate",
         "yt_subscribers": 100_000, "yt_total_views": 10_000_000,
         "naver_total_news": 20},
    ]
    out = _by_key(compute_awareness(groups))
    plave = out["plave"]
    assert plave["sub_n"] == pytest.approx(1.0)
    assert plave["view_n"] == pytest.approx(1.0)
    assert plave["news_n"] == pytest.approx(1.0)
    assert plave["awareness_score"] == pytest.approx(100.0)
    assert plave["basis"] == "scored"
    skinz = out["skinz"]
    # v2 band: [log1p(0.001·ref), log1p(ref)] 로 정규화. skinz 구독 10만은
    # 리더(100만)의 10% → 3데케이드 중 2/3 지점(≈0.67).
    _lo = math.log1p(0.001 * 1_000_000)
    _hi = math.log1p(1_000_000)
    assert skinz["sub_n"] == pytest.approx(
        (math.log1p(100_000) - _lo) / (_hi - _lo))
    assert skinz["awareness_score"] < 100.0


def test_compute_weighting_sub_only_is_half():
    groups = [
        {"key": "lead", "group_model": "corporate",
         "yt_subscribers": 500, "yt_total_views": 0, "naver_total_news": 0},
    ]
    lead = _by_key(compute_awareness(groups))["lead"]
    assert lead["sub_n"] == pytest.approx(1.0)
    assert lead["view_n"] == 0.0
    assert lead["news_n"] == 0.0
    assert lead["awareness_score"] == pytest.approx(
        AWARENESS_WEIGHTS["sub"] * 100.0)


def test_compute_band_normalization_within_and_below_floor():
    # v2 band(2026-08): 리더 대비 [0.1%, 100%] 규모를 [0, 1]에 log 스케일로
    # 펼침. 기존 [1%,100%]는 리더가 초대형(PLAVE 1.2M)일 때 소형 그룹 전원을
    # 0으로 클램프해 뉴스 신호만 남기는 증폭 요인이었다. 0.1% 이하만 클램프.
    groups = [
        {"key": "lead", "group_model": "corporate",
         "yt_subscribers": 1_000_000, "yt_total_views": 0, "naver_total_news": 0},
        {"key": "mid", "group_model": "corporate",
         "yt_subscribers": 100_000, "yt_total_views": 0, "naver_total_news": 0},
        {"key": "small", "group_model": "corporate",
         "yt_subscribers": 10_000, "yt_total_views": 0, "naver_total_news": 0},
        {"key": "tiny", "group_model": "corporate",
         "yt_subscribers": 1000, "yt_total_views": 0, "naver_total_news": 0},
    ]
    out = _by_key(compute_awareness(groups))
    assert out["lead"]["sub_n"] == pytest.approx(1.0)   # 리더 = 정확히 1.0
    _lo = math.log1p(0.001 * 1_000_000)
    _hi = math.log1p(1_000_000)
    expected_mid = (math.log1p(100_000) - _lo) / (_hi - _lo)
    assert out["mid"]["sub_n"] == pytest.approx(expected_mid)
    # small 구독 10K = 리더의 1% — 구밴드에선 정확히 하한(0.0)이었지만
    # 새 밴드에선 살아난다 (소형 그룹 0-클램프 병리의 핵심 수정).
    assert out["small"]["sub_n"] > 0.3
    # tiny 구독 1000 = 리더의 0.1% (= 새 밴드 하한) → 0.0 클램프 유지.
    assert out["tiny"]["sub_n"] == 0.0


def test_compute_category_max_zero_guard():
    groups = [
        {"key": "a", "group_model": "corporate",
         "yt_subscribers": 1000, "yt_total_views": 1000, "naver_total_news": 0},
        {"key": "b", "group_model": "corporate",
         "yt_subscribers": 500, "yt_total_views": 500, "naver_total_news": 0},
    ]
    out = _by_key(compute_awareness(groups))
    assert out["a"]["news_n"] == 0.0
    assert out["b"]["news_n"] == 0.0
    assert out["a"]["basis"] == "scored"


def test_compute_null_and_negative_signals_coerced_to_zero():
    groups = [
        {"key": "lead", "group_model": "corporate",
         "yt_subscribers": 1000, "yt_total_views": 1000, "naver_total_news": 100},
        {"key": "nully", "group_model": "corporate",
         "yt_subscribers": None, "yt_total_views": -5, "naver_total_news": 50},
    ]
    nully = _by_key(compute_awareness(groups))["nully"]
    assert nully["sub_n"] == 0.0
    assert nully["view_n"] == 0.0
    # v2 band: news ref=100(lead), val=50 → 밴드 [log1p(0.1), log1p(100)].
    _lo = math.log1p(0.001 * 100)
    _hi = math.log1p(100)
    assert nully["news_n"] == pytest.approx(
        (math.log1p(50) - _lo) / (_hi - _lo))
    assert nully["basis"] == "scored"


def test_compute_insufficient_when_all_signals_zero_or_null():
    groups = [
        {"key": "lead", "group_model": "corporate",
         "yt_subscribers": 1000, "yt_total_views": 1000, "naver_total_news": 100},
        {"key": "ghost", "group_model": "corporate",
         "yt_subscribers": 0, "yt_total_views": None, "naver_total_news": 0},
    ]
    out = _by_key(compute_awareness(groups))
    ghost = out["ghost"]
    assert ghost["basis"] == "insufficient"
    assert ghost["awareness_score"] is None
    assert ghost["category_rank"] is None
    assert out["lead"]["category_rank"] == 1


def test_compute_category_separation_independent_ranks():
    groups = [
        {"key": "plave", "group_model": "corporate",
         "yt_subscribers": 1_000_000, "yt_total_views": 160_000_000,
         "naver_total_news": 300},
        {"key": "skinz", "group_model": "corporate",
         "yt_subscribers": 100_000, "yt_total_views": 10_000_000,
         "naver_total_news": 20},
        {"key": "isedol", "group_model": "segmentary",
         "yt_subscribers": 8_000_000, "yt_total_views": 1_200_000_000,
         "naver_total_news": 50},
        {"key": "stellive", "group_model": "confederation",
         "yt_subscribers": 5_000_000, "yt_total_views": 800_000_000,
         "naver_total_news": 30},
    ]
    out = _by_key(compute_awareness(groups))
    assert out["plave"]["category"] == "kpop"
    assert out["isedol"]["category"] == "subculture"
    assert out["plave"]["category_rank"] == 1
    assert out["skinz"]["category_rank"] == 2
    assert out["isedol"]["category_rank"] == 1
    assert out["stellive"]["category_rank"] == 2
    assert out["plave"]["awareness_score"] == pytest.approx(100.0)
    assert out["isedol"]["awareness_score"] == pytest.approx(100.0)


def test_compute_tiebreak_by_subscribers_descending():
    groups = [
        {"key": "lead", "group_model": "segmentary",
         "yt_subscribers": 10_000, "yt_total_views": 10_000,
         "naver_total_news": 2000},
        {"key": "hi", "group_model": "segmentary",
         "yt_subscribers": 5000, "yt_total_views": 0, "naver_total_news": 0},
        {"key": "lo", "group_model": "segmentary",
         "yt_subscribers": 4999, "yt_total_views": 0, "naver_total_news": 0},
    ]
    out = _by_key(compute_awareness(groups))
    # v2 band: hi/lo 구독이 근접(5000 vs 4999)해 밴드 정규화 점수가 1자리
    # 반올림에서 동률(44.9) → subscribers 내림차순 tiebreak 로 순위 결정.
    assert out["hi"]["awareness_score"] == out["lo"]["awareness_score"] == 44.9
    assert out["lead"]["category_rank"] == 1
    assert out["hi"]["category_rank"] == 2
    assert out["lo"]["category_rank"] == 3


def test_compute_includes_pre_debut_group():
    groups = [
        {"key": "established", "group_model": "corporate",
         "yt_subscribers": 1_000_000, "yt_total_views": 5_000_000,
         "naver_total_news": 100},
        {"key": "predebut", "group_model": "corporate",
         "yt_subscribers": 50_000, "yt_total_views": 0, "naver_total_news": 0},
    ]
    out = _by_key(compute_awareness(groups))
    assert out["predebut"]["basis"] == "scored"
    assert out["predebut"]["category_rank"] == 2
    assert out["established"]["category_rank"] == 1


# ── V2.53 Organic Trust Layer ──────────────────────────────────────

def test_awareness_adj_discounts_by_confidence():
    groups = [
        {"key": "clean", "group_model": "corporate",
         "yt_subscribers": 1000, "yt_total_views": 100000, "naver_total_news": 10},
        {"key": "paidish", "group_model": "corporate",
         "yt_subscribers": 900, "yt_total_views": 90000, "naver_total_news": 9},
    ]
    rows = compute_awareness(groups, confidence_by_key={"paidish": 0.5})
    by = {r["group_key"]: r for r in rows}
    # clean: confidence 부재 → 1.0 무할인, adj == raw
    assert by["clean"]["organic_confidence"] == 1.0
    assert by["clean"]["awareness_score_adj"] == by["clean"]["awareness_score"]
    # paidish: adj = raw * 0.5 (1자리 반올림)
    assert by["paidish"]["awareness_score_adj"] == round(
        by["paidish"]["awareness_score"] * 0.5, 1)


def test_awareness_rank_adj_reorders():
    # raw 는 big 이 1위지만 conf 0.3 할인 후 small 이 1위
    groups = [
        {"key": "big", "group_model": "corporate",
         "yt_subscribers": 10000, "yt_total_views": 1000000, "naver_total_news": 50},
        {"key": "small", "group_model": "corporate",
         "yt_subscribers": 3000, "yt_total_views": 200000, "naver_total_news": 20},
    ]
    rows = compute_awareness(groups, confidence_by_key={"big": 0.3})
    by = {r["group_key"]: r for r in rows}
    assert by["big"]["category_rank"] == 1          # 원값 랭킹 불변
    assert by["small"]["category_rank_adj"] == 1    # 보정 랭킹 역전
    assert by["big"]["category_rank_adj"] == 2


def test_awareness_insufficient_has_null_adj():
    rows = compute_awareness([
        {"key": "ghost", "group_model": "corporate",
         "yt_subscribers": 0, "yt_total_views": 0, "naver_total_news": 0},
    ])
    assert rows[0]["awareness_score_adj"] is None
    assert rows[0]["category_rank_adj"] is None


def test_awareness_no_confidence_map_backward_compat():
    # confidence_by_key 미전달 → 전원 1.0, adj == raw, rank_adj == rank
    rows = compute_awareness([
        {"key": "a", "group_model": "corporate",
         "yt_subscribers": 100, "yt_total_views": 1000, "naver_total_news": 1},
    ])
    assert rows[0]["awareness_score_adj"] == rows[0]["awareness_score"]
    assert rows[0]["category_rank_adj"] == rows[0]["category_rank"]


# -- build_awareness (D1, _FakeClient) --

class _FakeClient:
    def __init__(self, groups, agg):
        self._groups = groups
        self._agg = agg

    def execute(self, sql, params=None):
        if "FROM groups" in sql:
            return self._groups
        if "agg_summary" in sql:
            return self._agg
        return []


def _fake():
    return _FakeClient(
        groups=[
            {"key": "plave", "group_model": "corporate"},
            {"key": "skinz", "group_model": "corporate"},
            {"key": "isedol", "group_model": "segmentary"},
        ],
        agg=[
            # v2: build 는 naver_news_90d 를 우선 소비(0113) — 픽스처는 누적과
            # 같은 값으로 채워 기존 기대값 유지.
            {"group_key": "plave", "yt_subscribers": 1_000_000,
             "yt_total_views": 160_000_000, "naver_total_news": 300,
             "naver_news_90d": 300},
            {"group_key": "skinz", "yt_subscribers": 100_000,
             "yt_total_views": 10_000_000, "naver_total_news": 20,
             "naver_news_90d": 20},
            {"group_key": "isedol", "yt_subscribers": 8_000_000,
             "yt_total_views": 1_200_000_000, "naver_total_news": 50,
             "naver_news_90d": 50},
        ],
    )


def test_build_awareness_delete_leads_and_row_per_group():
    res = build_awareness(_fake(), snapshot_at="2026-06-27T00:00:00Z")
    assert len(res.statements) == 4
    sql0, params0 = res.statements[0]
    assert sql0.strip().upper().startswith("DELETE")
    assert params0 == ["2026-06-27T00:00:00Z"]
    params_by_group = {st[1][0]: st[1] for st in res.statements[1:]}
    assert set(params_by_group) == {"plave", "skinz", "isedol"}
    assert all(st[1][1] == "2026-06-27T00:00:00Z" for st in res.statements[1:])


def test_build_awareness_writes_category_and_rank():
    res = build_awareness(_fake(), snapshot_at="2026-06-27T00:00:00Z")
    by_group = {st[1][0]: st[1] for st in res.statements[1:]}
    plave = by_group["plave"]
    assert plave[2] == "kpop"
    assert plave[3] == pytest.approx(100.0)
    assert plave[4] == 1
    assert plave[8] == "scored"
    isedol = by_group["isedol"]
    assert isedol[2] == "subculture"
    assert isedol[4] == 1
    assert by_group["skinz"][4] == 2


def test_build_awareness_idempotent_rebuild():
    snap = "2026-06-27T00:00:00Z"
    a = build_awareness(_fake(), snapshot_at=snap)
    b = build_awareness(_fake(), snapshot_at=snap)
    assert len(a.statements) == len(b.statements)
    a_rows = {st[1][0]: st[1][:9] for st in a.statements[1:]}
    b_rows = {st[1][0]: st[1][:9] for st in b.statements[1:]}
    assert a_rows == b_rows
    assert a.statements[0] == b.statements[0]


def test_build_awareness_insufficient_group_still_written():
    client = _FakeClient(
        groups=[
            {"key": "plave", "group_model": "corporate"},
            {"key": "ghost", "group_model": "corporate"},
        ],
        agg=[
            {"group_key": "plave", "yt_subscribers": 1_000_000,
             "yt_total_views": 160_000_000, "naver_total_news": 300},
            {"group_key": "ghost", "yt_subscribers": 0,
             "yt_total_views": None, "naver_total_news": 0},
        ],
    )
    res = build_awareness(client, snapshot_at="2026-06-27T00:00:00Z")
    by_group = {st[1][0]: st[1] for st in res.statements[1:]}
    ghost = by_group["ghost"]
    assert ghost[8] == "insufficient"
    assert ghost[3] is None
    assert ghost[4] is None
    assert by_group["plave"][4] == 1


# -- build_awareness V2.53 adj graceful INSERT (D1) --

def test_build_awareness_adj_columns_present_uses_extended_insert():
    # adj 컬럼 감지 성공(fake 가 해당 SELECT 에서 [] 반환) → 확장 INSERT.
    res = build_awareness(_fake(), snapshot_at="2026-06-27T00:00:00Z")
    insert_sql = res.statements[1][0]
    assert "awareness_score_adj" in insert_sql
    assert "organic_confidence" in insert_sql
    assert "category_rank_adj" in insert_sql
    # 확장 바인딩: 원본 10개 + adj 3개 = 13.
    assert len(res.statements[1][1]) == 13


def test_build_awareness_adj_columns_absent_falls_back_to_legacy_insert():
    # mig 0106 미적용 D1 시뮬: adj 프로브 SELECT 에서 raise → 기존 INSERT.
    class _NoAdjClient(_FakeClient):
        def execute(self, sql, params=None):
            if "awareness_score_adj" in sql:
                raise Exception("no such column: awareness_score_adj")
            return super().execute(sql, params)

    base = _fake()
    client = _NoAdjClient(groups=base._groups, agg=base._agg)
    res = build_awareness(client, snapshot_at="2026-06-27T00:00:00Z")
    insert_sql = res.statements[1][0]
    assert "awareness_score_adj" not in insert_sql
    assert len(res.statements[1][1]) == 10


# -- build_awareness V2.53 confidence wiring (D1) --

def test_build_awareness_wires_organic_confidence_into_adj_columns():
    # debut_window_video_organicity 가 실제 verdict 행을 반환할 때, build_awareness
    # 가 load_organic_confidence 결과를 INSERT_SQL_ADJ 파라미터에 올바른 인덱스로
    # 채워 넣는지 end-to-end 로 확인. plave: organic 1 + likely_paid 1
    # → mean=(1.0+0.15)/2=0.575 → conf=(2*0.575+3*0.75)/5=0.68.
    class _ConfClient(_FakeClient):
        def execute(self, sql, params=None):
            if "debut_window_video_organicity" in sql:
                return [
                    {"group_key": "plave", "verdict": "organic"},
                    {"group_key": "plave", "verdict": "likely_paid"},
                ]
            return super().execute(sql, params)

    base = _fake()
    client = _ConfClient(groups=base._groups, agg=base._agg)
    res = build_awareness(client, snapshot_at="2026-06-27T00:00:00Z")
    by_group = {st[1][0]: st[1] for st in res.statements[1:]}
    plave = by_group["plave"]
    assert plave[3] == pytest.approx(100.0)          # raw score unaffected
    assert plave[11] == pytest.approx(0.68)           # organic_confidence
    assert plave[10] == pytest.approx(round(100.0 * 0.68, 1))  # awareness_score_adj


# -- migration 0097 (_apply_all 스모크) --

def _apply_all():
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def test_migration_creates_agg_awareness_table():
    conn = _apply_all()
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "agg_awareness" in tables
    cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_awareness)")}
    assert {"group_key", "snapshot_at", "category", "awareness_score",
            "category_rank", "sub_n", "view_n", "news_n", "basis",
            "generated_at"} <= cols
    indexes = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' "
        "AND tbl_name='agg_awareness'")}
    assert "idx_aw_snapshot" in indexes


def test_migration_agg_awareness_pk_is_group_key_snapshot():
    conn = _apply_all()
    pk_cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_awareness)")
               if r[5] > 0}
    assert pk_cols == {"group_key", "snapshot_at"}
    ins = ("INSERT INTO agg_awareness "
           "(group_key, snapshot_at, category, awareness_score, category_rank, "
           " sub_n, view_n, news_n, basis, generated_at) "
           "VALUES ('plave','2026-06-27T00:00:00Z','kpop',100.0,1,"
           "1.0,1.0,1.0,'scored','2026-06-27T01:00:00Z')")
    conn.execute(ins)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(ins)


def test_build_awareness_prefers_naver_news_90d_when_column_present():
    """v2(2026-08): 뉴스 신호 = naver_news_90d(최근 90일 플로우). 컬럼이 있는
    D1에선 누적(naver_total_news) 대신 90d 값이 news_n 을 결정한다."""
    fake = _FakeClient(
        groups=[
            {"key": "plave", "group_model": "corporate"},
            {"key": "quiet", "group_model": "corporate"},
        ],
        agg=[
            # quiet: 누적 200건(과거 관성)이지만 최근 90일 0건.
            {"group_key": "plave", "yt_subscribers": 1_000_000,
             "yt_total_views": 160_000_000, "naver_total_news": 300,
             "naver_news_90d": 100},
            {"group_key": "quiet", "yt_subscribers": 0,
             "yt_total_views": 0, "naver_total_news": 200,
             "naver_news_90d": 0},
        ],
    )
    res = build_awareness(fake, snapshot_at="2026-08-04T00:00:00Z")
    by_group = {st[1][0]: st[1] for st in res.statements[1:]}
    # quiet: 90d=0 → 세 신호 전부 0 → insufficient (score None).
    assert by_group["quiet"][3] is None
    # plave: 90d=100 → news 리더 → news_n(=params[7]) 1.0.
    assert by_group["plave"][7] == 1.0


def test_build_awareness_falls_back_to_total_news_without_90d_column():
    """마이그레이션(0113) 미적용 D1: 감지 쿼리가 실패하면 누적으로 폴백."""
    class _NoColumnClient(_FakeClient):
        def execute(self, sql, params=None):
            if "naver_news_90d" in sql:
                raise RuntimeError("no such column: naver_news_90d")
            return super().execute(sql, params)

    fake = _NoColumnClient(
        groups=[{"key": "plave", "group_model": "corporate"}],
        agg=[{"group_key": "plave", "yt_subscribers": 0,
              "yt_total_views": 0, "naver_total_news": 300}],
    )
    res = build_awareness(fake, snapshot_at="2026-08-04T00:00:00Z")
    by_group = {st[1][0]: st[1] for st in res.statements[1:]}
    assert by_group["plave"][7] == 1.0   # 누적 300 → news 리더
