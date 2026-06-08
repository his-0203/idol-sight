# 라이브 CCV 기반 팬 충성도 점수화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 라이브 CCV/구독자 전환율로 팬 충성도를 점수화하여 각 그룹 상세페이지 카드 + Health Score Intimacy에 반영하고, CCV 추적을 corporate 8개 그룹으로 확대한다.

**Architecture:** worker 순수함수 모듈(`analysis/loyalty.py`)이 `live_ccv_samples` + `agg_summary.yt_subscribers`로 전환율·점수·증감율을 계산해 `agg_fan_loyalty`(그룹당 1행, full rebuild)에 적재. `_recompute_health_scores`가 이 점수를 읽어 Intimacy factor에 주입(데이터 결측 시 기존 2신호로 graceful fallback). Pages Function이 `group/[key]` 응답에 `fan_loyalty`를 실어 상세페이지 `FanLoyaltyCard`가 렌더.

**Tech Stack:** Python 3.12 (uv, pytest), Cloudflare D1 (SQL migration), Preact + Vite (vitest, TypeScript), Pages Functions.

**선행 스펙:** `docs/superpowers/specs/2026-06-08-fan-loyalty-ccv-scoring-design.md`

---

### Task 1: migration 0084 — 추적 확대 + 충성도 테이블

**Files:**
- Create: `migrations/0084_fan_loyalty.sql`

- [ ] **Step 1: migration 파일 작성**

```sql
-- V2.46: 라이브 CCV 기반 팬 충성도 점수화.
-- (1) ccv_tracked 확대 — corporate 8개 전부 (segmentary 제외).
-- (2) agg_fan_loyalty — 그룹당 1행, build_fan_loyalty가 full DELETE+rebuild.

UPDATE groups SET ccv_tracked=1 WHERE key IN ('skinz','myrakl','bdawn','bthd');

CREATE TABLE IF NOT EXISTS agg_fan_loyalty (
  group_key        TEXT NOT NULL PRIMARY KEY REFERENCES groups(key),
  conversion_rate  REAL,            -- median peak CCV / subscribers (0~1)
  peak_ccv_median  REAL,            -- 윈도우 내 방송별 peak CCV 의 중앙값
  broadcast_count  INTEGER NOT NULL DEFAULT 0,
  subscribers      INTEGER,         -- 산정 시점 분모 (감사용)
  score            REAL,            -- 0~100, basis=insufficient 면 NULL
  basis            TEXT NOT NULL,   -- 'scored' | 'low_confidence' | 'insufficient'
  ccv_trend_pct    REAL,            -- 전반부→후반부 median peak 변화율 (표시용)
  trend_basis      TEXT NOT NULL DEFAULT 'unknown',  -- 'rising'|'falling'|'flat'|'unknown'
  window_days      INTEGER NOT NULL DEFAULT 56,
  snapshot_at      TEXT NOT NULL
);
```

- [ ] **Step 2: 로컬 적용 검증**

Run: `cd frontend && wrangler d1 migrations apply idol-sight --local`
Expected: 0084 적용 성공, 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add migrations/0084_fan_loyalty.sql
git commit -m "feat(ccv): migration 0084 — ccv_tracked 확대 + agg_fan_loyalty 테이블"
```

> ⚠️ **원격 apply는 운영자 직접 실행** (D1 원격 변경 human-gated). push 후 운영자가 `gh workflow run migrate.yml` 실행.

---

### Task 2: 충성도 순수함수 (`analysis/loyalty.py`)

median / 점수보간 / 증감율을 순수함수로 분해. organicity/growth 패턴 — DB 무관 함수부터 TDD.

**Files:**
- Create: `worker/src/idol_sight/analysis/loyalty.py`
- Test: `worker/tests/unit/test_loyalty.py`

- [ ] **Step 1: 실패하는 테스트 작성**

```python
# worker/tests/unit/test_loyalty.py
import pytest
from idol_sight.analysis.loyalty import (
    median, score_from_conversion, ccv_trend, compute_loyalty,
    WINDOW_DAYS, TREND_FLAT_BAND, MIN_BROADCASTS_FOR_TREND,
)


def test_median_odd_even():
    assert median([5.0]) == 5.0
    assert median([3.0, 1.0, 2.0]) == 2.0          # 정렬 후 중앙
    assert median([1.0, 2.0, 3.0, 4.0]) == 2.5     # 짝수 = 평균


def test_score_from_conversion_anchors_and_clamps():
    assert score_from_conversion(0.001) == 20.0    # <0.5% 하한 클램프
    assert score_from_conversion(0.005) == 20.0
    assert score_from_conversion(0.015) == 50.0
    assert score_from_conversion(0.03) == 70.0
    assert score_from_conversion(0.06) == 88.0
    assert score_from_conversion(0.20) == 100.0    # 상한 클램프


