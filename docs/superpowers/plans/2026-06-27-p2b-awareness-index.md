# P2b — 인지도 지수 (Awareness Index) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 보유 신호(구독·조회·뉴스)로 카테고리(K-POP/서브컬처)별 인지도 랭킹을 산출·저장·노출 — 신규 수집 0, 검색량은 후속 플러그인.

**Architecture:** loyalty/market_share 패턴 미러. worker(migration 0097 + analysis/awareness.py + _run_aggregate 편입)에서 산출, frontend(/api/market + MarketOverview)에서 카테고리별 노출. agg_summary 파생이라 일일 aggregate 사이클에 포함.

**Tech Stack:** Python 3.12 + pytest(uv), TypeScript + Preact + vitest, Cloudflare D1.

## Global Constraints

- **신규 수집 0**: agg_summary(yt_subscribers·yt_total_views·naver_total_news) 재가공만. 새 수집기/API 금지.
- **카테고리 분리**: K-POP(corporate) / 서브컬처(segmentary·confederation) 각각 별도 랭킹. 통합 줄세우기 금지.
- **마이그레이션 번호 0097** (0096은 P2a PR #48 선점).
- **산식**: 신호별 `log1p(v)/log1p(category_max)` (리더 대비, value≤0/None→0, category_max≤0→0) → 가중합 ×100. 가중치 `구독 0.5 / 조회 0.35 / 뉴스 0.15`(합 1.0, 모듈 상수 AWARENESS_WEIGHTS). category_rank=카테고리 내 score 내림차순(동점 subscribers tiebreak).
- **데뷔 전 포함**(Health와 달리 debut_date 게이트 없음). 신호 전무 → basis='insufficient'(score/rank NULL, 랭킹 제외).
- **점수 산식 아님**(신규 표시 지표). Health Score 불변.
- **_category_of 로컬 미러**: weekly_diagnosis_signals._category_of는 "import 금지" 명시 → awareness.py에 동일 규칙 복제(canonical 출처 주석). frontend는 기존 categoryOf 재사용.
- **테스트**: worker `cd worker && uv run python -m pytest …`(이 세션서 검증됨); frontend `cd frontend && npx vitest run …` / `npx tsc -b --noEmit`. 커밋 trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**순서**: 0097 migration → awareness.py 모듈 → cli _run_aggregate 편입 → /api/market 확장 → MarketOverview 노출.

> 설계서: `docs/superpowers/specs/2026-06-27-p2b-awareness-index-design.md`

---

### Task 1: 마이그레이션 0097_awareness.sql — agg_awareness 테이블 + idx_aw_snapshot

**Files:** /Users/user/Desktop/idol-sight/migrations/0097_awareness.sql
**Test:** `/Users/user/Desktop/idol-sight/worker/tests/unit/test_awareness.py`

**Interfaces:** 테이블 agg_awareness(group_key TEXT NOT NULL, snapshot_at TEXT NOT NULL, category TEXT, awareness_score REAL, category_rank INTEGER, sub_n REAL, view_n REAL, news_n REAL, basis TEXT NOT NULL, generated_at TEXT NOT NULL, PRIMARY KEY(group_key,snapshot_at)) + INDEX idx_aw_snapshot(snapshot_at). build_awareness 의 INSERT 컬럼 순서와 1:1 일치.

**Notes:** 번호 0097 확정(0095 최신, 0096=P2a 선점, 0096/0097 둘 다 현재 디렉터리에 미존재 확인). 마이그레이션은 repo 루트 /migrations (worker/migrations 없음). 0084_fan_loyalty.sql DDL 컨벤션(IF NOT EXISTS·컬럼 정렬·한글 주석·basis TEXT NOT NULL) 미러. _apply_all()이 0096 부재여도 정렬 글롭으로 ...0095→0097 순서 적용되어 무해(테이블 간 의존 없음) — 실측 검증 완료.

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/worker/tests/unit/test_awareness.py`)

```
# (test_awareness.py 의 migration 섹션 — _apply_all 미러)
import sqlite3
from pathlib import Path
import pytest

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"

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
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && source .venv/bin/activate && rtk proxy python -m pytest tests/unit/test_awareness.py -q -k migration
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
-- 0097_awareness.sql — P2b: 인지도 지수 (Awareness Index).
--
-- 동기:
--   "버추얼 아이돌 인지도 순위" 요청에 직접 답하는 신규 표시 지표. 신규 수집 0 —
--   agg_summary 의 그룹별 최신 신호(구독·조회·뉴스)를 카테고리(K-POP/서브컬처)
--   리더 대비 log1p 정규화·가중(0.5/0.35/0.15)해 0~100 점수화하고, 카테고리별로
--   분리 랭킹한다. Health Score 와 독립된 1차원 지표(Health Reach 와 입력은
--   겹치나 목적이 다름) — 점수 산식 변경이 아니라 신규 표시 지표.
--
--   agg_awareness — 그룹·스냅샷별 1행, build_awareness 가 스냅샷별 멱등 쓰기
--   (DELETE FROM agg_awareness WHERE snapshot_at=? 후 INSERT). 과거 스냅샷은
--   보존해 인지도 시계열을 남긴다.

CREATE TABLE IF NOT EXISTS agg_awareness (
  group_key       TEXT NOT NULL,
  snapshot_at     TEXT NOT NULL,
  category        TEXT,             -- 'kpop' | 'subculture' (_category_of)
  awareness_score REAL,            -- 0~100, basis='insufficient' 면 NULL
  category_rank   INTEGER,          -- 카테고리 내 score 내림차순 순위(1=최고), insufficient 면 NULL
  sub_n           REAL,             -- 구독 정규화값 (log1p, 카테고리 리더 대비 0~1)
  view_n          REAL,             -- 조회 정규화값
  news_n          REAL,             -- 뉴스 정규화값
  basis           TEXT NOT NULL,    -- 'scored' | 'insufficient'
  generated_at    TEXT NOT NULL,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_aw_snapshot ON agg_awareness (snapshot_at);
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && source .venv/bin/activate && rtk proxy python -m pytest tests/unit/test_awareness.py -q -k migration
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2b): 마이그레이션 0097_awareness.sql — agg_awareness 테이블 + idx_aw_snapshot" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: analysis/awareness.py — compute_awareness(순수) + build_awareness(D1) + AWARENESS_WEIGHTS + _category_of/_normalize_log 미러

**Files:** /Users/user/Desktop/idol-sight/worker/src/idol_sight/analysis/awareness.py
**Test:** `/Users/user/Desktop/idol-sight/worker/tests/unit/test_awareness.py`

**Interfaces:** compute_awareness(groups: list[dict]) -> list[dict]. 입력 키: key, group_model, yt_subscribers, yt_total_views, naver_total_news. 출력 키: group_key, category('kpop'|'subculture'), awareness_score(float|None, 0~100, round1), category_rank(int|None, 1=최고), sub_n/view_n/news_n(float 0~1), basis('scored'|'insufficient'). | build_awareness(client, *, snapshot_at: str) -> CollectionResult. 읽기: `SELECT key, group_model FROM groups WHERE is_active=1` + `SELECT group_key, yt_subscribers, yt_total_views, naver_total_news FROM agg_summary WHERE snapshot_at=?`. statements = [(DELETE FROM agg_awareness WHERE snapshot_at=?, [snapshot_at])] + INSERT×N(컬럼 순서: group_key, snapshot_at, category, awareness_score, category_rank, sub_n, view_n, news_n, basis, generated_at). | AWARENESS_WEIGHTS = {sub:0.5, view:0.35, news:0.15} (모듈 상단 상수, 합=1.0 assert).

**Notes:** 산식 변경 아님(설계서 대원칙) — 신규 표시 지표. ⚠️ _category_of 는 import가 아니라 로컬 미러: weekly_diagnosis_signals.py docstring이 '다른 파일에서 import 금지' 명시(인터페이스 좁게 유지) → frontend categoryOf와 동일하게 awareness.py에 규칙 복제, 주석으로 canonical 3곳(worker signals/이 모듈/frontend) 동기화 명시. _normalize_log 도 health_score 미러(import 대신 복제 — 분석 모듈은 self-contained 패턴, loyalty/market_share 와 동일). [파이프라인 편입 — 별도 task 아니나 후속 worker 작업]: cli.py `_run_aggregate`에서 agg_summary 산정 직후, build_fan_loyalty 옆/health_scores 앞에 `from idol_sight.analysis.awareness import build_awareness; aw = build_awareness(client, snapshot_at=snap)` 추가 후 `client.batch(aw.statements)` + 부분쓰기 가드(`bs.statements_executed != bs.statements_sent` → Exit). loyalty처럼 try/except graceful(0097 미적용 시 aggregate 전체 죽지 않게) 권장. ruff clean 확인.

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/worker/tests/unit/test_awareness.py`)

```
# (test_awareness.py 의 compute + build 섹션 발췌 — 전체는 task 3)
import math
import pytest
from idol_sight.analysis.awareness import (
    AWARENESS_WEIGHTS, build_awareness, compute_awareness,
)

def _by_key(rows):
    return {r["group_key"]: r for r in rows}

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
    assert plave["awareness_score"] == pytest.approx(100.0)
    assert out["skinz"]["sub_n"] == pytest.approx(
        math.log1p(100_000) / math.log1p(1_000_000))

def test_compute_weighting_sub_only_is_half():
    out = _by_key(compute_awareness([
        {"key": "lead", "group_model": "corporate",
         "yt_subscribers": 500, "yt_total_views": 0, "naver_total_news": 0}]))
    assert out["lead"]["awareness_score"] == pytest.approx(
        AWARENESS_WEIGHTS["sub"] * 100.0)

def test_compute_tiebreak_by_subscribers_descending():
    groups = [
        {"key": "lead", "group_model": "segmentary",
         "yt_subscribers": 10_000, "yt_total_views": 10_000, "naver_total_news": 2000},
        {"key": "hi", "group_model": "segmentary",
         "yt_subscribers": 5000, "yt_total_views": 0, "naver_total_news": 0},
        {"key": "lo", "group_model": "segmentary",
         "yt_subscribers": 4980, "yt_total_views": 0, "naver_total_news": 0},
    ]
    out = _by_key(compute_awareness(groups))
    assert out["hi"]["awareness_score"] == out["lo"]["awareness_score"] == 46.2
    assert out["hi"]["category_rank"] == 2 and out["lo"]["category_rank"] == 3

# + test_compute_uses_log1p_normalization / category_max_zero_guard /
#   null_and_negative_coerced / insufficient / category_separation /
#   includes_pre_debut + build _FakeClient(delete 선두·category·rank·idempotent·insufficient)
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && source .venv/bin/activate && rtk proxy python -m pytest tests/unit/test_awareness.py -q
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
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
    None), ``category_rank`` (int 또는 None), ``sub_n``/``view_n``/``news_n``
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
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && source .venv/bin/activate && rtk proxy python -m pytest tests/unit/test_awareness.py -q
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2b): analysis/awareness.py — compute_awareness(순수) + build_awareness(D1) + AWARENESS_WEIGHTS + _category_of/_normalize_log 미러" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: test_awareness.py — compute 순수 + build _FakeClient + migration (test_loyalty/test_live_chat_migration 컨벤션 미러, 15 tests)

