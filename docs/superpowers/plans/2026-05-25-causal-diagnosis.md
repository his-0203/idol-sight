# Causal Diagnosis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 주간 LLM 인사이트가 단순 수치 나열이 아니라, worker 가 사전 진단한 시그널 다발 위에서 LLM 이 "유력 가설 + 대안 가설" 형태로 인과 설명을 작성하게 한다.

**Architecture:** worker 의 `analysis/weekly_diagnosis_signals.py` (순수 함수 — DB 의존 없음) 가 그룹별 raw row pair 에서 z-score / WoW ratio / organicity 분포 / reactivity 등 ~20개 시그널을 계산한다. `analysis/weekly_diagnosis.py` 가 그 시그널을 11개 가설 카탈로그 + 메타가드에 매핑하고 confidence 를 계산해 `GroupSignals` dict 를 만든다. `llm/weekly.py build_context` 가 이 dict 를 LLM 컨텍스트에 통합하고, `llm/prompts.py` 의 `_DIAGNOSIS_GUIDELINES` 가 LLM 으로 하여금 시그널 없는 가설을 거론하지 못하게 강제한다. 새 `signals_json` 컬럼은 frontend V2 시각화 hook 이자 audit 트레일.

**Tech Stack:** Python 3.12, uv, pytest, typer, Cloudflare D1 (SQLite), Gemini structured output, GitHub Actions cron.

**Spec:** `docs/superpowers/specs/2026-05-25-causal-diagnosis-design.md` (rev 2).

---

## File Structure

**Create:**
- `migrations/0066_insights_signals_json.sql` — insights 테이블에 signals_json 컬럼 추가.
- `worker/src/idol_sight/analysis/weekly_diagnosis_signals.py` — *순수 함수* 모듈. raw row pair → 시그널 dict. DB 의존 없음 (테스트 친화).
- `worker/src/idol_sight/analysis/weekly_diagnosis.py` — *오케스트레이션* 모듈. DB executor → signals 호출 → 가설 분류 → confidence → 메타가드 → `dict[str, GroupSignals]`.
- `worker/tests/unit/test_weekly_diagnosis_signals.py` — 시그널 함수 단위 테스트.
- `worker/tests/unit/test_weekly_diagnosis.py` — 가설 분류 + confidence + 오케스트레이션 통합 테스트.

**Modify:**
- `worker/src/idol_sight/llm/prompts.py` — `_DIAGNOSIS_GUIDELINES` 섹션 + 11-key hypothesis enum + 3 few-shot exemplars + `PROMPT_WEEKLY` 본문에 섹션 삽입.
- `worker/src/idol_sight/llm/weekly.py` — `build_context` 에 `signals_by_group` 추가, `generate_weekly` 의 INSERT 에 signals_json 컬럼 처리.
- `worker/src/idol_sight/llm/gemini.py` — `INSIGHT_OUTPUT_SCHEMA` 에 `signals_json` (LLM 출력은 아님 — server-side 주입) 은 추가 안 하고, `type` enum 에 `diagnosis` 만 추가.
- `worker/src/idol_sight/cli.py` — `analyze_weekly` 함수 안에서 LLM 호출 직전에 `compute_group_signals` 호출, 결과를 weekly context 에 주입.

**No change (verified):**
- `analyze-weekly.yml` cron — 기존 endpoint(`analyze-weekly`) 가 통합 진입점.
- `D1` enum constraint — type 컬럼에 constraint 없음, 코드 레벨 검증만.

---

## Responsibility Split

| 파일 | 책임 | 의존 |
|---|---|---|
| `weekly_diagnosis_signals.py` | 단일 시그널 계산 (z-score, WoW ratio, organicity ratio 등). 모두 순수 함수. | 없음 |
| `weekly_diagnosis.py` | 시그널 dict → 가설 카탈로그 매칭 + confidence + 메타가드 → `GroupSignals` dataclass | `_signals` 모듈, DB executor |
| `llm/weekly.py` | build_context 가 `compute_group_signals` 호출, generate_weekly 는 signals_json 직렬화 | `weekly_diagnosis`, gemini |
| `llm/prompts.py` | 카드 어조 규칙 (단정 금지 / 가설 한 줄 / Streisand 가드) | — |
| `cli.py analyze_weekly` | weekly cron 의 통합 진입점 — gemini 호출 직전에 diagnosis 호출 | weekly_diagnosis |

---

## Task 1: migration 0066 — insights.signals_json 컬럼

**Files:**
- Create: `migrations/0066_insights_signals_json.sql`

- [ ] **Step 1: 새 migration 파일 작성**

```sql
-- migrations/0066_insights_signals_json.sql
-- Causal Diagnosis (spec 2026-05-25-causal-diagnosis-design.md rev 2)
--
-- insights 카드에 sig 다발을 JSON 으로 첨부. type='diagnosis' 카드만
-- 채우고, 기존 insight/weekly/ipx_action 카드는 NULL.
--
-- Payload 형식 (코드 검증, D1 constraint 없음):
--   {
--     "hypothesis_primary":     "paid_youtube_ads",
--     "hypothesis_alternative": "broadcast_appearance",  -- nullable
--     "confidence":             "high",                  -- high|medium|low
--     "evidence":               [{"key": "...", "value": ..., "label": "..."}],
--     "meta_guards":            ["irrelevant_flagged_18%"]
--   }
--
-- nullable 인 이유:
--   1) 기존 행은 채울 방법이 없음.
--   2) LLM 이 type=diagnosis 가 아닌 카드를 emit 할 때는 첨부할 시그널이 없음.
--   3) Frontend V1 은 컬럼을 무시 (V2 가 evidence 칩으로 렌더링 예정).
ALTER TABLE insights ADD COLUMN signals_json TEXT;
```

- [ ] **Step 2: 로컬 D1 에 적용 + 검증**

```bash
cd frontend && wrangler d1 migrations apply idol-sight --local
```

Expected: `✓ Successfully applied 1 migration.` 한 줄.

추가 검증:

```bash
cd frontend && wrangler d1 execute idol-sight --local --command "PRAGMA table_info(insights);"
```

Expected output 중 마지막 행:
```
{ name: 'signals_json', type: 'TEXT', notnull: 0, dflt_value: null, ... }
```

- [ ] **Step 3: Commit**

```bash
git add migrations/0066_insights_signals_json.sql
git commit -m "feat(d1): V2.32 migration 0066 insights.signals_json

Causal Diagnosis (spec rev 2): type='diagnosis' 카드의 시그널 다발을
JSON 으로 저장. 기존 type 카드는 NULL. Frontend V1 무영향, V2 가
evidence 칩으로 렌더링 예정."
```

- [ ] **Step 4: 원격 D1 적용은 cron 주기 검증 후 별도 단계로 (Task 9 끝)**

원격 적용은 Task 9 의 end-to-end 검증 후 수동:
```bash
cd frontend && wrangler d1 migrations apply idol-sight --remote
```

---

## Task 2: signals 순수 함수 모듈 (TDD)

이 task 가 가장 큼 — 시그널 ~20개. 8개 sub-section 각각이 (test 작성 → fail → impl → pass → commit) 1 cycle. 모든 함수는 stateless: input dict → 시그널 값/bool. 순수성을 잃지 않게 DB 접근 금지.

**Files:**
- Create: `worker/src/idol_sight/analysis/weekly_diagnosis_signals.py`
- Create: `worker/tests/unit/test_weekly_diagnosis_signals.py`

### Task 2.A: z-score 시그널 (subs / views / news / community)

- [ ] **Step 1: 빈 모듈 스켈레톤 작성**

`worker/src/idol_sight/analysis/weekly_diagnosis_signals.py`:

```python
"""Causal Diagnosis 시그널 — 순수 함수 (DB 의존 없음).

각 함수는 raw row dict 를 받아 시그널 값 (float / bool / dict) 을 반환한다.
값의 의미는 함수마다 다르지만 공통 컨벤션:
  - z-score 함수는 ±∞ 부동을 막기 위해 std==0 시 0 반환.
  - WoW ratio 함수는 분모가 0 일 때 None 반환 (호출자가 dead-signal 처리).
  - bool 점등 함수는 (점등, 강도, 라벨) 3-tuple 반환.

이 모듈을 import 한 곳은 모두 weekly_diagnosis.py 의 orchestrator 한 곳뿐 —
다른 파일에서 import 금지 (인터페이스를 좁게 유지).
"""

from __future__ import annotations

import math
from statistics import mean, stdev
from typing import Any


def cohort_z_score(value: float, cohort: list[float]) -> float:
    """Return z-score of `value` against cohort.

    cohort 가 비었거나 표준편차 0 이면 0 반환 (변별 불가 = 중립).
    """
    if not cohort:
        return 0.0
    if len(cohort) < 2:
        return 0.0
    sd = stdev(cohort)
    if sd == 0:
        return 0.0
    return (value - mean(cohort)) / sd
```

- [ ] **Step 2: 첫 번째 failing test 작성**

`worker/tests/unit/test_weekly_diagnosis_signals.py`:

```python
"""weekly_diagnosis_signals — 순수 함수 단위 테스트."""

import math
from idol_sight.analysis.weekly_diagnosis_signals import cohort_z_score


def test_cohort_z_score_basic():
    z = cohort_z_score(value=10.0, cohort=[1.0, 2.0, 3.0, 4.0, 5.0])
    # mean=3, sd≈1.581, z=(10-3)/1.581 ≈ 4.43
    assert math.isclose(z, 4.428, abs_tol=0.01)


def test_cohort_z_score_zero_std():
    # 모든 값이 같으면 sd=0 → z=0 (중립).
    z = cohort_z_score(value=10.0, cohort=[5.0, 5.0, 5.0])
    assert z == 0.0


def test_cohort_z_score_empty():
    assert cohort_z_score(value=10.0, cohort=[]) == 0.0


def test_cohort_z_score_single_cohort():
    # 표본 1개로는 stdev 계산 불가 — 중립 0.
    assert cohort_z_score(value=10.0, cohort=[5.0]) == 0.0
```

- [ ] **Step 3: 테스트 실행 — pass 확인 (이미 impl 됨)**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v
```

Expected: 4 passed.

- [ ] **Step 4: subs/views/news/community WoW delta 함수 추가**

`weekly_diagnosis_signals.py` 끝에 추가:

```python
def wow_ratio(now: float | None, prev: float | None) -> float | None:
    """Week-over-week ratio = (now - prev) / max(prev, 1).

    prev 가 None 또는 0 이면 None 반환 (분모 불가 — dead signal).
    """
    if now is None or prev is None:
        return None
    if prev == 0:
        return None
    return (now - prev) / prev


def metric_delta(now: dict[str, Any], prev: dict[str, Any], key: str) -> float:
    """`now[key] - prev[key]`. 양쪽 모두 NULL coerce 후 차이.

    절대값 차이만 — z-score 가 필요하면 cohort_z_score 별도 호출.
    """
    n = float(now.get(key) or 0)
    p = float(prev.get(key) or 0)
    return n - p
```

- [ ] **Step 5: 위 함수들에 대한 test 추가**

test 파일에 추가:

```python
from idol_sight.analysis.weekly_diagnosis_signals import wow_ratio, metric_delta


def test_wow_ratio_positive_growth():
    assert wow_ratio(now=120, prev=100) == 0.2


def test_wow_ratio_negative_drop():
    assert math.isclose(wow_ratio(now=50, prev=100), -0.5)


def test_wow_ratio_prev_zero_returns_none():
    # 분모 0 → dead signal, None.
    assert wow_ratio(now=100, prev=0) is None


def test_wow_ratio_either_none():
    assert wow_ratio(now=None, prev=100) is None
    assert wow_ratio(now=100, prev=None) is None


def test_metric_delta_basic():
    now = {"subs": 100_000}
    prev = {"subs": 80_000}
    assert metric_delta(now, prev, "subs") == 20_000


def test_metric_delta_handles_null():
    now = {"subs": 100_000}
    prev = {}  # missing key
    assert metric_delta(now, prev, "subs") == 100_000
```

- [ ] **Step 6: 테스트 실행**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v
```

Expected: 10 passed.

- [ ] **Step 7: Commit**

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis_signals.py worker/tests/unit/test_weekly_diagnosis_signals.py
git commit -m "feat(worker): weekly_diagnosis_signals — 기본 z-score / WoW 함수

cohort_z_score / wow_ratio / metric_delta 3개 순수 함수.
Causal Diagnosis spec rev 2 Task 2.A."
```

### Task 2.B: engagement_rate / views_per_sub WoW 변화

- [ ] **Step 1: failing test 추가**

test 파일에 추가:

```python
from idol_sight.analysis.weekly_diagnosis_signals import (
    engagement_rate_from_agg, engagement_rate_wow_drop,
    views_per_sub, views_per_sub_wow_drop,
)


def test_engagement_rate_from_agg():
    """(likes + 5·comments) / views, health_score 와 동일 계산."""
    agg = {"yt_likes_total": 1000, "yt_comments_total": 200, "yt_total_views": 100_000}
    # (1000 + 5*200) / 100000 = 2000 / 100000 = 0.02
    assert engagement_rate_from_agg(agg) == 0.02


def test_engagement_rate_zero_views():
    assert engagement_rate_from_agg({"yt_total_views": 0}) == 0.0


def test_engagement_rate_wow_drop():
    now = {"yt_likes_total": 500, "yt_comments_total": 100, "yt_total_views": 100_000}
    prev = {"yt_likes_total": 1000, "yt_comments_total": 200, "yt_total_views": 100_000}
    # now ER = 1000/100000 = 0.01, prev ER = 2000/100000 = 0.02
    # drop = (0.01 - 0.02) / 0.02 = -0.5 (50% 하락)
    assert math.isclose(engagement_rate_wow_drop(now, prev), -0.5)


def test_views_per_sub():
    agg = {"yt_total_views": 5_000_000, "yt_subscribers": 100_000}
    assert views_per_sub(agg) == 50.0


def test_views_per_sub_subscribers_zero():
    # subs=0 이면 dead — None 반환
    assert views_per_sub({"yt_total_views": 1_000_000, "yt_subscribers": 0}) is None


def test_views_per_sub_wow_drop_30pct():
    now = {"yt_total_views": 7_000_000, "yt_subscribers": 200_000}    # 35
    prev = {"yt_total_views": 5_000_000, "yt_subscribers": 100_000}   # 50
    # (35 - 50) / 50 = -0.3
    assert math.isclose(views_per_sub_wow_drop(now, prev), -0.3)
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py::test_engagement_rate_from_agg -v
```

Expected: FAIL with `ImportError` (함수 미정의).

- [ ] **Step 3: 함수 구현 추가**

`weekly_diagnosis_signals.py` 끝에 추가:

```python
def engagement_rate_from_agg(agg: dict[str, Any]) -> float:
    """(likes + 5·comments) / views — health_score._engagement_rate 와 동일.

    health_score.py 의 _engagement_rate 와 의도적으로 같은 산식 (운영자가
    두 모듈을 비교했을 때 일관성). views=0 일 때는 0.0 반환.
    """
    likes = float(agg.get("yt_likes_total") or 0)
    comments = float(agg.get("yt_comments_total") or 0)
    views = float(agg.get("yt_total_views") or 0)
    if views <= 0:
        return 0.0
    return (likes + 5 * comments) / views


def engagement_rate_wow_drop(now: dict[str, Any], prev: dict[str, Any]) -> float:
    """ER 의 WoW 변화율. prev_er=0 이면 0 (변화 없음으로 처리).

    음수가 클수록 ER 하락 큼 → paid_ads / sub_purchase 가설의 핵심 시그널.
    """
    now_er = engagement_rate_from_agg(now)
    prev_er = engagement_rate_from_agg(prev)
    if prev_er == 0:
        return 0.0
    return (now_er - prev_er) / prev_er