def test_score_from_conversion_interpolates():
    # 0.5%~1.5% 구간 중간(1.0%) → 20~50 의 중간 = 35
    assert score_from_conversion(0.01) == pytest.approx(35.0)
    # 3%~6% 구간 중간(4.5%) → 70~88 의 중간 = 79
    assert score_from_conversion(0.045) == pytest.approx(79.0)


def test_ccv_trend_needs_four_broadcasts():
    pct, basis = ccv_trend([100.0, 100.0, 100.0])  # 3개 < 4
    assert pct is None and basis == "unknown"


def test_ccv_trend_rising_falling_flat():
    # 전반 [100,100] median 100, 후반 [200,200] median 200 → +100%
    pct, basis = ccv_trend([100.0, 100.0, 200.0, 200.0])
    assert pct == pytest.approx(1.0) and basis == "rising"
    pct, basis = ccv_trend([200.0, 200.0, 100.0, 100.0])
    assert pct == pytest.approx(-0.5) and basis == "falling"
    # 변화율 < flat band(10%) → flat
    pct, basis = ccv_trend([100.0, 100.0, 105.0, 105.0])
    assert basis == "flat"


def test_compute_loyalty_scored():
    # 2개 방송, peak 1000/2000 (median 1500), 구독자 100k → 1.5% → 50점
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 800},
        {"video_id": "a", "sampled_at": "2026-06-01T10:30:00Z", "concurrent_viewers": 1000},
        {"video_id": "b", "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 2000},
    ]
    out = compute_loyalty(samples, subscribers=100_000)
    assert out["broadcast_count"] == 2
    assert out["peak_ccv_median"] == 1500.0
    assert out["conversion_rate"] == pytest.approx(0.015)
    assert out["score"] == pytest.approx(50.0)
    assert out["basis"] == "scored"


def test_compute_loyalty_low_confidence_single_broadcast():
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 3000},
    ]
    out = compute_loyalty(samples, subscribers=100_000)
    assert out["broadcast_count"] == 1
    assert out["basis"] == "low_confidence"
    assert out["score"] is not None


def test_compute_loyalty_insufficient_no_broadcast():
    out = compute_loyalty([], subscribers=100_000)
    assert out["basis"] == "insufficient"
    assert out["score"] is None
    assert out["broadcast_count"] == 0