**Files:** /Users/user/Desktop/idol-sight/worker/tests/unit/test_awareness.py
**Test:** `/Users/user/Desktop/idol-sight/worker/tests/unit/test_awareness.py`

**Interfaces:** 테스트가 검증하는 계약: compute_awareness 출력 dict 키(group_key/category/awareness_score/category_rank/sub_n/view_n/news_n/basis) + 리더=1.0·가중 0.5/0.35/0.15·카테고리 분리 독립 순위·subscribers tiebreak·log1p·category_max=0 가드·NULL/음수→0·데뷔전 포함·insufficient(score/rank None). build statements: [0]=DELETE(snapshot_at scoped), [1:]=INSERT params 인덱스[0]group_key [1]snapshot_at [2]category [3]score [4]rank [8]basis [9]generated_at. migration: 테이블·10컬럼·idx_aw_snapshot·복합 PK(group_key,snapshot_at).

**Notes:** test_loyalty.py 미러: pytest + 작은 순수 테스트 다수 + _FakeClient(execute SQL 키워드 분기) + statements[0] DELETE 검사 + params 인덱스 주석. test_live_chat_migration.py 미러: MIGRATIONS_DIR=parents[3]/'migrations', _apply_all() 전체 *.sql executescript, PRAGMA table_info 검사. tiebreak 숫자(5000/4980 → 둘 다 46.2)는 사전 계산으로 동점 보장 후 실측 확인. ⚠️ 실행은 반드시 `rtk proxy python -m pytest` — rtk 훅이 일반 pytest 출력을 가로채 'No tests collected' 로 오표시(실제 통과). idempotent 테스트는 generated_at(params[9]) 제외 후 비교(시각 의존).

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/worker/tests/unit/test_awareness.py`)

```
# 이 task 의 산출물 자체가 테스트 파일이다 (target_code == 전체 test_awareness.py).
# 실행 결과: 15 passed in 0.12s (compute 9 + build 4 + migration 2). ruff clean.
# 관련 스위트 회귀 없음: test_loyalty + test_agg_summary + test_live_chat_migration
# + test_awareness = 41 passed.
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && source .venv/bin/activate && rtk proxy python -m pytest tests/unit/test_awareness.py -v
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
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
    assert skinz["sub_n"] == pytest.approx(
        math.log1p(100_000) / math.log1p(1_000_000))
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