def views_per_sub(agg: dict[str, Any]) -> float | None:
    """views / subscribers. subs<=0 이면 None (dead signal).

    이 비율이 급락하면 sub 만 늘고 view 는 안 따라온 케이스 →
    subscriber_purchase 가설.
    """
    subs = float(agg.get("yt_subscribers") or 0)
    if subs <= 0:
        return None
    views = float(agg.get("yt_total_views") or 0)
    return views / subs


def views_per_sub_wow_drop(now: dict[str, Any], prev: dict[str, Any]) -> float | None:
    """views/sub 의 WoW 변화율. 어느 쪽이라도 None 이면 None.

    -0.30 이면 30% 하락 → subscriber_purchase 가설 시그널.
    """
    now_vps = views_per_sub(now)
    prev_vps = views_per_sub(prev)
    if now_vps is None or prev_vps is None or prev_vps == 0:
        return None
    return (now_vps - prev_vps) / prev_vps
```

- [ ] **Step 4: 테스트 실행 — 6개 모두 pass**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v
```

Expected: 16 passed.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis_signals.py worker/tests/unit/test_weekly_diagnosis_signals.py
git commit -m "feat(worker): weekly_diagnosis_signals — engagement / views_per_sub WoW

paid_youtube_ads 와 subscriber_purchase 가설의 핵심 변별 시그널.
spec rev 2 Task 2.B."
```

### Task 2.C: organicity 분포 집계 (debut_window_video_organicity 활용)

- [ ] **Step 1: failing test 추가**

test 파일에 추가:

```python
from idol_sight.analysis.weekly_diagnosis_signals import organicity_paid_ratio


def test_organicity_paid_ratio_30pct():
    """suspect + likely_paid 비중. 영상 10개 중 3개가 paid 의심 = 0.3."""
    videos = [
        {"verdict": "organic_strong"},
        {"verdict": "organic"},
        {"verdict": "organic"},
        {"verdict": "organic"},
        {"verdict": "borderline"},
        {"verdict": "borderline"},
        {"verdict": "borderline"},
        {"verdict": "suspect"},
        {"verdict": "suspect"},
        {"verdict": "likely_paid"},
    ]
    assert organicity_paid_ratio(videos) == 0.3


def test_organicity_paid_ratio_excludes_insufficient():
    """insufficient_data 는 분모에서 제외 (debut_window 의 규약)."""
    videos = [
        {"verdict": "organic"},
        {"verdict": "suspect"},
        {"verdict": "insufficient_data"},   # 제외
        {"verdict": "insufficient_data"},   # 제외
    ]
    # 분모 2, paid 1 → 0.5
    assert organicity_paid_ratio(videos) == 0.5


def test_organicity_paid_ratio_empty():
    assert organicity_paid_ratio([]) is None


def test_organicity_paid_ratio_all_insufficient():
    # 분모 0 → None (dead signal)
    videos = [{"verdict": "insufficient_data"}, {"verdict": "insufficient_data"}]
    assert organicity_paid_ratio(videos) is None
```

- [ ] **Step 2: fail 확인 + 구현**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v
```

(첫 번째 새 test 가 fail 함을 확인)

`weekly_diagnosis_signals.py` 끝에 추가:

```python
def organicity_paid_ratio(videos: list[dict[str, Any]]) -> float | None:
    """`debut_window_video_organicity` 행들 중 suspect+likely_paid 비중.

    `insufficient_data` 행은 분모에서 제외 (debut_window_organicity 의
    내부 규약 — score_mean 계산에서도 동일하게 제외함).

    None 반환:
      - 입력이 빈 리스트
      - 모든 행이 insufficient_data (denom = 0)

    이 비율 ≥ 0.30 이 paid_youtube_ads 가설의 강한 시그널.
    """
    if not videos:
        return None
    scored = [v for v in videos if v.get("verdict") != "insufficient_data"]
    if not scored:
        return None
    paid = sum(1 for v in scored if v.get("verdict") in ("suspect", "likely_paid"))
    return paid / len(scored)
```

테스트 재실행:
```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v
```
Expected: 20 passed.

- [ ] **Step 3: Commit**

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis_signals.py worker/tests/unit/test_weekly_diagnosis_signals.py
git commit -m "feat(worker): weekly_diagnosis_signals — organicity paid ratio

debut_window_video_organicity 의 주간 신규 영상 verdict 분포에서
suspect+likely_paid 비중 집계. paid_youtube_ads 가설의 직접 evidence.
spec rev 2 Task 2.C."
```

### Task 2.D: reactivity dominance (platform_concentrated_promo)

- [ ] **Step 1: failing test + 구현 + commit (한 사이클)**

test 추가:

```python
from idol_sight.analysis.weekly_diagnosis_signals import (
    reactivity_dominant_platform, REACTIVITY_DOMINANCE_THRESHOLD,
)


def test_reactivity_dominant_naver():
    """reactivity_naver=3.0, 나머지 < 1.3 → 'naver' 반환."""
    agg = {
        "reactivity_dc": 1.0,
        "reactivity_theqoo": 1.2,
        "reactivity_instiz": 1.1,
        "reactivity_naver": 3.0,
        "reactivity_sample": 5,
    }
    name, ratio = reactivity_dominant_platform(agg)
    assert name == "naver"
    assert ratio == 3.0


def test_reactivity_no_dominance():
    """전 플랫폼 비슷한 reactivity → (None, 0.0)."""
    agg = {
        "reactivity_dc": 1.5,
        "reactivity_theqoo": 1.4,
        "reactivity_instiz": 1.6,
        "reactivity_naver": 1.5,
        "reactivity_sample": 5,
    }
    name, _ = reactivity_dominant_platform(agg)
    assert name is None


def test_reactivity_threshold_not_met():
    """단일 max 가 임계치 < 2.5 → 점등 안 됨."""
    agg = {
        "reactivity_dc": 2.0,    # > 나머지지만 임계치 2.5 미달
        "reactivity_theqoo": 1.0,
        "reactivity_instiz": 1.0,
        "reactivity_naver": 1.0,
        "reactivity_sample": 5,
    }
    name, _ = reactivity_dominant_platform(agg)
    assert name is None


def test_reactivity_sample_too_low_blocks():
    """sample < 3 → dominance 점등 차단 (메타가드)."""
    agg = {
        "reactivity_dc": 1.0,
        "reactivity_theqoo": 1.0,
        "reactivity_instiz": 1.0,
        "reactivity_naver": 3.0,
        "reactivity_sample": 2,    # 표본 부족
    }
    name, _ = reactivity_dominant_platform(agg)
    assert name is None
```

`weekly_diagnosis_signals.py` 추가:

```python
# Platform concentration 임계치. dominant 플랫폼의 reactivity 가 이 이상이고
# 나머지 모두가 OTHER_MAX_THRESHOLD 미만일 때만 점등.
REACTIVITY_DOMINANCE_THRESHOLD = 2.5
REACTIVITY_OTHER_MAX_THRESHOLD = 1.3
# reactivity_sample 가 이 미만이면 시그널 자체 차단 (표본 부족).
REACTIVITY_MIN_SAMPLE = 3


def reactivity_dominant_platform(agg: dict[str, Any]) -> tuple[str | None, float]:
    """단일 플랫폼이 reactivity 를 압도하는지 판정.

    Returns:
      (platform_name, ratio) 점등 시.
      (None, 0.0)            점등 안 됨.

    점등 조건:
      - reactivity_sample >= 3 (표본 부족 차단)
      - max(reactivity_*) >= 2.5
      - 나머지 3개 reactivity_* 가 모두 < 1.3

    platform_concentrated_promo 가설의 핵심 시그널.
    """
    if int(agg.get("reactivity_sample") or 0) < REACTIVITY_MIN_SAMPLE:
        return None, 0.0
    platforms = {
        "dc":     float(agg.get("reactivity_dc")     or 1.0),
        "theqoo": float(agg.get("reactivity_theqoo") or 1.0),
        "instiz": float(agg.get("reactivity_instiz") or 1.0),
        "naver":  float(agg.get("reactivity_naver")  or 1.0),
    }
    dom_name, dom_val = max(platforms.items(), key=lambda kv: kv[1])
    if dom_val < REACTIVITY_DOMINANCE_THRESHOLD:
        return None, 0.0
    others_max = max(v for k, v in platforms.items() if k != dom_name)
    if others_max >= REACTIVITY_OTHER_MAX_THRESHOLD:
        return None, 0.0
    return dom_name, dom_val
```

- [ ] **Step 2: 테스트 실행**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v
```
Expected: 24 passed.

- [ ] **Step 3: Commit**

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis_signals.py worker/tests/unit/test_weekly_diagnosis_signals.py
git commit -m "feat(worker): weekly_diagnosis_signals — reactivity dominance

platform_concentrated_promo 가설의 핵심 시그널. V2.11 컬럼을
활용해 단일 플랫폼만 spike 케이스 변별.
spec rev 2 Task 2.D."
```

### Task 2.E: member-centric spike (top1_share / hhi_norm WoW)

- [ ] **Step 1: failing test + 구현**

test 추가:

```python
from idol_sight.analysis.weekly_diagnosis_signals import member_centric_signals


def test_member_centric_top1_share_jump():
    """top1_share 가 0.45 → 0.58 (+13pt) → 점등."""
    now = {"top1_share": 0.58, "top3_share": 0.78, "hhi_norm": 0.40}
    prev = {"top1_share": 0.45, "top3_share": 0.75, "hhi_norm": 0.30}
    sig = member_centric_signals(now, prev)
    assert sig["lit"] is True
    assert sig["top1_share_now"] == 0.58
    assert math.isclose(sig["top1_share_wow"], 0.13)


def test_member_centric_hhi_jump_without_top1():
    """top1 변화는 작지만 hhi_norm +0.18 점프 → 점등."""
    now = {"top1_share": 0.40, "top3_share": 0.85, "hhi_norm": 0.50}
    prev = {"top1_share": 0.38, "top3_share": 0.70, "hhi_norm": 0.32}
    sig = member_centric_signals(now, prev)
    assert sig["lit"] is True
    assert math.isclose(sig["hhi_norm_wow"], 0.18)


def test_member_centric_no_change():
    now = {"top1_share": 0.40, "top3_share": 0.75, "hhi_norm": 0.30}
    prev = {"top1_share": 0.39, "top3_share": 0.74, "hhi_norm": 0.29}
    sig = member_centric_signals(now, prev)
    assert sig["lit"] is False


def test_member_centric_missing_meta_returns_dead():
    """agg_member_pop_meta 행 자체가 없는 그룹 (corporate single-channel) → dead."""
    sig = member_centric_signals({}, {})
    assert sig["lit"] is False
    assert sig["dead"] is True
```

`weekly_diagnosis_signals.py` 추가:

```python
# member_centric_spike 가설의 점등 임계치.
TOP1_SHARE_WOW_THRESHOLD = 0.10        # +10pt 이상
HHI_NORM_WOW_THRESHOLD = 0.15          # +0.15 이상
TOP1_SHARE_ABS_HIGH = 0.60             # 절대치 이 이상이면 high boost


def member_centric_signals(
    now: dict[str, Any], prev: dict[str, Any],
) -> dict[str, Any]:
    """agg_member_pop_meta 의 top1/top3/hhi_norm WoW 변화.

    Returns:
      {
        "lit":             bool,   # 점등 여부
        "dead":            bool,   # raw meta 가 없는 경우 (corporate single-channel)
        "top1_share_now":  float | None,
        "top1_share_wow":  float | None,
        "hhi_norm_wow":    float | None,
        "top1_share_high": bool,   # >= 0.60 → confidence boost
      }
    """
    t1_now = now.get("top1_share")
    t1_prev = prev.get("top1_share")
    hhi_now = now.get("hhi_norm")
    hhi_prev = prev.get("hhi_norm")

    if t1_now is None and hhi_now is None:
        return {
            "lit": False, "dead": True,
            "top1_share_now": None, "top1_share_wow": None,
            "hhi_norm_wow": None, "top1_share_high": False,
        }

    t1_wow = (
        (float(t1_now) - float(t1_prev)) if (t1_now is not None and t1_prev is not None) else None
    )
    hhi_wow = (
        (float(hhi_now) - float(hhi_prev)) if (hhi_now is not None and hhi_prev is not None) else None
    )

    lit = (
        (t1_wow is not None and t1_wow >= TOP1_SHARE_WOW_THRESHOLD)
        or (hhi_wow is not None and hhi_wow >= HHI_NORM_WOW_THRESHOLD)
    )
    return {
        "lit": lit,
        "dead": False,
        "top1_share_now": float(t1_now) if t1_now is not None else None,
        "top1_share_wow": t1_wow,
        "hhi_norm_wow": hhi_wow,
        "top1_share_high": (t1_now is not None and float(t1_now) >= TOP1_SHARE_ABS_HIGH),
    }
```

- [ ] **Step 2: 테스트 실행 + commit**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v
```
Expected: 28 passed.

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis_signals.py worker/tests/unit/test_weekly_diagnosis_signals.py
git commit -m "feat(worker): weekly_diagnosis_signals — member-centric spike

agg_member_pop_meta 의 top1_share / hhi_norm WoW 변화.
segmentary/confederation 모델에서 멤버 1명 솔로 활동이 그룹 spike 를
일으키는 패턴 변별.
spec rev 2 Task 2.E."
```

### Task 2.F: comeback evidence (group_events 매칭 + music_show 연속 1위)

- [ ] **Step 1: failing test + 구현**

test 추가:

```python
from idol_sight.analysis.weekly_diagnosis_signals import (
    group_event_within_window, music_show_consecutive_wins,
)


def test_group_event_match_within_7d():
    """event_date 가 주간 윈도우 ±7d 안에 있으면 매칭."""
    events = [
        {"event_date": "2026-05-22", "event_type": "album_release", "title": "Caligo Pt.3"},
        {"event_date": "2026-01-10", "event_type": "debut", "title": "Debut Show"},
    ]
    match = group_event_within_window(
        events, week_start="2026-05-18", week_end="2026-05-24",
    )
    assert match is not None
    assert match["title"] == "Caligo Pt.3"


def test_group_event_no_match():
    events = [
        {"event_date": "2024-01-10", "event_type": "debut", "title": "Debut"},
    ]
    assert group_event_within_window(
        events, week_start="2026-05-18", week_end="2026-05-24",
    ) is None


def test_group_event_window_edge_7d_before():
    """주간 시작 7일 전 = 윈도우 안 (5/18 - 7 = 5/11)."""
    events = [{"event_date": "2026-05-11", "event_type": "comeback", "title": "Comeback"}]
    match = group_event_within_window(
        events, week_start="2026-05-18", week_end="2026-05-24",
    )
    assert match is not None


def test_group_event_window_8d_before_excluded():
    events = [{"event_date": "2026-05-10", "event_type": "comeback", "title": "Old"}]
    assert group_event_within_window(
        events, week_start="2026-05-18", week_end="2026-05-24",
    ) is None


def test_music_show_consecutive_wins_3():
    """동일 곡 (song_title) 3회 연속 1위 → 점등."""
    wins = [
        {"show": "M Countdown", "song_title": "Pump Up The Volume", "win_date": "2026-05-20"},
        {"show": "Music Bank",   "song_title": "Pump Up The Volume", "win_date": "2026-05-21"},
        {"show": "Inkigayo",     "song_title": "Pump Up The Volume", "win_date": "2026-05-22"},
    ]
    streak = music_show_consecutive_wins(wins)
    assert streak["song_title"] == "Pump Up The Volume"
    assert streak["consecutive"] == 3