def test_compute_loyalty_insufficient_bad_subscribers():
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 3000},
    ]
    assert compute_loyalty(samples, subscribers=0)["basis"] == "insufficient"
    assert compute_loyalty(samples, subscribers=None)["basis"] == "insufficient"
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_loyalty.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'idol_sight.analysis.loyalty'`

- [ ] **Step 3: 모듈 구현**

```python
# worker/src/idol_sight/analysis/loyalty.py
"""Fan loyalty scoring (V2.46) from live CCV concurrency.

CCV 절대값은 규모 신호. 충성도 = median peak CCV / subscribers (전환율) —
규모와 직교. 고정 벤치마크 임계값(first-pass), 라이브 데이터로 보정 예정.
Heuristic, not ground-truth.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult

__all__ = [
    "median",
    "score_from_conversion",
    "ccv_trend",
    "compute_loyalty",
    "build_fan_loyalty",
    "WINDOW_DAYS",
    "LOYALTY_ANCHORS",
    "TREND_FLAT_BAND",
    "MIN_BROADCASTS_FOR_TREND",
]

WINDOW_DAYS = 56

# (전환율, 점수) 앵커. 구간 선형보간 + 양끝 클램프. FIRST-PASS — 라이브 CCV
# 분포 축적 후 실측으로 보정한다. 버추얼 아이돌 라이브 전환율 가설:
# <0.5% 매우낮음 / 1.5% 보통 진입 / 6%+ 매우높음.
LOYALTY_ANCHORS: list[tuple[float, float]] = [
    (0.005, 20.0),
    (0.015, 50.0),
    (0.03, 70.0),
    (0.06, 88.0),
    (0.12, 100.0),
]

TREND_FLAT_BAND = 0.10          # |증감율| < 10% → flat
MIN_BROADCASTS_FOR_TREND = 4    # 전·후 각 2개 미만이면 추세 보류


def median(values: list[float]) -> float:
    """Median of a non-empty list. Even length → mean of two middles."""
    s = sorted(values)
    n = len(s)
    mid = n // 2
    if n % 2:
        return float(s[mid])
    return (s[mid - 1] + s[mid]) / 2.0


def score_from_conversion(rate: float) -> float:
    """전환율(0~1)을 LOYALTY_ANCHORS 구간 선형보간으로 0~100 점수화."""
    if rate <= LOYALTY_ANCHORS[0][0]:
        return LOYALTY_ANCHORS[0][1]
    if rate >= LOYALTY_ANCHORS[-1][0]:
        return LOYALTY_ANCHORS[-1][1]
    for (r0, s0), (r1, s1) in zip(LOYALTY_ANCHORS, LOYALTY_ANCHORS[1:]):
        if r0 <= rate <= r1:
            frac = (rate - r0) / (r1 - r0)
            return s0 + frac * (s1 - s0)
    return LOYALTY_ANCHORS[-1][1]  # unreachable, 방어


def ccv_trend(peaks_chrono: list[float]) -> tuple[float | None, str]:
    """방송별 peak CCV(시간순)를 전·후반 median 비교로 증감율 산출.

    방송 4개 미만이면 unknown(추세 보류). |증감율| < flat band → flat.
    """
    n = len(peaks_chrono)
    if n < MIN_BROADCASTS_FOR_TREND:
        return None, "unknown"
    half = n // 2
    first = median(peaks_chrono[:half])
    second = median(peaks_chrono[half:])
    if first <= 0:
        return None, "unknown"
    pct = (second - first) / first
    if abs(pct) < TREND_FLAT_BAND:
        return pct, "flat"
    return pct, ("rising" if pct > 0 else "falling")


def compute_loyalty(
    samples: list[dict[str, Any]], subscribers: int | None,
) -> dict[str, Any]:
    """그룹의 윈도우-내 CCV 샘플 + 구독자 → 충성도 row 필드 dict.

    samples: [{video_id, sampled_at, concurrent_viewers}, ...] (윈도우 사전필터됨).
    distinct video_id = distinct 방송. 방송별 peak = MAX(ccv).
    """
    base = {
        "conversion_rate": None, "peak_ccv_median": None,
        "broadcast_count": 0, "subscribers": subscribers,
        "score": None, "basis": "insufficient",
        "ccv_trend_pct": None, "trend_basis": "unknown",
    }
    # 방송별 peak + 방송 시점(최초 샘플) 집계.
    by_video: dict[str, dict[str, Any]] = {}
    for s in samples:
        vid = s["video_id"]
        ccv = float(s["concurrent_viewers"] or 0)
        at = s["sampled_at"]
        cur = by_video.get(vid)
        if cur is None:
            by_video[vid] = {"peak": ccv, "first_at": at}
        else:
            cur["peak"] = max(cur["peak"], ccv)
            cur["first_at"] = min(cur["first_at"], at)

    bc = len(by_video)
    base["broadcast_count"] = bc
    if bc == 0:
        return base
    if not subscribers or subscribers <= 0:
        return base  # insufficient — 분모 sanity (V2.43.3 동결/이상치 방어)

    peaks = [v["peak"] for v in by_video.values()]
    peak_med = median(peaks)
    rate = peak_med / subscribers
    base["peak_ccv_median"] = peak_med
    base["conversion_rate"] = rate
    base["score"] = round(score_from_conversion(rate), 2)
    base["basis"] = "low_confidence" if bc == 1 else "scored"

    # 증감율 — 방송 시점순 peak 나열 (표시용, score 미반영).
    chrono = [v["peak"] for v in sorted(by_video.values(), key=lambda x: x["first_at"])]
    pct, tbasis = ccv_trend(chrono)
    base["ccv_trend_pct"] = (round(pct, 4) if pct is not None else None)
    base["trend_basis"] = tbasis
    return base
```

(`build_fan_loyalty`는 Task 3에서 같은 파일에 추가한다.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_loyalty.py -q`
Expected: PASS (전부)

- [ ] **Step 5: 커밋**

```bash
git add worker/src/idol_sight/analysis/loyalty.py worker/tests/unit/test_loyalty.py
git commit -m "feat(loyalty): CCV 전환율 점수화 순수함수 (median/보간/증감율)"
```

---

### Task 3: `build_fan_loyalty` + aggregate 등록

**Files:**
- Modify: `worker/src/idol_sight/analysis/loyalty.py` (append)
- Modify: `worker/src/idol_sight/cli.py:413-421` 인접 (skip_derived 블록 내, growth 뒤)
- Test: `worker/tests/unit/test_loyalty.py` (append)

- [ ] **Step 1: build 실패 테스트 추가**

```python
# test_loyalty.py 에 append
from idol_sight.analysis.loyalty import build_fan_loyalty


class _FakeClient:
    """execute()는 SQL 키워드로 분기해 고정 행 반환."""
    def __init__(self, tracked, samples, subs):
        self._tracked = tracked      # [{"key":...}]
        self._samples = samples      # [{group_key, video_id, sampled_at, concurrent_viewers}]
        self._subs = subs            # [{group_key, yt_subscribers, snapshot_at}]

    def execute(self, sql, params=None):
        if "ccv_tracked" in sql:
            return self._tracked
        if "live_ccv_samples" in sql:
            return self._samples
        if "yt_subscribers" in sql:
            return self._subs
        return []


def test_build_fan_loyalty_produces_row_per_tracked_group():
    client = _FakeClient(
        tracked=[{"key": "miiwan"}, {"key": "plave"}],
        samples=[
            {"group_key": "miiwan", "video_id": "a",
             "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 1500},
            {"group_key": "miiwan", "video_id": "b",
             "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 1500},
        ],
        subs=[
            {"group_key": "miiwan", "yt_subscribers": 100_000, "snapshot_at": "2026-06-07T00:00:00Z"},
            {"group_key": "plave", "yt_subscribers": 1_000_000, "snapshot_at": "2026-06-07T00:00:00Z"},
        ],
    )
    res = build_fan_loyalty(client)
    # CLEAR 1 + 그룹 2 = 3 statements
    assert len(res.statements) == 3
    assert res.statements[0][0].strip().upper().startswith("DELETE")
    # plave 는 샘플 없음 → insufficient row 도 적재 (8그룹 카드 일관성)
    params_by_group = {st[1][0]: st[1] for st in res.statements[1:]}
    assert set(params_by_group) == {"miiwan", "plave"}


def test_build_fan_loyalty_picks_latest_nonnull_subscribers():
    client = _FakeClient(
        tracked=[{"key": "miiwan"}],
        samples=[{"group_key": "miiwan", "video_id": "a",
                  "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 1500}],
        subs=[
            {"group_key": "miiwan", "yt_subscribers": 50_000, "snapshot_at": "2026-06-01T00:00:00Z"},
            {"group_key": "miiwan", "yt_subscribers": 100_000, "snapshot_at": "2026-06-07T00:00:00Z"},
        ],
    )
    res = build_fan_loyalty(client)
    miiwan = res.statements[1][1]
    # subscribers 컬럼 위치는 INSERT 컬럼 순서대로 — 최신 100k 사용 검증은
    # conversion_rate = 1500/100000 = 0.015 로 확인 (score 50).
    # INSERT 컬럼: group_key, conversion_rate, peak_ccv_median, broadcast_count,
    #   subscribers, score, basis, ccv_trend_pct, trend_basis, window_days, snapshot_at
    assert miiwan[1] == pytest.approx(0.015)   # conversion_rate
    assert miiwan[4] == 100_000                 # subscribers
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_loyalty.py::test_build_fan_loyalty_produces_row_per_tracked_group -q`
Expected: FAIL — `cannot import name 'build_fan_loyalty'`

- [ ] **Step 3: `build_fan_loyalty` 구현 (loyalty.py append)**

```python
class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_CLEAR_SQL = "DELETE FROM agg_fan_loyalty"

_TRACKED_SQL = "SELECT key FROM groups WHERE ccv_tracked=1"

_SUBS_SQL = (
    "SELECT group_key, yt_subscribers, snapshot_at FROM agg_summary "
    "WHERE yt_subscribers IS NOT NULL"
)

_INSERT_SQL = """
INSERT INTO agg_fan_loyalty
  (group_key, conversion_rate, peak_ccv_median, broadcast_count,
   subscribers, score, basis, ccv_trend_pct, trend_basis,
   window_days, snapshot_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def build_fan_loyalty(client: _Executor) -> CollectionResult:
    """ccv_tracked 그룹별 충성도 스냅샷. full DELETE+rebuild.

    insufficient(라이브 없음/구독자 결측) 그룹도 row를 남겨 8그룹 카드가
    '데이터 축적 중'을 표시할 수 있게 한다.
    """
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff = (datetime.now(UTC) - timedelta(days=WINDOW_DAYS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )

    tracked = [r["key"] for r in client.execute(_TRACKED_SQL)]

    sample_rows = client.execute(
        "SELECT group_key, video_id, sampled_at, concurrent_viewers "
        "FROM live_ccv_samples WHERE sampled_at >= ?",
        [cutoff],
    )
    samples_by_group: dict[str, list[dict]] = {}
    for r in sample_rows:
        samples_by_group.setdefault(r["group_key"], []).append(r)

    # 그룹별 최신 non-null 구독자 (snapshot_at DESC 첫 행).
    subs_by_group: dict[str, int] = {}
    latest_at: dict[str, str] = {}
    for r in client.execute(_SUBS_SQL):
        gk, at = r["group_key"], r["snapshot_at"]
        if gk not in latest_at or at > latest_at[gk]:
            latest_at[gk] = at
            subs_by_group[gk] = r["yt_subscribers"]

    statements: list[tuple[str, list[Any]]] = [(_CLEAR_SQL, [])]
    for gk in tracked:
        out = compute_loyalty(
            samples_by_group.get(gk, []), subs_by_group.get(gk),
        )
        statements.append((_INSERT_SQL, [
            gk, out["conversion_rate"], out["peak_ccv_median"],
            out["broadcast_count"], out["subscribers"], out["score"],
            out["basis"], out["ccv_trend_pct"], out["trend_basis"],
            WINDOW_DAYS, now,
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
```

- [ ] **Step 4: build 테스트 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_loyalty.py -q`
Expected: PASS (전부)

- [ ] **Step 5: aggregate 파이프라인에 등록**

`worker/src/idol_sight/cli.py` 의 `_run_aggregate` 안, growth_trajectory 블록(`typer.echo(f"growth_trajectory: ...")` 다음 줄, line 421 직후, **여전히 `if not skip_derived:` 블록 내부**)에 추가:

```python
        # V2.46: 라이브 CCV 기반 팬 충성도. live_ccv_samples + 구독자로
        # 전환율 점수화. melon 미참조라 skip_derived 블록에 위치. health
        # score보다 먼저 실행되어 _recompute_health_scores가 읽는다.
        from idol_sight.analysis.loyalty import build_fan_loyalty
        fl = build_fan_loyalty(client)
        if fl.statements:
            bs = client.batch(fl.statements)
            if bs.statements_executed != bs.statements_sent:
                typer.echo(f"partial fan_loyalty write: "
                           f"{bs.statements_executed}/{bs.statements_sent}", err=True)
                raise typer.Exit(code=1)
        typer.echo(f"fan_loyalty: wrote {len(fl.statements)} rows")
```

- [ ] **Step 6: worker 전체 테스트**

Run: `cd worker && uv run pytest -q`
Expected: PASS (기존 + 신규 loyalty 테스트)

- [ ] **Step 7: 커밋**

```bash
git add worker/src/idol_sight/analysis/loyalty.py worker/tests/unit/test_loyalty.py worker/src/idol_sight/cli.py
git commit -m "feat(loyalty): build_fan_loyalty + aggregate 파이프라인 등록"
```

---

### Task 4: Health Score Intimacy 통합

데이터 있는 그룹만 3신호, 없으면 기존 2신호(점수 불변). `_factor_inputs`에서 분기.

**Files:**
- Modify: `worker/src/idol_sight/analysis/health_score.py:546-587` (intimacy 블록)
- Test: `worker/tests/unit/test_health_score.py` (append — 정확 경로는 grep으로 확인)

- [ ] **Step 1: 회귀 + 신규 테스트 작성**

먼저 기존 health_score 테스트 파일 경로 확인:
Run: `cd worker && ls tests/unit | grep health`
Expected: `test_health_score.py`

`test_health_score.py` 에 append (기존 import 재사용; 없으면 `from idol_sight.analysis.health_score import _factor_inputs, DEFAULT_REFS` 추가):

```python
def test_intimacy_no_loyalty_is_unchanged():
    """loyalty 키 없으면 기존 2신호(0.55/0.45) 경로 — 점수 불변."""
    agg = {
        "likes_total": 1000, "comments_total": 100, "yt_total_views": 100_000,
        "dc_total_posts": 50, "theqoo_posts": 0, "instiz_posts": 0,
        "negative_ratio": 0.0,
    }
    refs = {**DEFAULT_REFS}
    base = _factor_inputs(agg, refs)["intimacy"]
    # loyalty_score=None 명시해도 동일해야 한다.
    agg_none = {**agg, "loyalty_score": None}
    assert _factor_inputs(agg_none, refs)["intimacy"] == base


def test_intimacy_with_loyalty_blends_third_signal():
    """loyalty_score 있으면 3신호(0.40/0.30/0.30) 경로로 값이 달라진다."""
    agg = {
        "likes_total": 1000, "comments_total": 100, "yt_total_views": 100_000,
        "dc_total_posts": 50, "theqoo_posts": 0, "instiz_posts": 0,
        "negative_ratio": 0.0,
    }
    refs = {**DEFAULT_REFS}
    base = _factor_inputs(agg, refs)["intimacy"]
    high = _factor_inputs({**agg, "loyalty_score": 100.0}, refs)["intimacy"]
    low = _factor_inputs({**agg, "loyalty_score": 0.0}, refs)["intimacy"]
    assert high > base > low   # 충성도 100 가점 / 0 감점 (3신호 혼합)


def test_intimacy_loyalty_respects_compression():
    """부정 감정 압축이 loyalty 포함 intimacy에도 적용된다."""
    agg = {
        "likes_total": 1000, "comments_total": 100, "yt_total_views": 100_000,
        "dc_total_posts": 50, "theqoo_posts": 0, "instiz_posts": 0,
        "negative_ratio": 0.5, "loyalty_score": 100.0,
    }
    refs = {**DEFAULT_REFS}
    no_neg = _factor_inputs({**agg, "negative_ratio": 0.0}, refs)["intimacy"]
    with_neg = _factor_inputs(agg, refs)["intimacy"]
    assert with_neg == pytest.approx(no_neg * 0.5)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_health_score.py -k intimacy -q`
Expected: FAIL — `test_intimacy_with_loyalty_blends_third_signal` (현재 loyalty 무시되어 high==base==low)

- [ ] **Step 3: `_factor_inputs` intimacy 분기 구현**

`health_score.py` 의 `_factor_inputs` 안, `intimacy_compression` 계산 직후(line 544 다음)에 intimacy 변수를 미리 계산:

```python
    neg_ratio = float(agg.get("negative_ratio", 0) or 0)
    intimacy_compression = max(0.0, 1.0 - neg_ratio)

    # V2.46: 라이브 CCV 충성도를 Intimacy 3번째 신호로. 데이터 있는 그룹만
    # (loyalty_score not None) 3신호로 확장하고, 없으면 기존 2신호 경로를
    # 그대로 타 점수 불변(재정규화 페널티 0 — 라이브 안 한 그룹 손해 없음).
    loyalty_raw = agg.get("loyalty_score")
    if loyalty_raw is not None:
        loyalty_n = max(0.0, min(float(loyalty_raw) / 100.0, 1.0))
        intimacy = _wmean([
            (eng_n,     0.40, "quality"   in L),
            (comm_n,    0.30, "community" in L),
            (loyalty_n, 0.30, True),
        ]) * intimacy_compression
    else:
        intimacy = _wmean([
            (eng_n,  0.55, "quality"   in L),
            (comm_n, 0.45, "community" in L),
        ]) * intimacy_compression
```

그리고 return dict 의 `"intimacy": _wmean([...]) * intimacy_compression,` 줄을 다음으로 교체:

```python
        # Intimacy — engagement rate + community activity (+ V2.46 라이브
        # 충성도, 데이터 있을 때만), compressed by negative sentiment ratio.
        "intimacy": intimacy,
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_health_score.py -q`
Expected: PASS (기존 전부 + 신규 intimacy 3종) — 기존 점수 불변 회귀 통과가 핵심.

- [ ] **Step 5: 커밋**

```bash
git add worker/src/idol_sight/analysis/health_score.py worker/tests/unit/test_health_score.py
git commit -m "feat(health): Intimacy factor에 CCV 충성도 통합 (결측 시 2신호 재정규화)"
```

---

### Task 5: `_recompute_health_scores` 충성도 주입

`agg_fan_loyalty.score`를 읽어 각 그룹 `agg_dict["loyalty_score"]`에 주입. 테이블 없으면 graceful.

**Files:**
- Modify: `worker/src/idol_sight/cli.py:1242` 인접 (live_metrics 계산 직후) + `:1259-1276` (agg_dict)

- [ ] **Step 1: loyalty 조회 추가**

`cli.py` `_recompute_health_scores` 안, `live_metrics = compute_live_metrics(...)` 줄(line 1242) 다음에 추가:

```python
    # V2.46: 충성도 점수 주입용 조회. 테이블 미적용(migration 0084 전)이면
    # graceful — health 스코어링이 통째로 죽지 않게 빈 dict로 폴백.
    try:
        loyalty_rows = client.execute(
            "SELECT group_key, score FROM agg_fan_loyalty WHERE score IS NOT NULL"
        )
        loyalty_by_key = {r["group_key"]: r["score"] for r in loyalty_rows}
    except Exception:
        loyalty_by_key = {}
```

- [ ] **Step 2: agg_dict에 loyalty_score 추가**

같은 함수 `agg_dict = { ... }` 딕셔너리(line 1259-1276)에 `"v30_count": ...` 다음 줄로 추가:

```python
            "v30_count": (v30[0].get("n", 0) if v30 else 0),
            "loyalty_score": loyalty_by_key.get(g["key"]),  # None → 2신호 경로
```

- [ ] **Step 3: worker 전체 테스트 (회귀 가드)**

Run: `cd worker && uv run pytest -q`
Expected: PASS (전부)

- [ ] **Step 4: 커밋**

```bash
git add worker/src/idol_sight/cli.py
git commit -m "feat(health): _recompute_health_scores가 agg_fan_loyalty 주입 (graceful)"
```

---

### Task 6: API — `group/[key]` 응답에 `fan_loyalty`

**Files:**
- Modify: `frontend/functions/api/group/[key].ts`

- [ ] **Step 1: 충성도 조회 추가**

`frontend/functions/api/group/[key].ts` 의 `onRequestGet` 안, `return jsonResponse({` 직전에 추가:

```typescript
  // V2.46: 팬 충성도 (ccv_tracked 그룹만 row 존재). 테이블 미적용 시 graceful.
  const fanLoyalty = await d1QueryOne<{
    conversion_rate: number | null; peak_ccv_median: number | null;
    broadcast_count: number; subscribers: number | null;
    score: number | null; basis: string;
    ccv_trend_pct: number | null; trend_basis: string;
    window_days: number; snapshot_at: string;
  }>(env.DB,
    "SELECT conversion_rate, peak_ccv_median, broadcast_count, subscribers, "
    + "score, basis, ccv_trend_pct, trend_basis, window_days, snapshot_at "
    + "FROM agg_fan_loyalty WHERE group_key=?", [key])
    .catch(() => null);

  // 충성도 카드 스파크라인용 — 최근 방송별 peak CCV (윈도우 무관 최근 12방송).
  const loyaltyBroadcasts = await d1Query<{ video_id: string; peak: number; last_at: string }>(
    env.DB,
    "SELECT video_id, MAX(concurrent_viewers) AS peak, MAX(sampled_at) AS last_at "
    + "FROM live_ccv_samples WHERE group_key=? "
    + "GROUP BY video_id ORDER BY last_at DESC LIMIT 12", [key])
    .catch(() => [] as { video_id: string; peak: number; last_at: string }[]);
```

- [ ] **Step 2: 응답 객체에 추가**

`return jsonResponse({ ... })` 안, `summary_history: summaryHistory,` 다음 줄에 추가:

```typescript
    fan_loyalty: fanLoyalty
      ? { ...fanLoyalty, broadcasts: [...loyaltyBroadcasts].reverse() }  // 오래된→최신
      : null,
```

- [ ] **Step 3: 타입 체크**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 4: 커밋**

```bash
git add frontend/functions/api/group/[key].ts
git commit -m "feat(api): group 응답에 fan_loyalty + 방송별 peak 추가 (graceful)"
```

---

### Task 7: `FanLoyaltyCard` 컴포넌트

표시용 순수 헬퍼(증감율 라벨)는 분리해 vitest로 검증.

**Files:**
- Create: `frontend/src/components/FanLoyaltyCard.tsx`
- Test: `frontend/src/components/FanLoyaltyCard.test.ts`

- [ ] **Step 1: 헬퍼 실패 테스트 작성**

```typescript
// frontend/src/components/FanLoyaltyCard.test.ts
import { describe, it, expect } from "vitest";
import { trendLabel, fmtPct } from "./FanLoyaltyCard";

describe("trendLabel", () => {
  it("rising/falling/flat/unknown 라벨", () => {
    expect(trendLabel("rising", 0.25)).toBe("▲ +25%");
    expect(trendLabel("falling", -0.3)).toBe("▼ -30%");
    expect(trendLabel("flat", 0.05)).toBe("→ 유지");
    expect(trendLabel("unknown", null)).toBe("추세 보류");
  });
});

describe("fmtPct", () => {
  it("전환율을 소수 1자리 %로", () => {
    expect(fmtPct(0.015)).toBe("1.5%");
    expect(fmtPct(0.0008)).toBe("0.1%");
    expect(fmtPct(null)).toBe("—");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd frontend && pnpm vitest run src/components/FanLoyaltyCard.test.ts`
Expected: FAIL — 모듈/export 없음

- [ ] **Step 3: 컴포넌트 구현**

```tsx
// frontend/src/components/FanLoyaltyCard.tsx
interface Broadcast { video_id: string; peak: number; last_at: string; }
export interface FanLoyalty {
  conversion_rate: number | null;
  peak_ccv_median: number | null;
  broadcast_count: number;
  subscribers: number | null;
  score: number | null;
  basis: "scored" | "low_confidence" | "insufficient";
  ccv_trend_pct: number | null;
  trend_basis: "rising" | "falling" | "flat" | "unknown";
  window_days: number;
  broadcasts: Broadcast[];
}

export function fmtPct(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

export function trendLabel(basis: string, pct: number | null): string {
  if (basis === "unknown" || pct == null) return "추세 보류";
  if (basis === "flat") return "→ 유지";
  const sign = pct > 0 ? "+" : "";
  const arrow = basis === "rising" ? "▲" : "▼";
  return `${arrow} ${sign}${Math.round(pct * 100)}%`;
}

function scoreColor(score: number | null): string {
  if (score == null) return "text-zinc-500";
  if (score >= 88) return "text-emerald-400";
  if (score >= 70) return "text-lime-400";
  if (score >= 50) return "text-amber-400";
  return "text-red-400";
}

function Spark({ pts }: { pts: number[] }) {
  if (pts.length < 2) return null;
  const max = Math.max(...pts, 1);
  const w = 120, h = 28;
  const d = pts.map((v, i) =>
    `${(i / (pts.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg width={w} height={h} class="text-brand-fg">
      <polyline points={d} fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}

export function FanLoyaltyCard({ loyalty }: { loyalty: FanLoyalty }) {
  const { basis, score, conversion_rate, trend_basis, ccv_trend_pct,
          broadcast_count, window_days, broadcasts } = loyalty;

  return (
    <section class="rounded-lg border border-zinc-800 p-3">
      <div class="mb-1 flex items-baseline justify-between">
        <h3 class="text-sm font-semibold">팬 충성도 (라이브 전환율)</h3>
        <span class="text-hint text-zinc-500">최근 {window_days}일 · 방송 {broadcast_count}회</span>
      </div>

      {basis === "insufficient" ? (
        <div class="text-data text-zinc-500">라이브 데이터 축적 중</div>
      ) : (
        <div class="flex items-center gap-4">
          <div class="flex items-baseline gap-2">
            <span class={`text-2xl font-bold tabular-nums ${scoreColor(score)}`}>
              {score != null ? Math.round(score) : "—"}
            </span>
            <span class="text-data text-zinc-400">
              전환율 {fmtPct(conversion_rate)}
            </span>
          </div>
          <div class={
            trend_basis === "rising" ? "text-data text-emerald-400"
            : trend_basis === "falling" ? "text-data text-red-400"
            : "text-data text-zinc-500"
          }>
            {trendLabel(trend_basis, ccv_trend_pct)}
          </div>
          <div class="ml-auto"><Spark pts={broadcasts.map((b) => b.peak)} /></div>
        </div>
      )}

      {basis === "low_confidence" && (
        <div class="mt-1 text-hint text-amber-500/80">단발 방송 기준 — 신뢰도 낮음</div>
      )}
      <div class="mt-2 text-hint text-zinc-500">
        충성도 = 구독자 중 라이브 전환율(규모 무관). 절대 시청자 수와 별개.
      </div>
    </section>
  );
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && pnpm vitest run src/components/FanLoyaltyCard.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/components/FanLoyaltyCard.tsx frontend/src/components/FanLoyaltyCard.test.ts
git commit -m "feat(ui): FanLoyaltyCard — 충성도 점수/전환율/증감율/스파크라인"
```

---

### Task 8: GroupContent에 카드 마운트

**Files:**
- Modify: `frontend/src/views/GroupContent.tsx:8` (import), KPI grid 섹션 직후

- [ ] **Step 1: import 추가**

`frontend/src/views/GroupContent.tsx` 상단 import 블록(line 8 `GroupTabs` import 인접)에 추가:

```tsx
import { FanLoyaltyCard } from "../components/FanLoyaltyCard";
```

- [ ] **Step 2: 카드 렌더 추가**

content 탭 KPI grid 섹션 — `<section class="grid grid-cols-2 gap-2 md:grid-cols-5">` 로 시작하는 블록(line 191 부근)의 닫는 `</section>` 바로 다음에 추가:

```tsx
          {data.fan_loyalty && <FanLoyaltyCard loyalty={data.fan_loyalty} />}
```

(`data.fan_loyalty`가 null인 비-tracked 그룹은 카드 미렌더 — 의도된 동작.)

- [ ] **Step 3: 타입체크 + 프런트 전체 테스트**

Run: `cd frontend && pnpm tsc --noEmit && pnpm vitest run`
Expected: 에러 없음, 전체 PASS

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/views/GroupContent.tsx
git commit -m "feat(ui): 그룹 상세 content 탭에 FanLoyaltyCard 마운트"
```

---

### Task 9: 최종 검증

- [ ] **Step 1: worker 전체 테스트**

Run: `cd worker && uv run pytest -q`
Expected: 전부 PASS (기존 704+ 및 신규 loyalty/intimacy 테스트)

- [ ] **Step 2: frontend 전체 테스트 + 타입체크**

Run: `cd frontend && pnpm vitest run && pnpm tsc --noEmit`
Expected: 전부 PASS, 타입 에러 없음

- [ ] **Step 3: 로컬 마이그레이션 전체 적용 검증**

Run: `cd frontend && wrangler d1 migrations apply idol-sight --local`
Expected: 0084 포함 전체 적용 성공

- [ ] **Step 4: CLAUDE.md V2.46 체인지로그 추가**

`CLAUDE.md` 의 V2.45 항목 다음에 V2.46 한 단락 추가 (이 기능 요약 + migration 0084 운영자 apply 필요 명시 + 범위 밖 후속).

- [ ] **Step 5: 커밋**

```bash
git add CLAUDE.md
git commit -m "docs(weekly): CLAUDE.md V2.46 (CCV 팬 충성도 점수화) 체인지로그"
```

---

## 운영자 후속 (구현 후, 코드와 별개)

1. **migration 0084 원격 apply**: `gh workflow run migrate.yml` (또는 `wrangler d1 migrations apply idol-sight --remote`). `group/[key].ts`가 graceful이라 적용 전에도 500 안 나지만, 충성도 표시·health 반영은 적용 후부터.
2. push 후 `frontend-deploy.yml` 자동 배포 → 다음 `aggregate` cron(21:30 KST)이 `agg_fan_loyalty` 채움.
3. collect-ccv가 다음 윈도우부터 8개 그룹 수집 → 56일 축적되며 점수 안정화.
4. 데이터 축적 후 `LOYALTY_ANCHORS` 임계값 실측 보정 (first-pass calibration).

## Self-Review 기록

- **Spec 커버리지**: Part A(수집확대=Task1, 산식=Task2-3) / Part B(증감율=Task2 ccv_trend) / Part C(Intimacy=Task4-5) / Part D(API=Task6, 카드=Task7-8) 전부 매핑됨.
- **Placeholder**: 없음 — 모든 코드/명령/기대출력 명시.
- **타입 일관성**: `compute_loyalty` 반환 키 ↔ `build_fan_loyalty` INSERT 파라미터 순서 ↔ migration 컬럼 ↔ API SELECT ↔ `FanLoyalty` 인터페이스 동일 필드명 확인. `basis` 값 도메인('scored'|'low_confidence'|'insufficient') 일관. `trend_basis`('rising'|'falling'|'flat'|'unknown') 일관.
- **결측 처리**: insufficient row도 적재(카드 "축적 중"), health는 score NULL→2신호 폴백, API/카드 null 가드 — 전 경로 graceful.