def test_compute_uses_log1p_normalization():
    groups = [
        {"key": "lead", "group_model": "corporate",
         "yt_subscribers": 1_000_000, "yt_total_views": 0, "naver_total_news": 0},
        {"key": "mid", "group_model": "corporate",
         "yt_subscribers": 1000, "yt_total_views": 0, "naver_total_news": 0},
    ]
    out = _by_key(compute_awareness(groups))
    expected = math.log1p(1000) / math.log1p(1_000_000)
    assert out["mid"]["sub_n"] == pytest.approx(expected)
    assert expected > 0.4


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
    assert nully["news_n"] == pytest.approx(math.log1p(50) / math.log1p(100))
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
         "yt_subscribers": 4980, "yt_total_views": 0, "naver_total_news": 0},
    ]
    out = _by_key(compute_awareness(groups))
    assert out["hi"]["awareness_score"] == out["lo"]["awareness_score"] == 46.2
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
            {"group_key": "plave", "yt_subscribers": 1_000_000,
             "yt_total_views": 160_000_000, "naver_total_news": 300},
            {"group_key": "skinz", "yt_subscribers": 100_000,
             "yt_total_views": 10_000_000, "naver_total_news": 20},
            {"group_key": "isedol", "yt_subscribers": 8_000_000,
             "yt_total_views": 1_200_000_000, "naver_total_news": 50},
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
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && source .venv/bin/activate && rtk proxy python -m pytest tests/unit/test_awareness.py -v
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2b): test_awareness.py — compute 순수 + build _FakeClient + migration (test_loyalty/test_live_chat_migration 컨벤션 미러, 15 tests)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: build_awareness 를 _run_aggregate always-run 구간(health_scores 직전)에 편입 + 독립 build-awareness 커맨드 추가