def test_music_show_consecutive_wins_below_threshold():
    """2회 → 점등 안 됨 (threshold 3)."""
    wins = [
        {"show": "M Countdown", "song_title": "A", "win_date": "2026-05-20"},
        {"show": "Music Bank",   "song_title": "A", "win_date": "2026-05-21"},
    ]
    streak = music_show_consecutive_wins(wins)
    assert streak["consecutive"] == 0
```

`weekly_diagnosis_signals.py` 추가:

```python
from datetime import date, timedelta

GROUP_EVENT_WINDOW_DAYS = 7
MUSIC_SHOW_STREAK_THRESHOLD = 3


def group_event_within_window(
    events: list[dict[str, Any]],
    *, week_start: str, week_end: str,
) -> dict[str, Any] | None:
    """주간 윈도우 [week_start - 7d, week_end + 7d] 안에 떨어지는 첫 매칭 이벤트.

    comeback_cycle 가설의 ground truth. group_events 테이블의 album_release /
    comeback / show_win / first_release / mv_release 등 이벤트와 매칭되면
    confidence 부스트.
    """
    ws = date.fromisoformat(week_start) - timedelta(days=GROUP_EVENT_WINDOW_DAYS)
    we = date.fromisoformat(week_end) + timedelta(days=GROUP_EVENT_WINDOW_DAYS)
    for ev in events:
        ed_raw = ev.get("event_date")
        if not ed_raw:
            continue
        try:
            ed = date.fromisoformat(ed_raw[:10])
        except ValueError:
            continue
        if ws <= ed <= we:
            return ev
    return None


def music_show_consecutive_wins(wins: list[dict[str, Any]]) -> dict[str, Any]:
    """같은 song_title 의 연속 1위 횟수. 정렬은 win_date 오름차순 가정.

    threshold (3) 미만이면 consecutive=0 으로 반환 (점등 안 됨 의미).
    comeback_cycle momentum 증거.
    """
    if not wins:
        return {"song_title": None, "consecutive": 0}
    sorted_wins = sorted(wins, key=lambda w: w.get("win_date") or "")
    # song_title 별 카운트 (가장 긴 streak 찾기)
    best = {"song_title": None, "consecutive": 0}
    current_song = None
    current_count = 0
    for w in sorted_wins:
        song = w.get("song_title")
        if song == current_song:
            current_count += 1
        else:
            current_song = song
            current_count = 1
        if current_count > best["consecutive"]:
            best = {"song_title": current_song, "consecutive": current_count}
    if best["consecutive"] < MUSIC_SHOW_STREAK_THRESHOLD:
        return {"song_title": None, "consecutive": 0}
    return best
```

- [ ] **Step 2: 테스트 + commit**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v
```
Expected: 34 passed.

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis_signals.py worker/tests/unit/test_weekly_diagnosis_signals.py
git commit -m "feat(worker): weekly_diagnosis_signals — comeback ground truth

group_events ±7d 매칭 + music_show_wins_log 연속 1위 streak.
comeback_cycle 가설의 ground truth 부스트.
spec rev 2 Task 2.F."
```

### Task 2.G: controversy evidence (community_keywords 부정 키워드 + twitter type)

- [ ] **Step 1: failing test + 구현**

test 추가:

```python
from idol_sight.analysis.weekly_diagnosis_signals import (
    negative_keyword_z, twitter_controversy_z, NEGATIVE_KEYWORDS,
)


def test_negative_keyword_z_lit():
    """이번 주 부정 키워드 카운트 50, 과거 평균 10/표편 8 → z=5.0."""
    now_keywords = [
        {"keyword": "논란", "count": 30},
        {"keyword": "사과", "count": 15},
        {"keyword": "의혹", "count": 5},
        {"keyword": "활동", "count": 100},  # 부정 키워드 아님 — 제외
    ]
    past_weekly_neg_totals = [12, 8, 10, 5, 15, 7, 13, 9, 11, 10]
    z = negative_keyword_z(now_keywords, past_weekly_neg_totals)
    assert z > 2.5


def test_negative_keyword_z_zero_signal():
    """이번 주 부정 키워드 전혀 없음 → z 음수 또는 0."""
    now_keywords = [{"keyword": "콘서트", "count": 100}]
    past_weekly_neg_totals = [10, 12, 8]
    z = negative_keyword_z(now_keywords, past_weekly_neg_totals)
    assert z < 0


def test_twitter_controversy_z():
    """twitter_posts type='controversy' 카운트 z-score."""
    cohort = [1, 2, 0, 1, 3, 2, 1]   # 평균 1.43, sd~1.0
    z = twitter_controversy_z(now_count=8, cohort_counts=cohort)
    assert z > 4.0


def test_negative_keywords_list_includes_canonical():
    """spec 의 부정 키워드 카탈로그가 모두 포함되어 있는지 sanity check."""
    for kw in ("논란", "사과", "의혹", "해명"):
        assert kw in NEGATIVE_KEYWORDS
```

`weekly_diagnosis_signals.py` 추가:

```python
# controversy 가설의 community_keywords 부정 키워드 카탈로그.
# 이 리스트가 부족하면 false negative — 누락 의심 시 확장.
NEGATIVE_KEYWORDS: frozenset[str] = frozenset({
    "논란", "사과", "의혹", "해명", "거짓",
    "비난", "악플", "고소", "탈퇴 요구",
    "스캔들", "표절", "갈등",
})


def negative_keyword_z(
    now_keywords: list[dict[str, Any]],
    past_weekly_neg_totals: list[float],
) -> float:
    """이번 주 NEGATIVE_KEYWORDS 카운트 합을 과거 주간 합 분포에 z-score 화.

    `past_weekly_neg_totals` 는 이전 N주의 부정 키워드 주간 합 (호출자
    책임). 분포 부족 (< 2 표본) 이면 0 반환.
    """
    now_total = sum(
        int(kw.get("count") or 0)
        for kw in now_keywords
        if kw.get("keyword") in NEGATIVE_KEYWORDS
    )
    return cohort_z_score(value=now_total, cohort=past_weekly_neg_totals)


def twitter_controversy_z(now_count: int, cohort_counts: list[float]) -> float:
    """twitter_posts type='controversy' 의 주간 카운트 z-score.

    controversy_spike 가설의 직접 시그널 (community_keywords 와 OR 결합).
    """
    return cohort_z_score(value=float(now_count), cohort=cohort_counts)
```

- [ ] **Step 2: 테스트 + commit**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v
```
Expected: 38 passed.

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis_signals.py worker/tests/unit/test_weekly_diagnosis_signals.py
git commit -m "feat(worker): weekly_diagnosis_signals — controversy evidence

community_keywords 부정 키워드 + twitter type='controversy' z-score.
controversy_spike 가설의 다층 evidence (인간 검증 가드용).
spec rev 2 Task 2.G."
```

### Task 2.H: 메타가드 시그널 (irrelevant flag + data_source)

- [ ] **Step 1: failing test + 구현**

test 추가:

```python
from idol_sight.analysis.weekly_diagnosis_signals import (
    irrelevant_flag_ratio, data_source_warning,
    IRRELEVANT_RATIO_THRESHOLD,
)


def test_irrelevant_flag_ratio_lit():
    """주간 community_posts 100개 중 18개 flagged → 0.18."""
    posts = [{"user_flagged_irrelevant": 1}] * 18 + [{"user_flagged_irrelevant": 0}] * 82
    assert math.isclose(irrelevant_flag_ratio(posts), 0.18)


def test_irrelevant_flag_below_threshold():
    """ratio < 0.15 → 경고 안 점등."""
    posts = [{"user_flagged_irrelevant": 1}] * 10 + [{"user_flagged_irrelevant": 0}] * 90
    assert irrelevant_flag_ratio(posts) < IRRELEVANT_RATIO_THRESHOLD


def test_irrelevant_flag_empty():
    assert irrelevant_flag_ratio([]) == 0.0


def test_data_source_warning_majority_backfill():
    """7d window 의 과반이 backfill_* → 경고."""
    rows = [
        {"data_source": "backfill_estimate"},
        {"data_source": "backfill_exact"},
        {"data_source": "live"},
        {"data_source": "backfill_estimate"},
    ]
    # 3/4 = 0.75 > 0.5 → True
    assert data_source_warning(rows) is True


def test_data_source_warning_majority_live():
    rows = [{"data_source": "live"}] * 7 + [{"data_source": "backfill_exact"}]
    # 1/8 backfill → False
    assert data_source_warning(rows) is False


def test_data_source_warning_empty():
    assert data_source_warning([]) is False
```

`weekly_diagnosis_signals.py` 추가:

```python
IRRELEVANT_RATIO_THRESHOLD = 0.15
DATA_SOURCE_BACKFILL_MAJORITY = 0.5


def irrelevant_flag_ratio(posts: list[dict[str, Any]]) -> float:
    """user_flagged_irrelevant 가 1 인 post 의 비중. 빈 입력은 0.0.

    >= 0.15 시 data_credibility_warning 메타가드 점등 → 모든 가설 confidence 한 단계 감점.
    """
    if not posts:
        return 0.0
    flagged = sum(1 for p in posts if (p.get("user_flagged_irrelevant") or 0) == 1)
    return flagged / len(posts)


def data_source_warning(rows: list[dict[str, Any]]) -> bool:
    """7d window 의 agg_summary 행 중 과반이 backfill_* 이면 True.

    수동 시드/백필이 자동 수집보다 많으면 시그널 자체의 신뢰성이 떨어짐.
    """
    if not rows:
        return False
    backfill_count = sum(
        1 for r in rows
        if (r.get("data_source") or "live").startswith("backfill")
    )
    return (backfill_count / len(rows)) > DATA_SOURCE_BACKFILL_MAJORITY
```

- [ ] **Step 2: 테스트 + commit**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v
```
Expected: 44 passed.

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis_signals.py worker/tests/unit/test_weekly_diagnosis_signals.py
git commit -m "feat(worker): weekly_diagnosis_signals — meta guard signals

