"""Awareness Index (P2b) — 보유 신호로 산출하는 카테고리별 인지도 지수.

"버추얼 아이돌 인지도 순위" 요청에 직접 답하는 신규 표시 지표. 신규 수집 0 —
agg_summary 의 그룹별 최신 신호(구독·조회·뉴스)를 재가공한다. 각 신호를 카테고리
(K-POP/서브컬처) **리더 대비** log1p 정규화하고 가중합(0.5/0.35/0.15)해 0~100
점수화한 뒤, 카테고리별로 분리 랭킹한다.

리더 대비 정규화 채택 이유(min-max 아님): min-max 는 카테고리 최하위를 강제로
0 으로 만든다(SOV 의 "최하위 0%" 문제). 리더 대비는 리더=신호별 1.0, 나머지는
상대값 → 실측 보유 청중이 있는 그룹이 0 으로 깔리지 않는다. log1p 는 자릿수 차이
(PLAVE 수백만 vs 소형 그룹) 압축 + 영문/한글 naver 표기 비대칭 일부 완화.

Health Score 와 독립된 1차원 지표 — Health Reach 와 입력은 겹치나 목적이 다르고,
**데뷔 전 그룹도 포함**한다(데뷔 전에도 구독·조회로 인지도가 존재). 점수 산식
변경이 아니라 신규 표시 지표. 검색량(search_n)은 후속 플러그인 자리만 비워둔다 —
지수 구조 동일, 추가 시 가중치 재배분.
"""
from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult

__all__ = [
    "AWARENESS_WEIGHTS",
    "compute_awareness",
    "build_awareness",
]

# 신호 가중치 (합 = 1.0, first-pass — 데이터 축적 후 보정). 구독 0.5(보유 청중=
# 현 인지도 최강 신호) / 조회 0.35(도달) / 뉴스 0.15(언론, 표기 비대칭 편향 고려해
# 낮춤). 검색량 추가 시 재배분(예: 검색 0.3 신설, 나머지 0.7 로 비례 축소).
AWARENESS_WEIGHTS = {
    "sub":  0.50,
    "view": 0.35,
    "news": 0.15,
}
assert abs(sum(AWARENESS_WEIGHTS.values()) - 1.0) < 1e-9


def _category_of(group_model: str | None) -> str:
    """K-POP (corporate) vs 서브컬처 (segmentary/confederation).

    weekly_diagnosis_signals._category_of / frontend MarketOverview.categoryOf
    의 미러 — 그 모듈은 import 를 좁게 유지(import 금지)하므로 동일 규칙을 로컬에
    복제한다. 매핑이 바뀌면 세 곳을 함께 갱신.
    """
    if group_model == "corporate":
        return "kpop"
    if group_model in ("segmentary", "confederation"):
        return "subculture"
    return "kpop"   # safe default