**Files:** /Users/user/Desktop/idol-sight/worker/src/idol_sight/cli.py
**Test:** `/Users/user/Desktop/idol-sight/worker/tests/unit/test_cli_aggregate.py`

**Interfaces:** 소비(cli.py가 호출): build_awareness(client, *, snapshot_at: str) -> CollectionResult — snapshot_at 키워드 인자는 _run_aggregate 의 snap 변수(=316 `snapshot_at or datetime.now(UTC).strftime('%Y-%m-%dT%H:00:00Z')`). 워커 awareness.py:186 실제 시그니처 `def build_awareness(client: _Executor, *, snapshot_at: str) -> CollectionResult` 와 정확히 일치(검증됨). CollectionResult.statements: list[tuple[str, list[Any]]] 를 client.batch() 에 전달, 결과 bs.statements_executed/bs.statements_sent 로 부분쓰기 판정. 신규 커맨드 노출: `idol-sight build-awareness [--snapshot-at TS]` (기본=최신 agg_summary 스냅샷).

**Notes:** 검증 완료: test_cli_aggregate.py 전체 10 passed (기존 6 + 신규 4). 병렬 워커 에이전트가 worker/src/idol_sight/analysis/awareness.py(9.2K)를 이미 생성해 시그니처 일치 확인됨.

설계서 vs 코드 불일치 발견·반영: 프롬프트/설계서는 '_run_aggregate 5단계 ...→health_scores→market_share' 라 했으나 실제 코드의 market_share 는 _run_aggregate 에 없고 analyze-weekly(cli.py:1219)에만 존재. 따라서 'market_share 옆' 대신 health_scores(=_recompute_health_scores, always-run) 직전에 배치. awareness 는 agg_summary 파생이라 skip_derived 와 무관하게 always-run(2nd 샌드위치 aggregate 도 갱신) — 의도적 결정.

 graceful 가드 차이점: fan_loyalty(0095)는 build(읽기)가 실패점이라 build 만 try 로 감쌈. awareness 는 새 테이블 agg_awareness(0097) 쓰기(batch)가 실패점이고 점진 롤아웃 중 모듈 부재 가능성도 있어 import+build+batch 를 한 try 로 감싸되 `except typer.Exit: raise` 로 부분쓰기 하드실패(Exit 1)는 보존. 이 덕에 awareness.py 가 없던 시점에도 기존 6 테스트가 graceful import 실패로 green 유지됨(확인).

마이그레이션 번호 0097 은 cli.py 주석에만 참조(테이블 생성은 마이그레이션 담당 에이전트 몫). 0096=P2a 선점 준수.

SOV/market_share 점수 산식 미변경(원칙 준수) — awareness 는 독립 표시 지표로만 추가.

수동검증 절차(awareness.py 통합 후): 위 run_command. 추가로 `cd worker && .venv/bin/python -m idol_sight.cli build-awareness --help` 로 커맨드 등록 확인 가능.

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/worker/tests/unit/test_cli_aggregate.py`)

```
# ===== 변경 1: import 블록(파일 상단 `from unittest.mock import MagicMock, patch` 아래)에 추가 =====
import pytest
import typer

# (기존: from idol_sight.cli import _recompute_health_scores, _run_aggregate)


# ===== 변경 2: 파일 끝(test_skip_derived_skips_debut_window_stages 뒤)에 4개 테스트 추가 =====
# 기존 헬퍼 _stub_build_result / _make_client / 데코레이터 컨벤션 미러.

# ---------------------------------------------------------------------------
# P2b: 인지도 지수(Awareness Index) — agg_summary 파생, always-run, graceful 가드.
# ---------------------------------------------------------------------------


@patch("idol_sight.cli._recompute_health_scores", return_value=9)
@patch("idol_sight.analysis.platform_reactivity.compute_reactivity")
@patch("idol_sight.analysis.video_velocity.compute_velocity")
@patch("idol_sight.analysis.group_combined.build_agg_group_combined")
@patch("idol_sight.analysis.agg_summary.build_agg_summary")
@patch("idol_sight.analysis.awareness.build_awareness")
def test_default_runs_awareness(
    mock_awareness, mock_summary, mock_combined, mock_velocity,
    mock_reactivity, mock_health,
):
    """awareness is built on the default daily aggregate, keyed at the same
    snapshot as agg_summary (it's an agg_summary derivative). The keyword arg
    mirrors the worker signature build_awareness(client, *, snapshot_at)."""
    mock_summary.return_value = _stub_build_result()
    mock_combined.return_value = _stub_build_result()
    mock_velocity.return_value = _stub_build_result()
    mock_reactivity.return_value = []
    mock_awareness.return_value = _stub_build_result()
    client = _make_client()

    _run_aggregate(client, snap="2026-05-12T00:00:00Z")

    mock_awareness.assert_called_once_with(client, snapshot_at="2026-05-12T00:00:00Z")