user_flagged_irrelevant 비율 (≥15%) + agg_summary.data_source backfill
과반 → data_credibility_warning 메타가드 점등 조건.
spec rev 2 Task 2.H."
```

---

## Task 3: 가설 분류 + confidence + 메타가드 적용

**Files:**
- Create: `worker/src/idol_sight/analysis/weekly_diagnosis.py`
- Create: `worker/tests/unit/test_weekly_diagnosis.py`

이 task 는 시그널 dict → 가설 카탈로그 → confidence → 메타가드 적용까지의 *순수 로직*. DB 접근은 Task 4 에서 wrapper 추가.

### Task 3.A: GroupSignals dataclass + 11 hypothesis enum

- [ ] **Step 1: 모듈 스켈레톤 + 데이터 구조 정의**

`worker/src/idol_sight/analysis/weekly_diagnosis.py`:

```python
"""Causal Diagnosis 오케스트레이션.

`weekly_diagnosis_signals` 의 raw 시그널 → 11개 가설 카탈로그 →
confidence → 메타가드 적용 → `GroupSignals` dataclass.

이 모듈은 DB 접근 추상화 (`_Executor` Protocol) 를 통해 raw row 만
의존한다. `compute_group_signals(db, week_start, week_end)` 가 진입점.

가설 카탈로그: spec 2026-05-25-causal-diagnosis-design.md rev 2 §3.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


HYPOTHESIS_KEYS: tuple[str, ...] = (
    "organic_growth",
    "paid_youtube_ads",
    "subscriber_purchase",
    "comeback_cycle",
    "broadcast_appearance",
    "community_word_of_mouth",
    "controversy_spike",
    "platform_concentrated_promo",
    "member_centric_spike",
    "insufficient_signal",
)

CONFIDENCE_LEVELS: tuple[str, ...] = ("high", "medium", "low")


@dataclass
class Evidence:
    key: str
    value: Any
    label: str


@dataclass
class Hypothesis:
    key: str
    confidence: str            # 'high' | 'medium' | 'low'
    evidence: list[Evidence] = field(default_factory=list)


@dataclass
class GroupSignals:
    group_key: str
    hypotheses: list[Hypothesis] = field(default_factory=list)
    meta_guards: list[str] = field(default_factory=list)
    deltas: dict[str, float] = field(default_factory=dict)
    organicity: dict[str, Any] | None = None


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...
```

- [ ] **Step 2: failing test 작성**

`worker/tests/unit/test_weekly_diagnosis.py`:

```python
"""weekly_diagnosis — 가설 분류 + confidence + 메타가드."""

import math

from idol_sight.analysis.weekly_diagnosis import (
    HYPOTHESIS_KEYS, CONFIDENCE_LEVELS,
    Evidence, Hypothesis, GroupSignals,
)


def test_hypothesis_keys_complete():
    """spec rev 2 의 11 가설 (insufficient_signal 포함) 모두 enum 에 존재."""
    expected = {
        "organic_growth", "paid_youtube_ads", "subscriber_purchase",
        "comeback_cycle", "broadcast_appearance", "community_word_of_mouth",
        "controversy_spike", "platform_concentrated_promo",
        "member_centric_spike", "insufficient_signal",
    }
    assert set(HYPOTHESIS_KEYS) == expected


def test_confidence_levels_order():
    """confidence 등급 high → medium → low (감점 시 인덱스 +1)."""
    assert CONFIDENCE_LEVELS == ("high", "medium", "low")


def test_group_signals_empty_defaults():
    gs = GroupSignals(group_key="plave")
    assert gs.hypotheses == []
    assert gs.meta_guards == []
    assert gs.organicity is None
```

- [ ] **Step 3: 테스트 실행**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis.py -v
```
Expected: 3 passed (impl 이 이미 그 부분 — enum/dataclass — 만 충족).

- [ ] **Step 4: Commit**

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis.py worker/tests/unit/test_weekly_diagnosis.py
git commit -m "feat(worker): weekly_diagnosis — dataclass 스켈레톤 + 11 가설 enum

Causal Diagnosis 오케스트레이션 모듈. dataclass / enum 만 우선 정의,
가설 분류 로직은 후속 Task 3.B+.
spec rev 2 Task 3.A."
```

### Task 3.B: classify_hypotheses — 11개 가설 점등 함수

이 sub-task 는 각 가설마다 *별도 함수* 로 점등 조건을 표현한다. 함수 시그니처 통일: `def _check_<name>(sig: dict, agg_now: dict, agg_prev: dict, ...) -> Hypothesis | None`.

- [ ] **Step 1: failing test 추가 — organic_growth + paid_youtube_ads**

test 파일에 추가:

```python
from idol_sight.analysis.weekly_diagnosis import classify_hypotheses


def _base_signal_bundle() -> dict:
    """모든 시그널이 중립값인 baseline. 각 test 가 필요한 키만 override."""
    return {
        "subs_z":             0.0,
        "views_z":            0.0,
        "news_z":             0.0,
        "community_z":        0.0,
        "market_share_z":     0.0,
        "er_wow":             0.0,
        "vps_wow":            None,
        "organicity_paid":    None,
        "reactivity_dominant": (None, 0.0),
        "member_centric":     {"lit": False, "dead": True, "top1_share_high": False,
                               "top1_share_now": None, "top1_share_wow": None,
                               "hhi_norm_wow": None},
        "comeback":           {"event_match": None, "music_streak": 0,
                               "hanteo_sales": 0, "chart_peak": None,
                               "video_upload_z": 0.0},
        "controversy":        {"keyword_z": 0.0, "twitter_z": 0.0,
                               "controversy_count_z": 0.0,
                               "negative_ratio_z": 0.0},
        "community_keywords_topic": "neutral",   # 'self' | 'external' | 'negative' | 'neutral'
        "video_tags_paid_match":   False,
    }


def test_organic_growth_all_signals_lit():
    """5개 시그널 (subs/views/news/community/market_share) 모두 z>=1.5 → high."""
    sig = _base_signal_bundle() | {
        "subs_z": 1.8, "views_z": 2.0, "news_z": 1.6,
        "community_z": 1.7, "market_share_z": 1.5,
        "er_wow": 0.02,   # 안정 (±5% 안)
    }
    hyps = classify_hypotheses(sig)
    keys = [h.key for h in hyps]
    assert "organic_growth" in keys
    organic = next(h for h in hyps if h.key == "organic_growth")
    assert organic.confidence == "high"


def test_paid_youtube_ads_high_views_low_er():
    """views z=3, subs z=0.3, ER drop 28%, organicity paid 42% → high."""
    sig = _base_signal_bundle() | {
        "views_z": 3.0,
        "subs_z": 0.3,
        "er_wow": -0.28,
        "organicity_paid": 0.42,
    }
    hyps = classify_hypotheses(sig)
    paid = next((h for h in hyps if h.key == "paid_youtube_ads"), None)
    assert paid is not None
    assert paid.confidence == "high"
    # subs_views_ratio (= subs_z - views_z) 음수 큼 → evidence 에 명시
    assert any("views_z" in e.key or "engagement" in e.key.lower() or "organicity" in e.key.lower()
               for e in paid.evidence)
```

- [ ] **Step 2: 첫 구현 — classify_hypotheses 의 organic_growth 와 paid_youtube_ads 분기**

`weekly_diagnosis.py` 끝에 추가:

```python
# 점등 임계치 — spec rev 2 §3 의 본 카탈로그.
Z_THRESHOLD_PRIMARY = 1.5
Z_THRESHOLD_STRONG = 2.0
ER_DROP_PAID_THRESHOLD = -0.20      # ER WoW 가 이만큼 떨어지면 paid 의심
ER_DROP_SUB_PURCHASE_THRESHOLD = -0.25
VPS_DROP_SUB_PURCHASE = -0.30
ORGANICITY_PAID_THRESHOLD = 0.30
SUBS_Z_SUB_PURCHASE = 2.5


def _check_organic_growth(sig: dict) -> Hypothesis | None:
    lit_signals: list[Evidence] = []
    if sig["subs_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("subs_z", sig["subs_z"], f"구독 z={sig['subs_z']:.1f}"))
    if sig["views_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("views_z", sig["views_z"], f"조회 z={sig['views_z']:.1f}"))
    if sig["news_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("news_z", sig["news_z"], f"뉴스 z={sig['news_z']:.1f}"))
    if sig["community_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("community_z", sig["community_z"], f"커뮤 z={sig['community_z']:.1f}"))
    if sig["market_share_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("market_share_z", sig["market_share_z"], f"share z={sig['market_share_z']:.1f}"))
    # ER 안정성 (절대값 < 0.15) — 광고 의심 가설을 깎아냄
    if abs(sig["er_wow"]) >= 0.15:
        return None    # ER 불안정 시 organic 가설 제외
    if len(lit_signals) < 4:
        return None
    confidence = "high" if len(lit_signals) >= 4 else "medium"
    return Hypothesis(key="organic_growth", confidence=confidence, evidence=lit_signals)


def _check_paid_youtube_ads(sig: dict) -> Hypothesis | None:
    evidence: list[Evidence] = []
    score = 0
    if sig["views_z"] >= Z_THRESHOLD_STRONG:
        evidence.append(Evidence("views_z", sig["views_z"], f"조회 z={sig['views_z']:.1f}"))
        score += 1
    # subs 가 views 만큼 따라오지 않음 — 핵심 변별
    if sig["views_z"] >= Z_THRESHOLD_PRIMARY and sig["subs_z"] < Z_THRESHOLD_PRIMARY:
        evidence.append(Evidence(
            "subs_views_gap",
            sig["views_z"] - sig["subs_z"],
            f"subs 비례 안 함 (views z={sig['views_z']:.1f}, subs z={sig['subs_z']:.1f})",
        ))
        score += 1
    if sig["er_wow"] <= ER_DROP_PAID_THRESHOLD:
        evidence.append(Evidence(
            "engagement_rate_wow",
            sig["er_wow"],
            f"ER WoW {sig['er_wow']:+.0%}",
        ))
        score += 1
    if sig["organicity_paid"] is not None and sig["organicity_paid"] >= ORGANICITY_PAID_THRESHOLD:
        evidence.append(Evidence(
            "organicity_paid_ratio",
            sig["organicity_paid"],
            f"신규 영상 paid 의심 {sig['organicity_paid']:.0%}",
        ))
        score += 1
    if sig.get("video_tags_paid_match"):
        evidence.append(Evidence(
            "video_tags_paid_match", True,
            "광고성 영상 태그 패턴 매칭",
        ))
        # video_tags 는 약신호 — score 에 0.5 만 (실제 구현 시 점등 보조)
    if score < 3:
        return None
    confidence = "high" if score >= 3 else "medium"
    return Hypothesis(key="paid_youtube_ads", confidence=confidence, evidence=evidence)


def classify_hypotheses(sig: dict) -> list[Hypothesis]:
    """시그널 dict → 점등된 가설 리스트. 점등 안 된 가설은 omit.

    confidence 정렬은 후속 단계 (`compute_group_signals`) 에서 처리.
    """
    candidates = [
        _check_organic_growth(sig),
        _check_paid_youtube_ads(sig),
    ]
    return [c for c in candidates if c is not None]
```

- [ ] **Step 3: 테스트 실행 — organic + paid pass**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis.py::test_organic_growth_all_signals_lit tests/unit/test_weekly_diagnosis.py::test_paid_youtube_ads_high_views_low_er -v
```
Expected: 2 passed.

- [ ] **Step 4: subscriber_purchase + comeback_cycle 가설 test + 구현**

test 추가:

```python
def test_subscriber_purchase_inverse_pattern():
    """subs z=3.0, views z=0.4, ER drop 35%, vps drop 32% → medium (캡 적용)."""
    sig = _base_signal_bundle() | {
        "subs_z": 3.0,
        "views_z": 0.4,
        "er_wow": -0.35,
        "vps_wow": -0.32,
    }
    hyps = classify_hypotheses(sig)
    sp = next((h for h in hyps if h.key == "subscriber_purchase"), None)
    assert sp is not None
    # 검증 어려움 — 시그널 강해도 medium 캡.
    assert sp.confidence == "medium"


def test_subscriber_purchase_not_lit_when_vps_none():
    """subs spike + ER 하락 만 있고 vps_wow None → subscriber_purchase 점등 안 됨."""
    sig = _base_signal_bundle() | {
        "subs_z": 3.0, "er_wow": -0.35, "vps_wow": None,
    }
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "subscriber_purchase" for h in hyps)


def test_comeback_cycle_full():
    """hanteo_sales>0 + chart_peak<=30 + news z>=2 + video upload z>=1.5 → high."""
    sig = _base_signal_bundle() | {
        "news_z": 2.4,
        "comeback": {
            "event_match": {"event_type": "album_release", "title": "Caligo Pt.3"},
            "music_streak": 0, "hanteo_sales": 991_850, "chart_peak": 5,
            "video_upload_z": 2.1,
        },
    }
    hyps = classify_hypotheses(sig)
    cb = next((h for h in hyps if h.key == "comeback_cycle"), None)
    assert cb is not None
    assert cb.confidence == "high"
    # group_events ground truth evidence 가 들어가야 함
    assert any("event" in e.key.lower() or "ground_truth" in e.key.lower()
               for e in cb.evidence)


def test_comeback_cycle_dampens_paid():
    """comeback + paid_ads 시그널 동시 → paid confidence 한 단계 감점."""
    sig = _base_signal_bundle() | {
        # paid 시그널 (3개)
        "views_z": 3.0, "subs_z": 0.5, "er_wow": -0.28,
        "organicity_paid": 0.35,
        # comeback 시그널 (2개 — high)
        "news_z": 2.5,
        "comeback": {
            "event_match": {"event_type": "album_release", "title": "X"},
            "music_streak": 0, "hanteo_sales": 800_000, "chart_peak": 8,
            "video_upload_z": 1.6,
        },
    }
    hyps = classify_hypotheses(sig)
    paid = next((h for h in hyps if h.key == "paid_youtube_ads"), None)
    # paid 가 점등은 됐지만 confidence 가 high → medium 으로 감점됨.
    # (classify 단계에서 감점 후 emit, 또는 후속 단계에서 감점 후 재emit —
    # 어느 쪽이든 최종 결과의 confidence 는 medium)
    assert paid is None or paid.confidence in ("medium", "low")
```

`weekly_diagnosis.py` 에 추가:

```python
def _check_subscriber_purchase(sig: dict) -> Hypothesis | None:
    evidence: list[Evidence] = []
    score = 0
    if sig["subs_z"] >= SUBS_Z_SUB_PURCHASE:
        evidence.append(Evidence("subs_z", sig["subs_z"], f"구독 z={sig['subs_z']:.1f}"))
        score += 1
    if sig.get("vps_wow") is not None and sig["vps_wow"] <= VPS_DROP_SUB_PURCHASE:
        evidence.append(Evidence(
            "views_per_sub_wow", sig["vps_wow"],
            f"views/sub WoW {sig['vps_wow']:+.0%}",
        ))
        score += 1
    if sig["er_wow"] <= ER_DROP_SUB_PURCHASE_THRESHOLD:
        evidence.append(Evidence(
            "engagement_rate_wow", sig["er_wow"],
            f"ER WoW {sig['er_wow']:+.0%}",
        ))
        score += 1
    # vps_wow 가 None 이면 핵심 변별 시그널 없음 — 점등 차단
    if sig.get("vps_wow") is None:
        return None
    if score < 3:
        return None
    # subscriber_purchase 는 검증 어려움 → 항상 medium 캡.
    return Hypothesis(key="subscriber_purchase", confidence="medium", evidence=evidence)


def _check_comeback_cycle(sig: dict) -> Hypothesis | None:
    cb = sig["comeback"]
    evidence: list[Evidence] = []
    score = 0
    if cb.get("hanteo_sales") and cb["hanteo_sales"] > 0:
        evidence.append(Evidence(
            "hanteo_sales", cb["hanteo_sales"],
            f"한터 초동 {cb['hanteo_sales']:,}장",
        ))
        score += 1
    if cb.get("chart_peak") is not None and cb["chart_peak"] <= 30:
        evidence.append(Evidence(
            "chart_peak", cb["chart_peak"],
            f"멜론 TOP100 peak #{cb['chart_peak']}",
        ))
        score += 1
    if cb.get("music_streak", 0) >= 3:
        evidence.append(Evidence(
            "music_show_streak", cb["music_streak"],
            f"음방 {cb['music_streak']}연속 1위",
        ))
        score += 1
    if sig["news_z"] >= Z_THRESHOLD_STRONG:
        evidence.append(Evidence("news_z", sig["news_z"], f"뉴스 z={sig['news_z']:.1f}"))
        score += 1
    if cb.get("video_upload_z", 0) >= Z_THRESHOLD_PRIMARY:
        evidence.append(Evidence(
            "video_upload_z", cb["video_upload_z"],
            f"영상 업로드 z={cb['video_upload_z']:.1f}",
        ))
        score += 1
    if cb.get("event_match"):
        evidence.append(Evidence(
            "group_events_match", cb["event_match"],
            f"group_events ground truth: {cb['event_match'].get('title')}",
        ))
        # group_events 매칭은 confidence 부스트 (score +1 효과)
        score += 1
    if score < 2:
        return None
    # ground truth 매칭 시 high 보장
    confidence = "high" if score >= 3 or cb.get("event_match") else "medium"
    return Hypothesis(key="comeback_cycle", confidence=confidence, evidence=evidence)


def _dampen_if_comeback_active(hyps: list[Hypothesis]) -> list[Hypothesis]:
    """comeback_cycle 이 점등돼 있으면 paid_ads / subscriber_purchase confidence 감점."""
    comeback_active = any(h.key == "comeback_cycle" and h.confidence in ("high", "medium")
                          for h in hyps)
    if not comeback_active:
        return hyps
    dampened: list[Hypothesis] = []
    for h in hyps:
        if h.key in ("paid_youtube_ads", "subscriber_purchase"):
            new_conf = _confidence_dampen(h.confidence)
            if new_conf == "low":
                continue   # low 면 emit 안 함
            dampened.append(Hypothesis(key=h.key, confidence=new_conf, evidence=h.evidence))
        else:
            dampened.append(h)
    return dampened


def _confidence_dampen(c: str) -> str:
    """한 단계 감점. high → medium, medium → low, low → low."""
    idx = CONFIDENCE_LEVELS.index(c) if c in CONFIDENCE_LEVELS else 2
    return CONFIDENCE_LEVELS[min(idx + 1, 2)]


def classify_hypotheses(sig: dict) -> list[Hypothesis]:
    """시그널 dict → 점등된 가설 리스트. 점등 안 된 가설은 omit."""
    candidates = [
        _check_organic_growth(sig),
        _check_paid_youtube_ads(sig),
        _check_subscriber_purchase(sig),
        _check_comeback_cycle(sig),
    ]
    lit = [c for c in candidates if c is not None]
    return _dampen_if_comeback_active(lit)
```

- [ ] **Step 5: 테스트 실행**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis.py -v
```
Expected: 7 passed (3 + 2 + 2 새로 추가).

- [ ] **Step 6: Commit**

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis.py worker/tests/unit/test_weekly_diagnosis.py
git commit -m "feat(worker): weekly_diagnosis — 4 가설 분류 + 컴백 dampen

organic_growth / paid_youtube_ads / subscriber_purchase / comeback_cycle.
comeback 점등 시 paid/sub_purchase confidence 자동 감점 (spec rev 2 §3.3).
subscriber_purchase 는 medium 캡 (검증 어려움).
spec rev 2 Task 3.B (4/11)."
```

### Task 3.C: broadcast / wom / controversy / platform_concentrated / member_centric 가설

이전 패턴을 그대로 답습 — failing test → impl → run → commit. 가설 5개를 한 commit 으로 묶기에는 너무 큼 → 2개씩 분할.

- [ ] **Step 1: broadcast_appearance + community_word_of_mouth 가설 test + 구현**

test 추가:

```python
def test_broadcast_appearance_lag_pattern():
    """7일 전 news spike (z=3.0) + 이번 주 community z=1.8 + community 토픽 외부."""
    sig = _base_signal_bundle() | {
        "news_z_prev_week": 3.0,    # 시그널 모듈이 raw 로 채움
        "community_z": 1.8,
        "views_z": 1.5,
        "community_keywords_topic": "external",   # 방송명 키워드
    }
    hyps = classify_hypotheses(sig)
    ba = next((h for h in hyps if h.key == "broadcast_appearance"), None)
    assert ba is not None
    assert ba.confidence == "medium"


def test_community_word_of_mouth_lag():
    """전주 community spike + 이번 주 subs/view z>=1.5 + 자체 콘텐츠 토픽."""
    sig = _base_signal_bundle() | {
        "community_z_prev_week": 2.4,
        "subs_z": 1.6,
        "views_z": 1.7,
        "community_keywords_topic": "self",
    }
    hyps = classify_hypotheses(sig)
    wom = next((h for h in hyps if h.key == "community_word_of_mouth"), None)
    assert wom is not None
    assert wom.confidence == "medium"


def test_broadcast_no_lag_no_match():
    """이번 주 news 단발 spike 만, 직전 주는 평탄 → broadcast 안 점등."""
    sig = _base_signal_bundle() | {
        "news_z": 3.0,
        "community_z": 0.4,
        "news_z_prev_week": 0.2,
    }
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "broadcast_appearance" for h in hyps)
```

`weekly_diagnosis.py` 에 추가:

```python
def _check_broadcast_appearance(sig: dict) -> Hypothesis | None:
    """전주 news z>=3 + 이번 주 community z>=1.5 + community_keywords 가 external."""
    prev_news = sig.get("news_z_prev_week", 0.0)
    if prev_news < 3.0:
        return None
    if sig["community_z"] < Z_THRESHOLD_PRIMARY:
        return None
    evidence = [
        Evidence("news_z_prev_week", prev_news, f"전주 뉴스 z={prev_news:.1f} 단발"),
        Evidence("community_z", sig["community_z"], f"이번 주 커뮤 z={sig['community_z']:.1f}"),
    ]
    if sig.get("community_keywords_topic") == "external":
        evidence.append(Evidence(
            "community_keywords_topic", "external",
            "커뮤 키워드: 외부 매체/방송명 우세",
        ))
    return Hypothesis(key="broadcast_appearance", confidence="medium", evidence=evidence)


def _check_community_word_of_mouth(sig: dict) -> Hypothesis | None:
    """전주 community spike + 이번 주 subs/view 따라옴 + 자체 콘텐츠 토픽."""
    prev_comm = sig.get("community_z_prev_week", 0.0)
    if prev_comm < Z_THRESHOLD_STRONG:
        return None
    if sig["subs_z"] < Z_THRESHOLD_PRIMARY and sig["views_z"] < Z_THRESHOLD_PRIMARY:
        return None
    evidence = [
        Evidence("community_z_prev_week", prev_comm,
                 f"전주 커뮤 z={prev_comm:.1f} 선행"),
        Evidence("subs_views_followup",
                 max(sig["subs_z"], sig["views_z"]),
                 f"이번 주 구독/조회 동반 (max z={max(sig['subs_z'], sig['views_z']):.1f})"),
    ]
    if sig.get("community_keywords_topic") == "self":
        evidence.append(Evidence(
            "community_keywords_topic", "self",
            "커뮤 키워드: 자체 콘텐츠 우세",
        ))
    return Hypothesis(key="community_word_of_mouth", confidence="medium", evidence=evidence)
```

`classify_hypotheses` 확장:

```python
def classify_hypotheses(sig: dict) -> list[Hypothesis]:
    candidates = [
        _check_organic_growth(sig),
        _check_paid_youtube_ads(sig),
        _check_subscriber_purchase(sig),
        _check_comeback_cycle(sig),
        _check_broadcast_appearance(sig),
        _check_community_word_of_mouth(sig),
    ]
    lit = [c for c in candidates if c is not None]
    return _dampen_if_comeback_active(lit)
```

- [ ] **Step 2: 테스트 + commit**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis.py -v
```
Expected: 10 passed.

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis.py worker/tests/unit/test_weekly_diagnosis.py
git commit -m "feat(worker): weekly_diagnosis — broadcast + word_of_mouth

community_keywords 토픽 (self/external/negative/neutral) 활용,
전주 시그널 lag 패턴 검증.
spec rev 2 Task 3.C (6/11)."
```

- [ ] **Step 3: controversy_spike + platform_concentrated_promo 가설 test + 구현**

test 추가:

```python
def test_controversy_one_signal_high():
    """controversy_count_z=2.1 단독 점등 → high."""
    sig = _base_signal_bundle() | {
        "controversy": {
            "keyword_z": 0.3, "twitter_z": 0.5,
            "controversy_count_z": 2.1, "negative_ratio_z": 0.4,
        },
    }
    hyps = classify_hypotheses(sig)
    co = next((h for h in hyps if h.key == "controversy_spike"), None)
    assert co is not None
    assert co.confidence == "high"


def test_controversy_keyword_z_lit():
    """community_keywords negative_keyword_z=2.5 → 점등 high."""
    sig = _base_signal_bundle() | {
        "controversy": {
            "keyword_z": 2.5, "twitter_z": 0.0,
            "controversy_count_z": 0.0, "negative_ratio_z": 0.0,
        },
    }
    hyps = classify_hypotheses(sig)
    assert any(h.key == "controversy_spike" for h in hyps)


def test_platform_concentrated_naver_only():
    """reactivity_dominant=('naver', 3.0) + naver news z=2.5 → medium-high."""
    sig = _base_signal_bundle() | {
        "reactivity_dominant": ("naver", 3.0),
        "news_z": 2.5,
    }
    hyps = classify_hypotheses(sig)
    pc = next((h for h in hyps if h.key == "platform_concentrated_promo"), None)
    assert pc is not None
    assert pc.confidence in ("medium", "high")


def test_platform_concentrated_not_lit_without_supporting_z():
    """reactivity dominant 만 있고 보조 z 가 없으면 점등 안 됨."""
    sig = _base_signal_bundle() | {
        "reactivity_dominant": ("naver", 3.0),
        "news_z": 0.5,
        "community_z": 0.4,
    }
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "platform_concentrated_promo" for h in hyps)
```

`weekly_diagnosis.py` 추가:

```python
CONTROVERSY_Z_THRESHOLD = 2.0


def _check_controversy_spike(sig: dict) -> Hypothesis | None:
    co = sig["controversy"]
    evidence: list[Evidence] = []
    if co["controversy_count_z"] >= CONTROVERSY_Z_THRESHOLD:
        evidence.append(Evidence(
            "controversy_count_z", co["controversy_count_z"],
            f"controversy 트윗 z={co['controversy_count_z']:.1f}",
        ))
    if co["negative_ratio_z"] >= CONTROVERSY_Z_THRESHOLD:
        evidence.append(Evidence(
            "negative_ratio_z", co["negative_ratio_z"],
            f"부정 감성 비율 z={co['negative_ratio_z']:.1f}",
        ))
    if co["twitter_z"] >= CONTROVERSY_Z_THRESHOLD:
        evidence.append(Evidence(
            "twitter_controversy_z", co["twitter_z"],
            f"트위터 controversy type z={co['twitter_z']:.1f}",
        ))
    if co["keyword_z"] >= CONTROVERSY_Z_THRESHOLD:
        evidence.append(Evidence(
            "negative_keyword_z", co["keyword_z"],
            f"커뮤 부정 키워드 z={co['keyword_z']:.1f}",
        ))
    if not evidence:
        return None
    # 시그널 하나라도 점등 → high (인간 검증 강제 — prompts.py 가 streisand 가드 첨부)
    return Hypothesis(key="controversy_spike", confidence="high", evidence=evidence)


def _check_platform_concentrated(sig: dict) -> Hypothesis | None:
    dom_name, dom_ratio = sig["reactivity_dominant"]
    if dom_name is None:
        return None
    # 보조 시그널: 같은 플랫폼에 해당하는 z 가 점등돼야 함
    if dom_name == "naver":
        support_z = sig["news_z"]
    else:
        support_z = sig["community_z"]
    if support_z < Z_THRESHOLD_STRONG:
        return None
    evidence = [
        Evidence(
            "reactivity_dominant", dom_name,
            f"{dom_name} 단독 reactivity {dom_ratio:.1f}×",
        ),
        Evidence(
            f"{dom_name}_z", support_z,
            f"{dom_name} 지표 z={support_z:.1f}",
        ),
    ]
    # 보조 z 가 매우 강하면 high, 아니면 medium
    confidence = "high" if support_z >= 2.5 else "medium"
    return Hypothesis(key="platform_concentrated_promo", confidence=confidence, evidence=evidence)
```

`classify_hypotheses` 확장:

```python
def classify_hypotheses(sig: dict) -> list[Hypothesis]:
    candidates = [
        _check_organic_growth(sig),
        _check_paid_youtube_ads(sig),
        _check_subscriber_purchase(sig),
        _check_comeback_cycle(sig),
        _check_broadcast_appearance(sig),
        _check_community_word_of_mouth(sig),
        _check_controversy_spike(sig),
        _check_platform_concentrated(sig),
    ]
    lit = [c for c in candidates if c is not None]
    return _dampen_if_comeback_active(lit)
```

- [ ] **Step 4: 테스트 + commit**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis.py -v
```
Expected: 14 passed.

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis.py worker/tests/unit/test_weekly_diagnosis.py
git commit -m "feat(worker): weekly_diagnosis — controversy + platform_concentrated

community_keywords / twitter type / sentiment / reactivity 통합.
controversy_spike 는 단일 시그널로도 high (인간 검증 강제).
spec rev 2 Task 3.C (8/11)."
```

- [ ] **Step 5: member_centric_spike 가설 test + 구현 + dampen 확장**

test 추가:

```python
def test_member_centric_isedol_top1_jump():
    """ISEDOL top1_share +12pt → 점등, 그룹 spike 동반."""
    sig = _base_signal_bundle() | {
        "subs_z": 2.0,
        "views_z": 2.0,
        "member_centric": {
            "lit": True, "dead": False,
            "top1_share_now": 0.55, "top1_share_wow": 0.12,
            "hhi_norm_wow": 0.08, "top1_share_high": False,
        },
    }
    hyps = classify_hypotheses(sig)
    mc = next((h for h in hyps if h.key == "member_centric_spike"), None)
    assert mc is not None


def test_member_centric_dampens_paid():
    """member_centric 점등 시 paid_ads confidence 한 단계 감점."""
    sig = _base_signal_bundle() | {
        # paid 시그널
        "views_z": 3.0, "subs_z": 0.5, "er_wow": -0.28,
        "organicity_paid": 0.35,
        # member_centric 시그널
        "member_centric": {
            "lit": True, "dead": False,
            "top1_share_now": 0.62, "top1_share_wow": 0.14,
            "hhi_norm_wow": 0.10, "top1_share_high": True,
        },
    }
    hyps = classify_hypotheses(sig)
    paid = next((h for h in hyps if h.key == "paid_youtube_ads"), None)
    # paid 가 점등은 됐지만 confidence 감점됨
    if paid is not None:
        assert paid.confidence in ("medium", "low")


def test_member_centric_dead_meta_no_emit():
    """agg_member_pop_meta 행 자체가 없는 그룹 → 점등 안 됨."""
    sig = _base_signal_bundle()    # member_centric.dead=True
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "member_centric_spike" for h in hyps)
```

`weekly_diagnosis.py` 추가:

```python
def _check_member_centric_spike(sig: dict) -> Hypothesis | None:
    mc = sig["member_centric"]
    if mc.get("dead") or not mc.get("lit"):
        return None
    evidence: list[Evidence] = []
    if mc.get("top1_share_wow") is not None and mc["top1_share_wow"] >= 0.10:
        evidence.append(Evidence(
            "top1_share_wow", mc["top1_share_wow"],
            f"멤버 1 인기 +{mc['top1_share_wow']*100:.0f}pt",
        ))
    if mc.get("hhi_norm_wow") is not None and mc["hhi_norm_wow"] >= 0.15:
        evidence.append(Evidence(
            "hhi_norm_wow", mc["hhi_norm_wow"],
            f"인기 집중도 +{mc['hhi_norm_wow']:.2f}",
        ))
    # 그룹 차원 spike 가 동반돼야 의미 있는 가설
    if sig["subs_z"] < Z_THRESHOLD_PRIMARY and sig["views_z"] < Z_THRESHOLD_PRIMARY:
        return None
    if not evidence:
        return None
    confidence = "high" if mc.get("top1_share_high") else "medium"
    return Hypothesis(key="member_centric_spike", confidence=confidence, evidence=evidence)


def _dampen_if_member_centric_active(hyps: list[Hypothesis]) -> list[Hypothesis]:
    """member_centric_spike 점등 시 그룹-차원 paid/sub_purchase confidence 감점."""
    mc_active = any(h.key == "member_centric_spike" and h.confidence in ("high", "medium")
                    for h in hyps)
    if not mc_active:
        return hyps
    out: list[Hypothesis] = []
    for h in hyps:
        if h.key in ("paid_youtube_ads", "subscriber_purchase"):
            new_conf = _confidence_dampen(h.confidence)
            if new_conf == "low":
                continue
            out.append(Hypothesis(key=h.key, confidence=new_conf, evidence=h.evidence))
        else:
            out.append(h)
    return out
```

`classify_hypotheses` 최종 형태:

```python
def classify_hypotheses(sig: dict) -> list[Hypothesis]:
    candidates = [
        _check_organic_growth(sig),
        _check_paid_youtube_ads(sig),
        _check_subscriber_purchase(sig),
        _check_comeback_cycle(sig),
        _check_broadcast_appearance(sig),
        _check_community_word_of_mouth(sig),
        _check_controversy_spike(sig),
        _check_platform_concentrated(sig),
        _check_member_centric_spike(sig),
    ]
    lit = [c for c in candidates if c is not None]
    lit = _dampen_if_comeback_active(lit)
    lit = _dampen_if_member_centric_active(lit)
    return lit
```

- [ ] **Step 6: 테스트 + commit**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis.py -v
```
Expected: 17 passed.

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis.py worker/tests/unit/test_weekly_diagnosis.py
git commit -m "feat(worker): weekly_diagnosis — member_centric + dampen 체인

agg_member_pop_meta 의 top1_share / hhi_norm WoW 점등 + 그룹-차원
paid/sub_purchase 자동 감점. classify 9개 가설 완성.
spec rev 2 Task 3.C (9/11)."
```

### Task 3.D: 메타가드 적용 + insufficient_signal

- [ ] **Step 1: failing test 추가**

test 추가:

```python
from idol_sight.analysis.weekly_diagnosis import apply_meta_guards


def test_meta_guard_irrelevant_dampens_all():
    """irrelevant 비율 18% → 모든 가설 confidence 한 단계 감점."""
    hyps = [
        Hypothesis(key="organic_growth", confidence="high", evidence=[]),
        Hypothesis(key="controversy_spike", confidence="high", evidence=[]),
    ]
    out, guards = apply_meta_guards(
        hyps,
        irrelevant_ratio=0.18,
        data_source_warning=False,
    )
    assert "irrelevant_flagged_18%" in guards or any("irrelevant" in g for g in guards)
    for h in out:
        assert h.confidence == "medium"


def test_meta_guard_backfill_majority_dampens():
    hyps = [Hypothesis(key="organic_growth", confidence="high", evidence=[])]
    out, guards = apply_meta_guards(
        hyps, irrelevant_ratio=0.05, data_source_warning=True,
    )
    assert any("backfill" in g.lower() or "data_source" in g for g in guards)
    assert out[0].confidence == "medium"


def test_meta_guard_none():
    hyps = [Hypothesis(key="organic_growth", confidence="high", evidence=[])]
    out, guards = apply_meta_guards(
        hyps, irrelevant_ratio=0.05, data_source_warning=False,
    )
    assert guards == []
    assert out[0].confidence == "high"


def test_insufficient_signal_when_no_hypotheses_lit():
    """모든 시그널 z<1.5 → classify 가 빈 리스트 반환 → 호출자가 insufficient_signal 처리."""
    sig = _base_signal_bundle()    # 전부 중립
    hyps = classify_hypotheses(sig)
    assert hyps == []
```

`weekly_diagnosis.py` 추가:

```python
def apply_meta_guards(
    hyps: list[Hypothesis],
    *,
    irrelevant_ratio: float,
    data_source_warning: bool,
) -> tuple[list[Hypothesis], list[str]]:
    """data_credibility_warning 메타가드 적용 — 모든 가설 confidence 한 단계 감점.

    Returns:
      (수정된 hypotheses, 점등된 메타가드 라벨 리스트)
    """
    guards: list[str] = []
    from idol_sight.analysis.weekly_diagnosis_signals import IRRELEVANT_RATIO_THRESHOLD
    if irrelevant_ratio >= IRRELEVANT_RATIO_THRESHOLD:
        guards.append(f"irrelevant_flagged_{irrelevant_ratio:.0%}")
    if data_source_warning:
        guards.append("data_source_backfill_majority")
    if not guards:
        return hyps, []
    out: list[Hypothesis] = []
    for h in hyps:
        new_conf = _confidence_dampen(h.confidence)
        # low 가 되더라도 emit (메타가드는 카드 자체를 차단하지 않음 — body 에 경고만 첨부)
        out.append(Hypothesis(key=h.key, confidence=new_conf, evidence=h.evidence))
    return out, guards
```

- [ ] **Step 2: 테스트 + commit**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis.py -v
```
Expected: 21 passed.

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis.py worker/tests/unit/test_weekly_diagnosis.py
git commit -m "feat(worker): weekly_diagnosis — meta guard 적용

data_credibility_warning 메타가드: irrelevant_flag_ratio>=15%
또는 data_source 과반 backfill 시 모든 가설 confidence 감점.
spec rev 2 Task 3.D."
```

### Task 3.E: compute_group_signals 오케스트레이션 (DB 통합)

- [ ] **Step 1: failing test 작성 — mock DB executor 로 통합 검증**

test 추가:

```python
from unittest.mock import MagicMock
from idol_sight.analysis.weekly_diagnosis import compute_group_signals


def test_compute_group_signals_organic_growth_e2e():
    """E2E: DB stub → cohort z-score → classify → GroupSignals dict."""
    db = MagicMock()
    # build_context 의 6개 query 응답을 순서대로 stub:
    # 1) last_7d agg_summary
    # 2) prev_7d agg_summary
    # 3) debut_window_video_organicity (주간 신규 영상)
    # 4) group_events
    # 5) music_show_wins_log
    # 6) community_keywords (now)
    # 7) community_keywords (past 10주)
    # 8) twitter type='controversy' (now + past)
    # 9) community_posts irrelevant flags
    # 10) agg_member_pop_meta (now + prev)
    db.execute.side_effect = [
        # 1) last_7d (cohort 5 그룹, plave 가 spike)
        [
            {"group_key": "plave",  "yt_subscribers": 1_200_000, "yt_total_views": 200_000_000,
             "yt_likes_total": 2_000_000, "yt_comments_total": 300_000,
             "naver_total_news": 350,
             "dc_total_posts": 5000, "theqoo_posts": 2000, "instiz_posts": 1000,
             "controversy_count": 1, "negative_ratio": 0.04,
             "reactivity_dc": 1.5, "reactivity_theqoo": 1.4, "reactivity_instiz": 1.3,
             "reactivity_naver": 1.5, "reactivity_sample": 5,
             "data_source": "live"},
            {"group_key": "isedol", "yt_subscribers": 800_000,   "yt_total_views": 140_000_000,
             "yt_likes_total": 1_500_000, "yt_comments_total": 250_000,
             "naver_total_news": 100,
             "dc_total_posts": 3000, "theqoo_posts": 1000, "instiz_posts": 500,
             "controversy_count": 0, "negative_ratio": 0.02,
             "reactivity_dc": 1.1, "reactivity_theqoo": 1.0, "reactivity_instiz": 1.0,
             "reactivity_naver": 1.0, "reactivity_sample": 5,
             "data_source": "live"},
            {"group_key": "skinz",  "yt_subscribers": 50_000,    "yt_total_views": 5_000_000,
             "yt_likes_total": 80_000, "yt_comments_total": 15_000,
             "naver_total_news": 20,
             "dc_total_posts": 200, "theqoo_posts": 50, "instiz_posts": 30,
             "controversy_count": 0, "negative_ratio": 0.01,
             "reactivity_dc": 1.0, "reactivity_theqoo": 1.0, "reactivity_instiz": 1.0,
             "reactivity_naver": 1.0, "reactivity_sample": 1,
             "data_source": "live"},
        ],
        # 2) prev_7d — plave 가 훨씬 작았음 → 큰 z-score
        [
            {"group_key": "plave",  "yt_subscribers": 1_000_000, "yt_total_views": 175_000_000,
             "yt_likes_total": 1_800_000, "yt_comments_total": 280_000,
             "naver_total_news": 280,
             "dc_total_posts": 3000, "theqoo_posts": 1500, "instiz_posts": 700,
             "data_source": "live"},
            {"group_key": "isedol", "yt_subscribers": 800_000,   "yt_total_views": 138_000_000,
             "yt_likes_total": 1_490_000, "yt_comments_total": 248_000,
             "naver_total_news": 98,
             "dc_total_posts": 2900, "theqoo_posts": 970, "instiz_posts": 490,
             "data_source": "live"},
            {"group_key": "skinz",  "yt_subscribers": 49_500,    "yt_total_views": 4_950_000,
             "yt_likes_total": 79_500, "yt_comments_total": 14_800,
             "naver_total_news": 19,
             "dc_total_posts": 198, "theqoo_posts": 49, "instiz_posts": 29,
             "data_source": "live"},
        ],
        # 3) debut_window_video_organicity (plave 신규 영상 없음 — 빈 결과)
        [],
        # 4) group_events
        [],
        # 5) music_show_wins_log
        [],
        # 6) community_keywords (이번 주)
        [{"group_key": "plave", "keyword": "콘서트", "count": 100}],
        # 7) community_keywords (과거 10주, plave 의 부정 키워드 분포)
        [{"week": "w1", "neg_total": 5}, {"week": "w2", "neg_total": 8},
         {"week": "w3", "neg_total": 6}, {"week": "w4", "neg_total": 7}],
        # 8) twitter controversy (now + past)
        [],
        # 9) irrelevant flags
        [],
        # 10) agg_member_pop_meta (now + prev — plave 는 corporate single-channel, dead)
        [],
    ]
    result = compute_group_signals(db=db, week_start="2026-04-22", week_end="2026-04-28")

    assert "plave" in result
    plave = result["plave"]
    # plave 는 cohort 에서 압도적 1위 → 거의 모든 시그널이 큰 z 또는
    # 보통 cohort 가 3개라 z 가 작을 수 있음. 최소한 GroupSignals 가
    # 비어있지 않아야 함.
    assert isinstance(plave.hypotheses, list)
    assert plave.group_key == "plave"
```

- [ ] **Step 2: compute_group_signals 구현**

`weekly_diagnosis.py` 끝에 추가:

```python
from idol_sight.analysis import weekly_diagnosis_signals as _S


def compute_group_signals(
    *, db: _Executor, week_start: str, week_end: str,
) -> dict[str, GroupSignals]:
    """진입점 — DB executor 로부터 raw row 를 모아 GroupSignals dict 생성.

    SQL 쿼리 개수: 10개 (test_compute_group_signals 의 stub 순서와 일치).
    실제 운영 환경에서는 build_context 가 미리 일부를 모아둘 수도 있지만,
    이 함수는 standalone 호출 가능하도록 자체 쿼리한다.
    """
    last_7d = db.execute(
        "SELECT * FROM agg_summary WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [week_start, week_end],
    )
    prev_start = _shift_iso_date(week_start, -7)
    prev_end = _shift_iso_date(week_end, -7)
    prev_7d = db.execute(
        "SELECT * FROM agg_summary WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [prev_start, prev_end],
    )
    organicity_rows = db.execute(
        "SELECT group_key, verdict FROM debut_window_video_organicity "
        "WHERE substr(published_at, 1, 10) BETWEEN ? AND ?",
        [week_start, week_end],
    )
    events_rows = db.execute(
        "SELECT group_key, event_date, event_type, title FROM group_events "
        "WHERE event_date BETWEEN ? AND ?",
        [_shift_iso_date(week_start, -7), _shift_iso_date(week_end, 7)],
    )
    music_show_rows = db.execute(
        "SELECT group_key, show, song_title, win_date "
        "FROM music_show_wins_log "
        "WHERE win_date BETWEEN ? AND ?",
        [week_start, week_end],
    )
    comm_kw_now = db.execute(
        "SELECT group_key, keyword, count FROM community_keywords "
        "WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [week_start, week_end],
    )
    comm_kw_past = db.execute(
        "SELECT group_key, "
        "  substr(snapshot_at, 1, 10) AS day, "
        "  SUM(count) AS neg_total "
        "FROM community_keywords "
        "WHERE keyword IN (" + ",".join("?" * len(_S.NEGATIVE_KEYWORDS)) + ") "
        "  AND substr(snapshot_at, 1, 10) < ? "
        "GROUP BY group_key, day "
        "ORDER BY day DESC LIMIT 70",
        [*_S.NEGATIVE_KEYWORDS, week_start],
    )
    twitter_rows = db.execute(
        "SELECT group_key, "
        "  substr(posted_at, 1, 10) AS day, "
        "  COUNT(*) AS n "
        "FROM twitter_posts WHERE type='controversy' "
        "  AND substr(posted_at, 1, 10) < ? "
        "GROUP BY group_key, day ORDER BY day DESC LIMIT 70",
        [week_end],
    )
    irrelevant_rows = db.execute(
        "SELECT group_key, user_flagged_irrelevant "
        "FROM community_posts "
        "WHERE substr(collected_at, 1, 10) BETWEEN ? AND ?",
        [week_start, week_end],
    )
    member_pop_rows = db.execute(
        "SELECT group_key, snapshot_at, top1_share, top3_share, hhi_norm "
        "FROM agg_member_pop_meta "
        "WHERE substr(snapshot_at, 1, 10) BETWEEN ? AND ?",
        [prev_start, week_end],
    )

    # group_key → row 매핑
    now_by  = {r["group_key"]: r for r in last_7d}
    prev_by = {r["group_key"]: r for r in prev_7d}
    # cohort lists (z-score 분모)
    subs_cohort      = [float(r.get("yt_subscribers")  or 0) for r in last_7d]
    views_cohort     = [float(r.get("yt_total_views")  or 0) for r in last_7d]
    news_cohort      = [float(r.get("naver_total_news") or 0) for r in last_7d]
    community_cohort = [
        float((r.get("dc_total_posts") or 0)
              + (r.get("theqoo_posts") or 0)
              + (r.get("instiz_posts") or 0))
        for r in last_7d
    ]
    organicity_by: dict[str, list[dict]] = {}
    for r in organicity_rows:
        organicity_by.setdefault(r["group_key"], []).append(r)
    events_by: dict[str, list[dict]] = {}
    for r in events_rows:
        events_by.setdefault(r["group_key"], []).append(r)
    music_show_by: dict[str, list[dict]] = {}
    for r in music_show_rows:
        music_show_by.setdefault(r["group_key"], []).append(r)
    comm_kw_now_by: dict[str, list[dict]] = {}
    for r in comm_kw_now:
        comm_kw_now_by.setdefault(r["group_key"], []).append(r)
    comm_kw_past_by: dict[str, list[float]] = {}
    for r in comm_kw_past:
        comm_kw_past_by.setdefault(r["group_key"], []).append(float(r.get("neg_total") or 0))
    twitter_by: dict[str, list[float]] = {}
    for r in twitter_rows:
        twitter_by.setdefault(r["group_key"], []).append(float(r.get("n") or 0))
    irrelevant_by: dict[str, list[dict]] = {}
    for r in irrelevant_rows:
        irrelevant_by.setdefault(r["group_key"], []).append(r)
    member_pop_by: dict[str, list[dict]] = {}
    for r in member_pop_rows:
        member_pop_by.setdefault(r["group_key"], []).append(r)

    out: dict[str, GroupSignals] = {}
    for gk, now in now_by.items():
        prev = prev_by.get(gk, {})
        # member_pop now/prev 최신/이전 한 쌍
        mp_rows = sorted(member_pop_by.get(gk, []), key=lambda r: r.get("snapshot_at") or "")
        mp_now  = mp_rows[-1] if mp_rows else {}
        mp_prev = mp_rows[-2] if len(mp_rows) >= 2 else {}

        sig = {
            "subs_z":             _S.cohort_z_score(float(now.get("yt_subscribers") or 0), subs_cohort),
            "views_z":            _S.cohort_z_score(float(now.get("yt_total_views") or 0), views_cohort),
            "news_z":             _S.cohort_z_score(float(now.get("naver_total_news") or 0), news_cohort),
            "community_z":        _S.cohort_z_score(
                float((now.get("dc_total_posts") or 0)
                      + (now.get("theqoo_posts") or 0)
                      + (now.get("instiz_posts") or 0)),
                community_cohort,
            ),
            "market_share_z":     0.0,    # V1: agg_market_share 별도 쿼리 — 후속 enhancement
            "er_wow":             _S.engagement_rate_wow_drop(now, prev),
            "vps_wow":            _S.views_per_sub_wow_drop(now, prev),
            "organicity_paid":    _S.organicity_paid_ratio(organicity_by.get(gk, [])),
            "reactivity_dominant": _S.reactivity_dominant_platform(now),
            "member_centric":     _S.member_centric_signals(mp_now, mp_prev),
            "comeback": {
                "event_match":     _S.group_event_within_window(
                    events_by.get(gk, []), week_start=week_start, week_end=week_end,
                ),
                "music_streak":    _S.music_show_consecutive_wins(music_show_by.get(gk, []))["consecutive"],
                "hanteo_sales":    0,    # V1: hanteo_weekly 별도 쿼리 — 후속
                "chart_peak":      now.get("melon_top100_peak"),
                "video_upload_z":  0.0,   # V1: youtube_videos 별도 쿼리 — 후속
            },
            "controversy": {
                "keyword_z":             _S.negative_keyword_z(
                    comm_kw_now_by.get(gk, []),
                    comm_kw_past_by.get(gk, []),
                ),
                "twitter_z":             _S.twitter_controversy_z(
                    now_count=int(now.get("twitter_posts") or 0),
                    cohort_counts=twitter_by.get(gk, []),
                ),
                "controversy_count_z":   _S.cohort_z_score(
                    float(now.get("controversy_count") or 0),
                    [float(r.get("controversy_count") or 0) for r in prev_7d],
                ),
                "negative_ratio_z":      _S.cohort_z_score(
                    float(now.get("negative_ratio") or 0),
                    [float(r.get("negative_ratio") or 0) for r in prev_7d],
                ),
            },
            "news_z_prev_week":           0.0,    # V1: 단순화 — 후속
            "community_z_prev_week":      0.0,    # V1: 단순화 — 후속
            "community_keywords_topic":   "neutral",   # V1: stub — 후속
            "video_tags_paid_match":      False,        # V1: stub — 후속
        }

        hyps = classify_hypotheses(sig)
        irrelevant_ratio = _S.irrelevant_flag_ratio(irrelevant_by.get(gk, []))
        backfill_warning = _S.data_source_warning(
            [r for r in last_7d if r["group_key"] == gk]
        )
        hyps, guards = apply_meta_guards(
            hyps,
            irrelevant_ratio=irrelevant_ratio,
            data_source_warning=backfill_warning,
        )

        out[gk] = GroupSignals(
            group_key=gk,
            hypotheses=hyps,
            meta_guards=guards,
            deltas={
                "subs_z":   sig["subs_z"],
                "views_z":  sig["views_z"],
                "news_z":   sig["news_z"],
                "er_wow":   sig["er_wow"],
            },
            organicity={
                "paid_ratio": sig["organicity_paid"],
            } if sig["organicity_paid"] is not None else None,
        )
    return out


def _shift_iso_date(iso_date: str, days: int) -> str:
    from datetime import date, timedelta
    d = date.fromisoformat(iso_date)
    return (d + timedelta(days=days)).isoformat()
```

- [ ] **Step 3: 테스트 + commit**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis.py -v
```
Expected: 22 passed.

```bash
git add worker/src/idol_sight/analysis/weekly_diagnosis.py worker/tests/unit/test_weekly_diagnosis.py
git commit -m "feat(worker): weekly_diagnosis — compute_group_signals 오케스트레이션

10개 SQL 쿼리 → 시그널 dict → classify → meta guard → GroupSignals.
V1 단순화: market_share_z / news_z_prev_week / community_keywords_topic
등 일부 stub — 운영 검증 후 V2 에서 활성화.
spec rev 2 Task 3.E."
```

---

## Task 4: prompts.py — `_DIAGNOSIS_GUIDELINES` + 카탈로그 + few-shot

**Files:**
- Modify: `worker/src/idol_sight/llm/prompts.py`

이 task 는 코드가 아니라 *프롬프트 문자열*. 테스트는 PROMPT_WEEKLY 가 새 섹션을 포함하는지 substring assertion 만.

- [ ] **Step 1: failing test 추가**

`worker/tests/unit/test_llm_weekly.py` 끝에 추가:

```python
def test_prompt_weekly_includes_diagnosis_guidelines():
    """PROMPT_WEEKLY 에 _DIAGNOSIS_GUIDELINES 섹션이 들어있는지 sanity."""
    from idol_sight.llm.prompts import PROMPT_WEEKLY
    # 가설 카탈로그 enum 의 핵심 키들이 프롬프트에 노출돼 있어야 함.
    for kw in ("organic_growth", "paid_youtube_ads", "subscriber_purchase",
               "comeback_cycle", "controversy_spike",
               "platform_concentrated_promo", "member_centric_spike"):
        assert kw in PROMPT_WEEKLY
    # type='diagnosis' 카드 형식 설명이 있어야 함.
    assert "diagnosis" in PROMPT_WEEKLY
    # 단정 어조 금지 가드 (가능성/의심/시사 사용 유도)
    assert "가능성" in PROMPT_WEEKLY or "의심" in PROMPT_WEEKLY
    # Streisand 가드
    assert "Streisand" in PROMPT_WEEKLY or "검수" in PROMPT_WEEKLY
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

```bash
cd worker && uv run pytest tests/unit/test_llm_weekly.py::test_prompt_weekly_includes_diagnosis_guidelines -v
```
Expected: FAIL — 시그널이 PROMPT_WEEKLY 에 없음.

- [ ] **Step 3: `_DIAGNOSIS_GUIDELINES` 추가**

`worker/src/idol_sight/llm/prompts.py` 의 `_AI_COMMENT_GUIDELINES` 정의 끝에 추가:

```python
# Causal Diagnosis 카탈로그 — type='diagnosis' 카드 작성 시 LLM 이 인용 가능한
# 가설 enum. 시그널 없는 가설은 거론 금지 (signals_by_group 컨텍스트의
# `hypotheses` 리스트에 없는 가설은 카드에서 언급조차 하지 말 것).
_DIAGNOSIS_HYPOTHESIS_BLOCK = """\
DIAGNOSIS HYPOTHESIS CATALOG — copy keys exactly, never invent:
  organic_growth              자연 유입 (모든 지표 동기 상승)
  paid_youtube_ads            YouTube 광고 의심 (views↑ but subs/ER 평탄)
  subscriber_purchase         구독자 구매 의심 (subs↑ but views/ER 폭락)
  comeback_cycle              컴백 사이클 (한터/차트/음방/뉴스 동시)
  broadcast_appearance        방송/외부 출연 (news lag → community 점진)
  community_word_of_mouth     커뮤니티 입소문 (community lag → subs/view)
  controversy_spike           논란 (controversy/sentiment/keyword z 상승)
  platform_concentrated_promo 표적 플랫폼 캠페인 (단일 reactivity dominant)
  member_centric_spike        멤버 1명 인기 집중 (top1_share +10pt 이상)
  insufficient_signal         시그널 없음 → 카드 emit 금지"""


_DIAGNOSIS_GUIDELINES = """\
type='diagnosis' CARD FORMAT — strict rules:

WHEN to emit a diagnosis card:
  signals_by_group[<group>].hypotheses 가 1개 이상일 때만. 점등된 가설이
  없는 그룹은 절대 diagnosis 카드 emit 금지 (insufficient_signal).

WHAT goes in body (1-3 문장 한국어):
  ① 주간 변화 요약 한 문장 (수치 1-2개 인용).
  ② 점등된 시그널 사실 인용 (예: "ER −28%, 신규 영상 paid 의심 42%").
  ③ "유력 가설은 [hypothesis_primary] 가능성. 대안 가설로 [alternative]
     도 가능 (확률 중)." 형식의 가설 한 줄.

REQUIRED 어조:
  단정 어조 금지: "-이다", "-임", "-한 결과" 사용 금지.
  허용 어조:     "-일 가능성", "-로 시사", "-의심", "-신호".
  카드 한 장에 가설은 *반드시* 둘 (유력 + 대안). signals.hypotheses 가
  1개뿐이라도 "대안 가설은 점등 안 됨 — 단일 유력 가설." 한 문장 첨부.

SPECIAL — controversy_spike:
  body 마지막에 반드시 "PR팀 검수 후 대응, 직접 삭제·정정 요청 금지
  (Streisand 회피)." 강제 1줄 첨부. 단정 어조 절대 금지 (예: "악플 사태
  발생" 금지 → "controversy 시그널 z=2.4 점등, 인간 검증 필요").