def _coerce(value: Any) -> float:
    """NULL/음수/비수치 → 0.0, 그 외 float. (산식 §3.1: value NULL/음수 → 0.)"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    return v if v > 0 else 0.0


def _normalize_log(value: float, ref: float) -> float:
    """log1p 기반 [0, 1] 정규화 (health_score._normalize_log 미러).

    카테고리 리더(ref = 해당 카테고리 내 그 신호의 최댓값) 대비. value <= 0 또는
    ref <= 0 (category_max=0 가드) → 0. 리더(value==ref>0)는 정확히 1.0.
    """
    if value <= 0 or ref <= 0:
        return 0.0
    return min(math.log1p(value) / math.log1p(ref), 1.0)


def compute_awareness(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """그룹별 최신 신호 + group_model → 카테고리별 인지도 row dict 리스트 (순수).

    입력 dict(그룹당): ``key``, ``group_model``, ``yt_subscribers``,
    ``yt_total_views``, ``naver_total_news``. 출력 dict(그룹당, agg_awareness
    컬럼 미러): ``group_key``, ``category``, ``awareness_score`` (0~100 또는
    None), ``category_rank`` (int 또는 None, 1=최고), ``sub_n``/``view_n``/``news_n``
    (리더 대비 정규화 0~1), ``basis`` ('scored' | 'insufficient').

    각 신호를 카테고리 리더 대비 log1p 정규화 → 가중합 ×100 → 카테고리별 내림차순
    순위(동점은 yt_subscribers 내림차순 tiebreak). 데뷔 전 게이트 없음(전부 포함).
    세 신호 전부 NULL/0 인 그룹은 basis='insufficient'(score/rank None, 랭킹 제외).
    """
    # 1) 카테고리 분류 + 신호 정제(NULL/음수 → 0) + 신호 유무 판정.
    enriched: list[dict[str, Any]] = []
    for g in groups:
        sub = _coerce(g.get("yt_subscribers"))
        view = _coerce(g.get("yt_total_views"))
        news = _coerce(g.get("naver_total_news"))
        enriched.append({
            "group_key": g["key"],
            "category": _category_of(g.get("group_model")),
            "sub": sub, "view": view, "news": news,
            "has_signal": (sub > 0 or view > 0 or news > 0),
        })

    # 2) 카테고리별 신호 최댓값(리더). insufficient(전부 0) 그룹은 max 에 영향 없음.
    cat_max: dict[str, dict[str, float]] = {}
    for e in enriched:
        m = cat_max.setdefault(
            e["category"], {"sub": 0.0, "view": 0.0, "news": 0.0})
        m["sub"] = max(m["sub"], e["sub"])
        m["view"] = max(m["view"], e["view"])
        m["news"] = max(m["news"], e["news"])

    # 3) 리더 대비 정규화 + 가중 점수.
    rows: list[dict[str, Any]] = []
    for e in enriched:
        m = cat_max[e["category"]]
        sub_n = _normalize_log(e["sub"], m["sub"])
        view_n = _normalize_log(e["view"], m["view"])
        news_n = _normalize_log(e["news"], m["news"])
        if e["has_signal"]:
            score: float | None = round(
                (AWARENESS_WEIGHTS["sub"] * sub_n
                 + AWARENESS_WEIGHTS["view"] * view_n
                 + AWARENESS_WEIGHTS["news"] * news_n) * 100.0,
                1,
            )
            basis = "scored"
        else:
            score = None
            basis = "insufficient"
        rows.append({
            "group_key": e["group_key"],
            "category": e["category"],
            "awareness_score": score,
            "category_rank": None,
            "sub_n": sub_n,
            "view_n": view_n,
            "news_n": news_n,
            "basis": basis,
            "_sub_raw": e["sub"],   # tiebreak 용 (출력 직전 제거)
        })

    # 4) 카테고리별 순위 — score 내림차순, 동점은 subscribers 내림차순. insufficient
    #    는 제외(rank None 유지). K-POP/서브컬처 각각 독립.
    by_cat: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by_cat.setdefault(r["category"], []).append(r)
    for cat_rows in by_cat.values():
        scored = [r for r in cat_rows if r["basis"] == "scored"]
        scored.sort(key=lambda r: (-r["awareness_score"], -r["_sub_raw"]))
        for i, r in enumerate(scored, start=1):
            r["category_rank"] = i

    for r in rows:
        r.pop("_sub_raw", None)
    return rows


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_GROUPS_SQL = (
    "SELECT key, group_model FROM groups WHERE is_active=1"
)

# 그룹별 최신 신호 — 이번 스냅샷의 agg_summary 행(_recompute_health_scores 와
# 동일 패턴: WHERE snapshot_at=?). agg_awareness 는 agg_summary 파생이므로 같은
# 스냅샷을 읽는다.
_AGG_SQL = (
    "SELECT group_key, yt_subscribers, yt_total_views, naver_total_news "
    "FROM agg_summary WHERE snapshot_at = ?"
)

# 스냅샷별 멱등 쓰기: 같은 snapshot_at 만 지우고 다시 INSERT → 과거 스냅샷 보존
# (시계열). full-DELETE 선두.
_CLEAR_SQL = "DELETE FROM agg_awareness WHERE snapshot_at = ?"

_INSERT_SQL = """
INSERT INTO agg_awareness
  (group_key, snapshot_at, category, awareness_score, category_rank,
   sub_n, view_n, news_n, basis, generated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
""".strip()


def build_awareness(client: _Executor, *, snapshot_at: str) -> CollectionResult:
    """그룹별 최신 agg_summary + group_model → compute → 스냅샷별 멱등 쓰기.

    데뷔 전 포함(debut 게이트 없음). 이번 스냅샷에 agg_summary 행이 있는 모든
    활성 그룹을 대상으로 한다(행이 없으면 그 그룹은 신호 자체가 없어 제외). 세 신호
    전부 NULL/0 인 그룹은 insufficient row 로 적재(랭킹 제외, 카드에서 '—' 표시).
    """
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    model_by_key = {
        r["key"]: r.get("group_model") for r in client.execute(_GROUPS_SQL)
    }
    agg_by_key = {
        r["group_key"]: r
        for r in client.execute(_AGG_SQL, [snapshot_at])
    }

    groups_in = [
        {
            "key": key,
            "group_model": model_by_key.get(key),
            "yt_subscribers": agg.get("yt_subscribers"),
            "yt_total_views": agg.get("yt_total_views"),
            "naver_total_news": agg.get("naver_total_news"),
        }
        for key, agg in agg_by_key.items()
        if key in model_by_key   # 비활성/미등록 그룹의 잔여 행 무시
    ]

    rows = compute_awareness(groups_in)

    statements: list[tuple[str, list[Any]]] = [(_CLEAR_SQL, [snapshot_at])]
    for r in rows:
        statements.append((_INSERT_SQL, [
            r["group_key"], snapshot_at, r["category"],
            r["awareness_score"], r["category_rank"],
            r["sub_n"], r["view_n"], r["news_n"],
            r["basis"], now,
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