@patch("idol_sight.cli._recompute_health_scores", return_value=9)
@patch("idol_sight.analysis.agg_summary.build_agg_summary")
@patch("idol_sight.analysis.awareness.build_awareness")
def test_skip_derived_still_runs_awareness(
    mock_awareness, mock_summary, mock_health,
):
    """awareness lives in the always-run section (alongside health_scores), so
    the skip-derived 2nd aggregate in the melon-chart sandwich still refreshes
    it — unlike combined/velocity/reactivity which are skipped."""
    mock_summary.return_value = _stub_build_result()
    mock_awareness.return_value = _stub_build_result()
    client = _make_client()

    _run_aggregate(client, snap="2026-05-12T00:00:00Z", skip_derived=True)

    mock_awareness.assert_called_once_with(client, snapshot_at="2026-05-12T00:00:00Z")
    mock_health.assert_called_once_with(client, "2026-05-12T00:00:00Z")


@patch("idol_sight.cli._recompute_health_scores", return_value=9)
@patch("idol_sight.analysis.agg_summary.build_agg_summary")
@patch("idol_sight.analysis.awareness.build_awareness")
def test_awareness_build_failure_does_not_kill_aggregate(
    mock_awareness, mock_summary, mock_health,
):
    """Deploy↔migration graceful rule (mirrors fan_loyalty): if agg_awareness
    (0097) isn't applied yet, build/INSERT throws — but aggregate must not die,
    and the downstream _recompute_health_scores must still run."""
    mock_summary.return_value = _stub_build_result()
    mock_awareness.side_effect = RuntimeError("no such table: agg_awareness")
    client = _make_client()

    # must NOT raise
    _run_aggregate(client, snap="2026-05-12T00:00:00Z", skip_derived=True)

    mock_health.assert_called_once_with(client, "2026-05-12T00:00:00Z")


@patch("idol_sight.cli._recompute_health_scores", return_value=9)
@patch("idol_sight.analysis.agg_summary.build_agg_summary")
@patch("idol_sight.analysis.awareness.build_awareness")
def test_awareness_partial_write_hard_fails(
    mock_awareness, mock_summary, mock_health,
):
    """A genuine partial write (statements_executed != statements_sent) must
    still hard-fail with typer.Exit — the graceful except re-raises typer.Exit
    so the partial-write guard is preserved (only build/missing-table errors
    are swallowed). skip_derived isolates the batch to awareness only."""
    mock_summary.return_value = _stub_build_result()
    mock_awareness.return_value = _stub_build_result(
        [("INSERT INTO agg_awareness (...) VALUES (...)", [])]
    )
    client = _make_client()
    client.batch.return_value = MagicMock(statements_executed=0, statements_sent=1)

    with pytest.raises(typer.Exit):
        _run_aggregate(client, snap="2026-05-12T00:00:00Z", skip_derived=True)
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && .venv/bin/python -m pytest tests/unit/test_cli_aggregate.py -q
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
# ===== 변경 1: _run_aggregate 안, `else:`(skip-derived echo) 블록 직후 ·
# `# V2.19.2: refresh agg_health_scores ...` 주석(=_recompute_health_scores 호출부) 직전에 삽입 =====
# (즉 always-run 구간. skip_derived 2nd aggregate 도 갱신 — awareness 는 agg_summary 파생)

    else:
        typer.echo("skip-derived: agg_group_combined / velocity / reactivity skipped")

    # P2b: 인지도 지수(Awareness Index). agg_summary 파생(구독·조회·뉴스)이므로
    # health_scores 와 동일한 always-run 위치 — skip_derived 2nd aggregate 도
    # 갱신한다(agg_summary 가 melon COALESCE 로 재upsert 되는 샌드위치 패턴과
    # 정합). 카테고리(K-POP/서브컬처)별 분리 랭킹이며, 점수 산식 변경이 아닌
    # 신규 표시 지표다. 신규 수집 0 — agg_summary 최신 스냅샷 재가공.
    # V2.52 fan_loyalty 와 동일한 배포↔마이그레이션 graceful 규칙: 신규 테이블
    # agg_awareness(0097)가 아직 적용되지 않은 배포에서 build/INSERT throw 가
    # aggregate 전체(특히 이후의 _recompute_health_scores)를 죽이지 않도록
    # 감싼다(import 도 try 안 — P2b 점진 롤아웃 중 모듈/테이블 부재 모두 흡수).
    # 단, 부분쓰기 가드(statements_executed != statements_sent)의 typer.Exit 은
    # 재raise 해 하드 실패를 보존한다.
    try:
        from idol_sight.analysis.awareness import build_awareness
        aw = build_awareness(client, snapshot_at=snap)
        if aw.statements:
            bs = client.batch(aw.statements)
            if bs.statements_executed != bs.statements_sent:
                typer.echo(f"partial awareness write: "
                           f"{bs.statements_executed}/{bs.statements_sent}", err=True)
                raise typer.Exit(code=1)
        typer.echo(f"awareness: wrote {len(aw.statements)} rows")
    except typer.Exit:
        raise
    except Exception as exc:
        typer.echo(f"[warn] awareness skipped (build/write 실패, 0097 미적용 가능): {exc}",
                   err=True)

    # V2.19.2: refresh agg_health_scores at the same daily cadence as
    # ... (이하 기존 코드 그대로: _recompute_health_scores(client, snap))