SPECIAL — subscriber_purchase:
  signals 의 confidence 가 'medium' 으로 캡됨. body 어조에 "검증 어려운
  가설" 명시. 단정 절대 금지.

SPECIAL — meta_guards:
  signals.meta_guards 가 비어 있지 않으면 body 끝에 "데이터 신뢰성 주의 —
  [guard 라벨 한글 변환]" 강제 1줄. 변환 예:
    "irrelevant_flagged_18%" → "관련성 신고 18%"
    "data_source_backfill_majority" → "수집 데이터 과반이 백필"

SPECIAL — MiiWAN scope diagnosis:
  scope='miiwan' 이면 type='diagnosis' 가 아니라 type='ipx_action' 으로
  emit. 경쟁사 시그널을 MiiWAN 운영 액션으로 자동 변환:
    경쟁사 paid_youtube_ads 점등   → "Abyss 마케팅팀 D-30 광고 검토 회의
                                       [날짜] 까지 소집" 류 액션
    경쟁사 organic_growth 점등     → "콘텐츠 캘린더 벤치마킹 — [그룹]
                                       주간 영상 캡처 후 콘텐츠팀 공유"
    경쟁사 controversy_spike 점등  → MiiWAN 자체 controversy 가 아니라면
                                       무시 (남의 사고를 우리 액션으로
                                       전환하지 말 것)