# ===== 변경 2: _run_aggregate 함수 종료 직후, `@app.command("health-check", ...)` 직전에
# 독립 커맨드 추가 (수동 재실행/과거 스냅샷 백필용) =====

@app.command(
    "build-awareness",
    help="Rebuild agg_awareness for one snapshot (P2b 인지도 지수, standalone).",
)
def build_awareness_cmd(
    snapshot_at: str | None = typer.Option(
        None,
        "--snapshot-at",
        help=(
            "UTC timestamp like 2026-05-07T12:00:00Z. Defaults to the latest "
            "agg_summary snapshot — awareness is an agg_summary derivative, so "
            "the current UTC hour would usually miss the snapshot. Pass an "
            "explicit value to rebuild a historical snapshot (time series)."
        ),
    ),
) -> None:
    """Standalone awareness rebuild. The daily path runs it inside
    ``_run_aggregate`` (agg_summary 직후); this command is for manual reruns /
    backfilling a past snapshot without re-running the whole aggregate."""
    from idol_sight.analysis.awareness import build_awareness
    settings = load_settings()
    client = _make_d1_client(settings)
    snap = snapshot_at
    if snap is None:
        latest = client.execute("SELECT MAX(snapshot_at) AS m FROM agg_summary")
        snap = (latest[0].get("m") if latest else None)
        if not snap:
            typer.echo("no agg_summary snapshot found", err=True)
            raise typer.Exit(code=1)
    aw = build_awareness(client, snapshot_at=snap)
    if aw.statements:
        bs = client.batch(aw.statements)
        if bs.statements_executed != bs.statements_sent:
            typer.echo(f"partial awareness write: "
                       f"{bs.statements_executed}/{bs.statements_sent}", err=True)
            raise typer.Exit(code=1)
    typer.echo(f"awareness: wrote {len(aw.statements)} rows at {snap}")
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && .venv/bin/python -m pytest tests/unit/test_cli_aggregate.py -q
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2b): build_awareness 를 _run_aggregate always-run 구간(health_scores 직전)에 편입 + 독립 build-awareness 커맨드 추가" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Task 1 — /api/market 엔드포인트에 awareness {score, category_rank} 포함 (agg_awareness 최신 스냅샷 재가공, 신규 수집 0)

**Files:** /Users/user/Desktop/idol-sight/frontend/functions/api/market.ts
**Test:** `/Users/user/Desktop/idol-sight/frontend/tests/functions/api_market.test.ts`

**Interfaces:** SELECT: `SELECT group_key, awareness_score, category_rank, basis FROM agg_awareness WHERE snapshot_at=(SELECT MAX(snapshot_at) FROM agg_awareness)`. AwarenessRow 컬럼: group_key TEXT, awareness_score REAL|null, category_rank INTEGER|null, basis TEXT('scored'|'insufficient'). 엔드포인트 응답 entries shape 추가: out[key].awareness = { score: number|null, category_rank: number|null } | null. (basis='scored' → numeric; 'insufficient' → {score:null,category_rank:null}; agg_awareness 행 없음 → null).

**Notes:** agg_awareness 테이블은 P2b worker/migration 0097이 생성(이 task 범위 밖). 엔드포인트 테스트는 DB 모킹이라 마이그레이션 없이도 green. 글로벌 MAX 패턴 채택 이유: build_awareness가 한 snapshot_at에 전 그룹을 한 번에 쓰므로(설계 §5) health와 동일하게 코호트 최신 = 글로벌 MAX. 신규 수집 0(agg_summary 파생). 검색량 자리는 비움.

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/frontend/tests/functions/api_market.test.ts`)

```
// tests/functions/api_market.test.ts — 기존 envWith 컨벤션 그대로, 3개 it 추가(적용·검증 완료):

  // P2b — Awareness Index surfaced on each group.
  it("includes awareness.{score,category_rank} for scored groups", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      if (sql.includes("FROM agg_awareness"))
        return [{ group_key: "plave", awareness_score: 87.4,
                  category_rank: 1, basis: "scored" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.plave.awareness).toEqual({ score: 87.4, category_rank: 1 });
  });

  it("nulls awareness score/rank when basis=insufficient", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "wegosix", name: "WeGoSix", name_kr: "위고식스" }];
      if (sql.includes("FROM agg_awareness"))
        return [{ group_key: "wegosix", awareness_score: null,
                  category_rank: null, basis: "insufficient" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.wegosix.awareness).toEqual({ score: null, category_rank: null });
  });

  it("awareness is null when no agg_awareness row exists", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "miiwan", name: "MiiWAN", name_kr: "미완소년" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.miiwan.awareness).toBeNull();
  });
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/frontend && ./node_modules/.bin/vitest run tests/functions/api_market.test.ts
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
// 적용 완료(파일 전체 최종 형태). 핵심 4개 삽입 지점:

// (A) InsightRow 인터페이스 직후 — AwarenessRow 타입:
interface AwarenessRow {
  group_key: string; awareness_score: number | null;
  category_rank: number | null; basis: string;
}

// (B) insights 쿼리 직후 — 최신 awareness 스냅샷 조회(health MAX 패턴 미러):
const awareness = await d1Query<AwarenessRow>(env.DB,
  `SELECT group_key, awareness_score, category_rank, basis
     FROM agg_awareness
    WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_awareness)`);

// (C) healthByKey 빌드 직후 — awarenessByKey 맵:
const awarenessByKey: Record<string, AwarenessRow> = {};
for (const a of awareness) awarenessByKey[a.group_key] = a;

// (D) 그룹 루프 내 const p 다음 + out[g.key]의 health_score 직후:
const aw = awarenessByKey[g.key];
// ...
      awareness: aw ? {
        score: aw.basis === "scored" ? aw.awareness_score : null,
        category_rank: aw.basis === "scored" ? aw.category_rank : null,
      } : null,

// 전체 결과 파일은 아래와 동일하게 합쳐진 상태로 저장됨(검증 완료):
//  - import d1Query/jsonResponse → GroupRow/SummaryRow/HealthRow/InsightRow/AwarenessRow
//  - groups/sums/fillRows/prevSums/healths/insights/awareness 순차 쿼리
//  - sumByKey/prevSumByKey/healthByKey/awarenessByKey 맵
//  - for(g of groups) out[g.key] = { name,name_kr,debut_date,group_model,summary,prev_summary,health_score,awareness }
//  - return jsonResponse({ generated_at, groups: out, market_insights })
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/frontend && ./node_modules/.bin/vitest run tests/functions/api_market.test.ts
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2b): Task 1 — /api/market 엔드포인트에 awareness {score, category_rank} 포함 (agg_awareness 최신 스냅샷 재가공, 신규 수집 0)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Task 2 — MarketOverview.tsx: 카드에 인지도 점수·카테고리 순위 표시 + 인지도순 정렬 토글 + insufficient/null '—' 처리

**Files:** /Users/user/Desktop/idol-sight/frontend/src/views/MarketOverview.tsx
**Test:** `/Users/user/Desktop/idol-sight/frontend/src/views/MarketOverview.test.ts`

**Interfaces:** 소비하는 entries shape: g.awareness = { score: number|null, category_rank: number|null } | null (Task1 엔드포인트가 생산). export 헬퍼 시그니처: `fmtAwareness(score: number|null|undefined): string`(null→'—'), `sortByAwareness(entries: Array<[string, any]>): Array<[string, any]>`(category_rank ASC, null 후순위, name tiebreak — sortByRank와 동일 튜플 시그니처). state: `sortMode: 'health'|'awareness'`. UI: 카드마다 인지도 점수+`#{category_rank}` 배지(score null이면 '—', 배지 숨김), 정렬 토글(등급순↔인지도순).

**Notes:** 렌더 단위 테스트는 vitest env=node(DOM 없음, vite.config.ts test.environment='node')라 불가 → 설계 §7 '가능 범위'를 export 순수 헬퍼(fmtAwareness/sortByAwareness)로 충족(FanLoyaltyCard 선례 동일). chart.js/auto+MarketOverview 모듈 node import는 probe로 정상 확인. 점수 산식 미변경(표시 전용). 검색량 자리=카피 '검색량은 추후'로만 비워 둠. 카테고리 분리는 기존 categoryOf 섹션 그대로 유지(통합 랭킹 금지). 카드 `#{i+1}` 칩은 활성 정렬(등급/인지도)을 반영하고, 인지도 배지는 worker가 매긴 카테고리 정식 순위를 항상 별도 표기. 검증: 프런트 전체 292 tests pass(신규 10), tsc clean.

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/frontend/src/views/MarketOverview.test.ts`)

```
// src/views/MarketOverview.test.ts (신규, FanLoyaltyCard.test.ts 컨벤션 미러 — 적용·검증 완료):
import { describe, it, expect } from "vitest";
import { fmtAwareness, sortByAwareness } from "./MarketOverview";

const g = (name: string, rank: number | null, score: number | null = rank) =>
  [name.toLowerCase(), { name, awareness: { score, category_rank: rank } }] as [string, any];

describe("fmtAwareness", () => {
  it("점수를 문자열로, null/undefined 는 '—'", () => {
    expect(fmtAwareness(87.4)).toBe("87.4");
    expect(fmtAwareness(0)).toBe("0");           // 0 점도 표시(falsy 가드)
    expect(fmtAwareness(null)).toBe("—");        // basis=insufficient
    expect(fmtAwareness(undefined)).toBe("—");   // awareness 행 없음
  });
});

describe("sortByAwareness", () => {
  it("category_rank 오름차순(1=최상위)", () => {
    const sorted = sortByAwareness([g("B", 2), g("A", 1), g("C", 3)]);
    expect(sorted.map(([k]) => k)).toEqual(["a", "b", "c"]);
  });
  it("순위 없는 그룹(insufficient/무행)은 맨 뒤로, 그다음 이름순", () => {
    const sorted = sortByAwareness([g("Zeta", null), g("Alpha", null), g("Ranked", 1)]);
    expect(sorted.map(([k]) => k)).toEqual(["ranked", "alpha", "zeta"]);
  });
  it("awareness 객체 자체가 없어도(=null) 안전하게 뒤로", () => {
    const noAw = ["nope", { name: "Nope" }] as [string, any];
    const sorted = sortByAwareness([noAw, g("Ranked", 2)]);
    expect(sorted.map(([k]) => k)).toEqual(["ranked", "nope"]);
  });
  it("입력 배열을 변형하지 않는다(순수)", () => {
    const input = [g("B", 2), g("A", 1)];
    const before = input.map(([k]) => k);
    sortByAwareness(input);
    expect(input.map(([k]) => k)).toEqual(before);
  });
});
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/frontend && ./node_modules/.bin/vitest run src/views/MarketOverview.test.ts && ./node_modules/.bin/tsc -b --noEmit
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
// 적용 완료. 삽입/수정 5개 지점:

// (A) sortByRank 직후 — export 순수 헬퍼(단위 테스트 대상):
export interface Awareness { score: number | null; category_rank: number | null; }

// '—' when basis=insufficient (null score) or no agg_awareness row.
export function fmtAwareness(score: number | null | undefined): string {
  return score == null ? "—" : String(score);
}

// Sort by category_rank ASC (1 = 가장 잘 알려짐). 순위 없는 그룹은 맨 뒤로→name.
export function sortByAwareness(
  entries: Array<[string, any]>,
): Array<[string, any]> {
  return [...entries].sort(([, ga], [, gb]) => {
    const ra = ga.awareness?.category_rank;
    const rb = gb.awareness?.category_rank;
    const aHas = ra != null;
    const bHas = rb != null;
    if (aHas && bHas && ra !== rb) return ra - rb;
    if (aHas !== bHas) return aHas ? -1 : 1;
    return (ga.name ?? "").localeCompare(gb.name ?? "");
  });
}

// (B) activeCategory state 직후 — 정렬 모드 state:
const [sortMode, setSortMode] = useState<"health" | "awareness">("health");

// (C) sectioned useMemo 내 정렬부 교체 + deps에 sortMode 추가:
    const sorter = (e: Array<[string, any]>) =>
      sortMode === "awareness" ? sortByAwareness(e) : sortByRank(e, sharesByKey);
    return { kpop: sorter(kpop), subculture: sorter(sub) };
  }, [market, sharesByKey, sortMode]);

// (D) 코호트 필터 div 직후 — 정렬 토글 + 인지도 카피(평이):
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="text-zinc-500">정렬</span>
        {([
          { key: "health" as const,    label: "등급순" },
          { key: "awareness" as const, label: "인지도순" },
        ]).map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSortMode(s.key)}
            class={"rounded-md border px-3 py-1 text-xs transition-colors " +
              (sortMode === s.key
                ? "border-sky-500 bg-sky-500/10 text-sky-300"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
          >{s.label}</button>
        ))}
        <span class="text-hint text-zinc-500">
          인지도 = 얼마나 알려졌나 (구독·조회·언론 종합 · 검색량은 추후)
        </span>
      </div>

// (E) 카드 내 grade/total 블록 직후, DebutWindowKPI 직전 — 인지도 한 줄:
                    <div class="mt-1 flex items-center gap-1.5 text-hint">
                      <span class="text-zinc-500">인지도</span>
                      {g.awareness?.score != null ? (
                        <>
                          <span class="font-semibold tabular-nums text-sky-300">
                            {fmtAwareness(g.awareness.score)}
                          </span>
                          {g.awareness.category_rank != null && (
                            <span class="rounded-chip border border-sky-500/40 px-1 tabular-nums text-sky-400">
                              #{g.awareness.category_rank}
                            </span>
                          )}
                        </>
                      ) : (
                        <span class="text-zinc-600" title="신호 부족 — 인지도 산정 제외">—</span>
                      )}
                    </div>
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/frontend && ./node_modules/.bin/vitest run src/views/MarketOverview.test.ts && ./node_modules/.bin/tsc -b --noEmit
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2b): Task 2 — MarketOverview.tsx: 카드에 인지도 점수·카테고리 순위 표시 + 인지도순 정렬 토글 + insufficient/null '—' 처리" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