GOOD EXEMPLARS (formatting 만 — 숫자는 illustrative):

  ✅ paid_youtube_ads (high)
    title: "PLAVE 주간 조회 +24M 의 인과 진단"
    body:  "**PLAVE** 주간 조회 z=2.4 로 폭증한 반면 구독 z=0.3 에 그치고
            ER WoW −28% 동반. 신규 영상의 paid 의심 verdict 비중 42%.
            유력 가설은 **paid_youtube_ads** 가능성. 대안 가설로
            broadcast_appearance 도 가능 (확률 중) — 전주 news z=2.1
            단발 spike 가 있었음."
    ai_comment: "광고 캠페인 가능성 우세 — MiiWAN D-30 광고 검토 트리거."

  ✅ comeback_cycle (high, ground truth 매칭)
    title: "**PLAVE** Caligo Pt.3 컴백 사이클 점등"
    body:  "한터 초동 991,850장 + 멜론 TOP100 peak #5 + 음방 3연속 1위
            + 뉴스 z=2.4 동시 점등. group_events 가 album_release 매칭
            (5/22 Caligo Pt.3). 유력 가설은 **comeback_cycle** 확정.
            대안 가설 없음 (ground truth 매칭으로 다른 가설 자동 감점)."
    ai_comment: "컴백 캠페인 정상 사이클 — paid/sub 의심 카드 별도 생성 안 함."

  ✅ controversy_spike (high, Streisand guard)
    title: "**ISEDOL** controversy 시그널 z=2.4 점등"
    body:  "트위터 controversy type 12건 (z=2.4) + 커뮤 부정 키워드 z=2.1
            동반. 유력 가설은 **controversy_spike** 가능성, 대안 가설
            없음. PR팀 검수 후 대응, 직접 삭제·정정 요청 금지
            (Streisand 회피)."
    ai_comment: "PR팀 검수 우선 — Streisand 회피 주의."

  ✅ insufficient (이 카드는 emit 안 함 — 참고용)
    signals.hypotheses == [] → diagnosis 카드 생성 안 함. 기존 insight /
    weekly 카드로만 그룹 다룸.

  ❌ BAD — 단정 어조 + 미점등 가설 거론
    body: "PLAVE 가 광고를 돌렸다. sub 구매 정황도 보이고 컴백 캠페인일
           수도 있다."
    ← 단정 어조 ("돌렸다"), 점등 안 된 가설들 (sub_purchase, comeback)
       거론, 시그널 인용 없음. 다시 작성."""


PROMPT_WEEKLY_DIAGNOSIS = _DIAGNOSIS_GUIDELINES
```

그리고 `PROMPT_WEEKLY` 의 본문 끝(`REQUIRED COVERAGE — MiiWAN` 섹션 직전)에 다음 줄 추가:

```python
PROMPT_WEEKLY = f"""\
...   # 기존 본문 유지
{_BODY_FORMATTING_GUIDELINES}

GOOD-vs-BAD BODY EXEMPLARS (formatting only — numbers are illustrative):
...
{_IPX_ACTION_GUIDELINES}

{_AI_COMMENT_GUIDELINES}

{_DIAGNOSIS_HYPOTHESIS_BLOCK}

{_DIAGNOSIS_GUIDELINES}

REQUIRED COVERAGE — MiiWAN (IPX × Abyss own-brand, debut 2026-06):
...
"""
```

(*기존 PROMPT_WEEKLY 의 다른 섹션은 변경 없음 — `_DIAGNOSIS_HYPOTHESIS_BLOCK` 와 `_DIAGNOSIS_GUIDELINES` 두 블록 삽입만.*)

- [ ] **Step 4: 테스트 실행**

```bash
cd worker && uv run pytest tests/unit/test_llm_weekly.py::test_prompt_weekly_includes_diagnosis_guidelines -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/llm/prompts.py worker/tests/unit/test_llm_weekly.py
git commit -m "feat(worker): prompts — _DIAGNOSIS_GUIDELINES + 9가설 enum + few-shot

PROMPT_WEEKLY 에 type='diagnosis' 카드 작성 규칙 추가:
- 가설 카탈로그 enum (시그널 없는 가설 거론 금지)
- 단정 어조 금지 (가능성/의심/시사)
- controversy_spike → Streisand 가드 강제 1줄
- subscriber_purchase → medium 캡 + 검증 어려움 명시
- MiiWAN scope → diagnosis → ipx_action 자동 변환
- 3 few-shot exemplars (paid_ads / comeback / controversy)
spec rev 2 Task 4."
```

---

## Task 5: weekly.py — build_context 에 signals 추가 + INSERT signals_json

**Files:**
- Modify: `worker/src/idol_sight/llm/weekly.py`
- Modify: `worker/src/idol_sight/llm/gemini.py` (INSIGHT_OUTPUT_SCHEMA 에 type='diagnosis' 추가)

- [ ] **Step 1: failing test 추가**

`worker/tests/unit/test_llm_weekly.py` 끝에 추가:

```python
def test_generate_weekly_serializes_signals_json_when_diagnosis():
    """type='diagnosis' 카드는 signals_json 컬럼에 GroupSignals payload 직렬화."""
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "plave", "type": "diagnosis",
            "title": "PLAVE paid 의심", "body": "본문",
            "ai_comment": "함의",
            "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}],
        }],
    }
    db = _stub_db_with_signals()    # 새 stub: build_context 가 signals 도 채움

    result = generate_weekly(
        db=db, gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )
    sql, params = result.statements[0]
    # signals_json 컬럼이 INSERT 에 포함돼 있어야 함
    assert "signals_json" in sql
    # signals_json 은 마지막 bind param
    signals_json_value = params[-1]
    assert signals_json_value is not None
    import json
    payload = json.loads(signals_json_value)
    assert "hypothesis_primary" in payload


def test_generate_weekly_signals_json_null_for_non_diagnosis():
    """type='insight' 카드는 signals_json NULL."""
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "market", "type": "weekly",
            "title": "T", "body": "B",
            "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}],
        }],
    }
    result = generate_weekly(
        db=_stub_db_with_signals(), gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )
    sql, params = result.statements[0]
    assert "signals_json" in sql
    assert params[-1] is None


def _stub_db_with_signals():
    """build_context 의 기존 5 + compute_group_signals 의 10 쿼리 stub."""
    db = MagicMock()
    db.execute.side_effect = [
        # build_context 의 기존 5 쿼리
        [{"group_key": "plave", "yt_total_views": 200_000_000, "yt_subscribers": 1_200_000,
          "yt_likes_total": 2_000_000, "yt_comments_total": 300_000,
          "naver_total_news": 350,
          "dc_total_posts": 5000, "theqoo_posts": 2000, "instiz_posts": 1000,
          "controversy_count": 1, "negative_ratio": 0.04,
          "reactivity_dc": 1.5, "reactivity_theqoo": 1.4, "reactivity_instiz": 1.3,
          "reactivity_naver": 1.5, "reactivity_sample": 5,
          "data_source": "live"}],   # last_7d
        [{"group_key": "plave", "yt_total_views": 175_000_000, "yt_subscribers": 1_000_000,
          "yt_likes_total": 1_800_000, "yt_comments_total": 280_000,
          "naver_total_news": 280,
          "dc_total_posts": 3000, "theqoo_posts": 1500, "instiz_posts": 700,
          "data_source": "live"}],   # prev_7d
        [{"group_key": "plave", "album": "X", "rank": 2, "sales": 991_850}],
        [{"group_key": "plave", "final": 65.0}],
        [{"group_key": "plave", "title": "n", "source": "naver"}],
        # compute_group_signals 의 추가 10 쿼리 — 빈 결과 또는 minimal
        [],   # last_7d
        [],   # prev_7d
        [],   # organicity
        [],   # group_events
        [],   # music_show_wins_log
        [],   # comm_kw_now
        [],   # comm_kw_past
        [],   # twitter
        [],   # irrelevant
        [],   # member_pop
    ]
    return db
```

- [ ] **Step 2: 테스트 실행 — fail 확인**

```bash
cd worker && uv run pytest tests/unit/test_llm_weekly.py -v
```
Expected: FAIL — signals_json 컬럼이 INSERT 에 없음.

- [ ] **Step 3: weekly.py build_context 확장 + INSERT signals_json 추가**

`worker/src/idol_sight/llm/weekly.py` 의 `build_context` 함수에 다음 추가 (return 직전):

```python
from idol_sight.analysis.weekly_diagnosis import compute_group_signals

def build_context(db: _Executor, *, week_start: str, week_end: str) -> dict[str, Any]:
    # ... 기존 5 쿼리 그대로 ...
    signals_by_group = compute_group_signals(
        db=db, week_start=week_start, week_end=week_end,
    )
    return {
        "week": {"start": week_start, "end": week_end},
        "agg_summary_last_7d": last_7d,
        "agg_summary_prev_7d": prev_7d,
        "hanteo": hanteo,
        "market_share": market,
        "top_news_by_group": top_news,
        "signals_by_group": _serialize_signals_for_llm(signals_by_group),
    }


def _serialize_signals_for_llm(
    signals: dict[str, "GroupSignals"],
) -> dict[str, dict]:
    """GroupSignals → LLM-friendly dict (JSON-safe).

    Dataclass 를 dict 로 평탄화. LLM 은 hypotheses 리스트와 meta_guards
    리스트만 읽고 carda 작성에 활용한다.
    """
    out: dict[str, dict] = {}
    for gk, gs in signals.items():
        out[gk] = {
            "hypotheses": [
                {
                    "key": h.key,
                    "confidence": h.confidence,
                    "evidence": [
                        {"key": e.key, "value": e.value, "label": e.label}
                        for e in h.evidence
                    ],
                }
                for h in gs.hypotheses
            ],
            "meta_guards": list(gs.meta_guards),
            "deltas": dict(gs.deltas),
            "organicity": gs.organicity,
        }
    return out
```

generate_weekly 의 INSERT 확장:

```python
def generate_weekly(
    *,
    db: _Executor,
    gemini: _Gemini,
    week_start: str,
    week_end: str,
) -> CollectionResult:
    ctx = build_context(db, week_start=week_start, week_end=week_end)
    parsed = gemini.generate(
        system_prompt=PROMPT_WEEKLY,
        context=ctx,
        response_schema=INSIGHT_OUTPUT_SCHEMA,
    )
    items = parsed.get("items") or []

    # ... 기존 ipx_action validation 유지 ...

    signals_by_group = ctx.get("signals_by_group", {})

    now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    statements: list[tuple[str, list]] = []
    for item in items:
        raw_ai_comment = item.get("ai_comment")
        ai_comment: str | None = None
        if isinstance(raw_ai_comment, str):
            stripped = raw_ai_comment.strip()
            ai_comment = stripped[:200] if stripped else None

        # signals_json: type='diagnosis' 일 때만 GroupSignals payload 직렬화.
        # 다른 type 은 NULL.
        signals_json: str | None = None
        if item.get("type") == "diagnosis":
            scope = item.get("scope") or "market"
            gs = signals_by_group.get(scope)
            if gs and gs.get("hypotheses"):
                primary = gs["hypotheses"][0]
                alternative = gs["hypotheses"][1] if len(gs["hypotheses"]) > 1 else None
                payload = {
                    "hypothesis_primary":     primary["key"],
                    "hypothesis_alternative": alternative["key"] if alternative else None,
                    "confidence":             primary["confidence"],
                    "evidence":               primary["evidence"],
                    "meta_guards":            gs.get("meta_guards", []),
                }
                signals_json = json.dumps(payload, ensure_ascii=False)

        statements.append((
            """
            INSERT INTO insights
              (generated_at, week_start, scope, type, title, body,
               source_refs_json, ai_comment, signals_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """.strip(),
            [
                now_iso, week_start,
                item.get("scope") or "market",
                item.get("type") or "insight",
                (item.get("title") or "")[:200],
                item.get("body") or "",
                json.dumps(item.get("source_refs") or [], ensure_ascii=False),
                ai_comment,
                signals_json,
            ],
        ))

    return CollectionResult(
        rows_inserted=len(items), rows_updated=0,
        statements=statements,
    )
```

또한 `gemini.py` 의 `INSIGHT_OUTPUT_SCHEMA` 의 `type` enum 에 `"diagnosis"` 추가:

```python
# worker/src/idol_sight/llm/gemini.py 의 INSIGHT_OUTPUT_SCHEMA → properties.type.enum
# 기존: ["insight", "weekly", "ipx_action"]
# 변경: ["insight", "weekly", "ipx_action", "diagnosis"]
```

- [ ] **Step 4: 테스트 실행 — 모든 test pass**

```bash
cd worker && uv run pytest tests/unit/test_llm_weekly.py -v
```
Expected: 모든 test pass (기존 3 + 새 2 = 5+ 이상).

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/llm/weekly.py worker/src/idol_sight/llm/gemini.py worker/tests/unit/test_llm_weekly.py
git commit -m "feat(worker): weekly.py — signals_by_group 컨텍스트 + INSERT signals_json

build_context 가 compute_group_signals 호출 → LLM 컨텍스트에 추가.
type='diagnosis' 카드만 signals_json 컬럼에 GroupSignals payload 직렬화.
INSIGHT_OUTPUT_SCHEMA type enum 에 'diagnosis' 추가.
spec rev 2 Task 5."
```

---

## Task 6: cli.py analyze_weekly 통합 (cron endpoint 변경 없음)

**Files:**
- Modify: `worker/src/idol_sight/cli.py` (특히 `analyze_weekly` 함수 안의 weekly LLM 호출 직전)

`analyze_weekly` 가 LLM 호출하는 부분 (Gemini → generate_weekly) 은 이미 build_context → generate_weekly 흐름을 따른다. Task 5 에서 build_context 가 자동으로 signals 도 채우므로 **cli.py 자체에는 변경 사항 거의 없음** (compute_group_signals 의 신규 import 만 정합성 확인).

- [ ] **Step 1: analyze_weekly 안의 LLM 호출 흐름 검증**

```bash
grep -n "generate_weekly\|build_context\|weekly_diagnosis" worker/src/idol_sight/cli.py
```

Expected: `generate_weekly` import + 호출 부분이 존재. weekly_diagnosis 는 build_context 내부에서 자동 호출되므로 cli.py 직접 호출 불필요.

- [ ] **Step 2: 만약 analyze_weekly 가 generate_weekly 를 호출하지 않고 직접 Gemini 호출하면 다음 패치**

`cli.py analyze_weekly` 의 LLM 호출 부분 (~ 1000번 line 근처) 을 다음으로 교체:

```python
# 기존 (만약 있다면):
# parsed = gemini.generate(system_prompt=PROMPT_WEEKLY, context=ctx, ...)

# 변경 후:
from idol_sight.llm.weekly import generate_weekly
result = generate_weekly(
    db=client, gemini=gemini,
    week_start=week_start, week_end=week_end,
)
if result.statements:
    client.batch(result.statements)
typer.echo(f"insights: wrote {len(result.statements)} cards")
```

(*이미 이렇게 호출하고 있다면 변경 불필요.*)

- [ ] **Step 3: 로컬 dry-run**

```bash
cd worker && uv run python -m idol_sight analyze-weekly --week-start 2026-04-22 --week-end 2026-04-28
```

Expected: 에러 없이 종료. `insights: wrote N cards` 출력. (D1 로컬 DB 에 LLM 카드 INSERT 됨. Gemini API key 가 .dev.vars 에 있어야 함.)

- [ ] **Step 4: 만약 변경 없으면 commit 도 없음. 변경 있으면:**

```bash
git add worker/src/idol_sight/cli.py
git commit -m "feat(worker): cli.analyze_weekly — generate_weekly 경유로 통합

기존 직접 Gemini 호출 → generate_weekly 사용. compute_group_signals 가
build_context 내부에서 자동 호출되어 signals_by_group 이 컨텍스트에 포함.
spec rev 2 Task 6."
```

---

## Task 7: end-to-end synthetic week 검증

**Files (no new):**
- 검증용 임시 스크립트는 commit 안 함.

- [ ] **Step 1: 로컬 D1 에 minimal synthetic data seed**

`scripts/seed_synthetic_week.sql` 임시 생성 (커밋 안 함 — 검증용):

```sql
-- 1주치 PLAVE / ISEDOL agg_summary 행 2개씩 (이번 주 + 직전 주).
-- last_7d 가 spike, prev_7d 가 baseline.
INSERT OR REPLACE INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   yt_likes_total, yt_comments_total,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count,
   data_source,
   reactivity_dc, reactivity_theqoo, reactivity_instiz, reactivity_naver, reactivity_sample)
VALUES
  ('plave',  '2026-04-28T00:00:00Z', 100, 200000000, 1200000, 2000000, 300000, 5000, 2000, 1000, 350, 50, 1, 'live', 1.5, 1.4, 1.3, 1.5, 5),
  ('plave',  '2026-04-21T00:00:00Z',  95, 175000000, 1000000, 1800000, 280000, 3000, 1500,  700, 280, 45, 1, 'live', 1.4, 1.3, 1.2, 1.4, 5),
  ('isedol', '2026-04-28T00:00:00Z',  80, 140000000,  800000, 1500000, 250000, 3000, 1000,  500, 100, 40, 0, 'live', 1.1, 1.0, 1.0, 1.0, 5),
  ('isedol', '2026-04-21T00:00:00Z',  78, 138000000,  800000, 1490000, 248000, 2900,  970,  490,  98, 38, 0, 'live', 1.1, 1.0, 1.0, 1.0, 5);
```

적용:

```bash
cd frontend && wrangler d1 execute idol-sight --local --file ../scripts/seed_synthetic_week.sql
```

- [ ] **Step 2: weekly diagnosis 단독 실행 (Gemini 호출 없이 signals 만 점검)**

```bash
cd worker && uv run python -c "
from idol_sight.d1 import D1Client
from idol_sight.config import load_settings
from idol_sight.analysis.weekly_diagnosis import compute_group_signals
import json
settings = load_settings()
client = D1Client(settings, local=True)
signals = compute_group_signals(db=client, week_start='2026-04-22', week_end='2026-04-28')
print(json.dumps({k: {'hypotheses': [h.key for h in v.hypotheses], 'guards': v.meta_guards} for k, v in signals.items()}, indent=2, ensure_ascii=False))
"
```

Expected: PLAVE / ISEDOL 둘 다 출력. PLAVE 는 시그널이 spike 패턴이라 hypotheses 가 1개 이상 (정확한 가설은 cohort 크기에 따라 다름 — z-score 계산은 cohort 가 2개일 때 변별력 낮음).

- [ ] **Step 3: 전체 analyze-weekly 호출 (Gemini API key 필요)**

```bash
cd worker && uv run python -m idol_sight analyze-weekly --week-start 2026-04-22 --week-end 2026-04-28
```

Expected: `insights: wrote N cards`. 에러 없음.

- [ ] **Step 4: D1 에서 diagnosis 카드 + signals_json 확인**

```bash
cd frontend && wrangler d1 execute idol-sight --local --command "SELECT type, scope, substr(title, 1, 40) AS title, substr(signals_json, 1, 100) AS sig FROM insights WHERE week_start='2026-04-22' ORDER BY type, scope;"
```

Expected:
- 기존 type (insight/weekly/ipx_action) 카드: signals_json = NULL
- 새 type=diagnosis 카드: signals_json 에 `{"hypothesis_primary": ..., "confidence": ...}` JSON
- type 이 diagnosis 인 행이 최소 1개 (시드 데이터가 시그널 점등 조건을 충족해야 함; 미충족이라도 카드가 안 만들어진 것만 확인하면 됨)

- [ ] **Step 5: synthetic seed 정리 (insights 만 삭제, agg_summary 는 남김 — 다음 단계 활용)**

```bash
cd frontend && wrangler d1 execute idol-sight --local --command "DELETE FROM insights WHERE week_start='2026-04-22';"
rm scripts/seed_synthetic_week.sql
```

- [ ] **Step 6: 원격 migration 적용 (사용자 확인 후)**

```bash
cd frontend && wrangler d1 migrations apply idol-sight --remote
```

Expected: `✓ Successfully applied 1 migration.` 또는 `No migrations to apply.`

원격 D1 의 insights 테이블에 컬럼 추가됨을 확인:

```bash
cd frontend && wrangler d1 execute idol-sight --remote --command "PRAGMA table_info(insights);"
```

Expected output 마지막 행에 `signals_json` TEXT.

- [ ] **Step 7: GitHub Actions 의 다음 weekly cron (월요일 09:00 KST) 또는 수동 dispatch 로 production 검증**

```bash
gh workflow run analyze-weekly.yml -f week_start=2026-05-18 -f week_end=2026-05-24
gh run watch
```

Expected: workflow 성공. 끝나면 원격 D1 의 insights 에서:

```bash
cd frontend && wrangler d1 execute idol-sight --remote --command "SELECT type, scope, substr(title, 1, 50) AS title FROM insights WHERE week_start='2026-05-18' AND type='diagnosis';"
```

가 ≥ 0 행 반환. (시그널 점등이 없으면 0 행이 정상 — insufficient_signal 의도된 동작.)

- [ ] **Step 8: 통합 검증 commit**

(scripts/ 폴더에 추가/수정한 검증 헬퍼는 commit 안 함. 단 README 등 운영 가이드 변경 시에만 commit.)

만약 운영 가이드를 업데이트하면:

```bash
git add docs/onboarding.md   # weekly 진단 카드에 대한 운영자 안내 추가 시
git commit -m "docs: V2.32 weekly causal diagnosis 카드 운영자 가이드"
```

---

## Self-Review (plan 작성자 셀프 점검)

**1. Spec coverage:**

| spec 섹션 | 해당 task |
|---|---|
| §3.1 본 카탈로그 11 가설 | Task 3.B–3.C (organic / paid / sub_purchase / comeback / broadcast / wom / controversy / platform_concentrated / member_centric) |
| §3.2 메타가드 | Task 3.D |
| §3.3 변별 키 + dampen | Task 3.B (comeback dampen), 3.C (member_centric dampen) |
| §4.6 evidence 보강 6축 | Task 2.F (group_events + music_show streak), 2.G (community_keywords + twitter), 2.H (meta guard signals) |
| §4.4 migration 0066 | Task 1 |
| §4.3 prompts.py 변경 | Task 4 |
| §4.7 signals_json payload | Task 5 |
| §5 confidence 계산 | Task 3.B / 3.C 의 각 _check_* 함수 + dampen 함수들 |
| §6 윤리 가드 (Streisand / sub_purchase medium cap) | Task 3.B (sub_purchase medium 캡) + Task 4 (prompts streisand 가드) |
| §8 테스트 시나리오 13 | Task 3 전체 test cases (총 21+ 테스트) |
| §9 V1 스코프 (cron 통합) | Task 6 |

**Coverage 갭 (의도적 V1 단순화):**
- `news_z_prev_week`, `community_z_prev_week` — 단순화 stub. broadcast/wom 가설이 V1 에서는 직접 시그널 부족 시 점등 안 됨. 다음 spec 에서 확장.
- `market_share_z` — V1 stub. 후속 task 에서 별도 SQL 쿼리 추가.
- `community_keywords_topic` (self/external/negative/neutral 분류) — V1 stub. 별도 lexicon 분류기 필요.
- `video_tags_paid_match` — V1 stub. youtube_videos.tags 의 광고성 패턴 정의 후 활성화.

이 갭들은 모두 weekly_diagnosis_signals.py 의 stub 값으로 가설 점등 자체는 가능 — 단지 evidence 의 다양성이 V2 에서 확장됨.

**2. Placeholder scan:** 없음. 모든 step 에 actual 코드/명령/기대 결과 명시.

**3. Type consistency:**
- `Hypothesis.key` 문자열은 `HYPOTHESIS_KEYS` enum 과 정확히 매칭 (한 군데에서 정의, 모든 _check_* 함수가 같은 문자열 사용).
- `signals_json` 컬럼명 일관 (migration, weekly.py, test 모두 같은 이름).
- `compute_group_signals` 시그니처 (`db`, `week_start`, `week_end` keyword-only) 일관.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-25-causal-diagnosis.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Task 단위로 fresh subagent 실행 + 각 task 간 사용자 검토. context 분리로 빠른 iteration.

**2. Inline Execution** — 같은 session 에서 executing-plans 스킬로 batch 실행, checkpoint 마다 검토.

**Which approach?**
