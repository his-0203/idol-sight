# Debut Window Organicity 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 9개 그룹의 데뷔 ±60일 윈도우 내 YouTube 영상(롱폼/숏폼)에 대해 engagement 기반 organic_score(0–100)를 계산하여 organic / suspect / likely_paid / insufficient_data 로 판별, 대시보드 3곳(Market Overview KPI / GroupContent 영상 테이블 / MiiWAN Briefing 비교 차트)에 표시.

**Architecture:** worker(Python) 분석 모듈이 일일 aggregate 파이프라인 안에서 `youtube_videos` + `youtube_video_stats` 의 최신 누적값을 읽어 5개 시간 버킷별로 영상을 분류·점수화한다. 결과는 D1의 두 신규 테이블(`debut_window_video_organicity` 영상별, `debut_window_organicity_summary` 그룹×버킷 집계)에 저장된다. Frontend는 Cloudflare Pages Functions API를 거쳐 결과를 가져와 Preact 컴포넌트로 렌더한다.

**Tech Stack:** Python 3.12 + Typer + httpx + Cloudflare D1 / TypeScript + Preact + Vite + Pages Functions / SQLite-flavored SQL (D1).

**Reference spec:** `docs/superpowers/specs/2026-05-12-debut-window-organicity-design.md`

---

## File Structure

신규 또는 수정 대상 파일:

| 경로 | 분류 | 책임 |
|---|---|---|
| `migrations/0052_debut_window_organicity.sql` | new | 두 신규 테이블 + 인덱스 |
| `worker/src/idol_sight/analysis/debut_window.py` | new | bucket 분류, 3개 sub-score, composite, build_* 두 함수 |
| `worker/tests/unit/test_debut_window.py` | new | 위 모듈 단위 테스트 |
| `worker/src/idol_sight/cli.py` | modify | `_run_aggregate` 의 `if not skip_derived:` 안쪽에 debut_window 단계 추가 |
| `worker/tests/unit/test_cli_aggregate.py` | modify | skip_derived 분기에서 debut_window 호출 안 됨 검증 추가 |
| `frontend/functions/api/debut-window/summary.ts` | new | 그룹×버킷 집계 반환 |
| `frontend/functions/api/debut-window/videos.ts` | new | 영상 list + signal_breakdown 반환 |
| `frontend/src/api.ts` | modify | 클라이언트 함수 2개 추가 |
| `frontend/src/components/DebutWindowKPI.tsx` | new | A: 그룹 카드 KPI |
| `frontend/src/components/DebutWindowVideoTable.tsx` | new | B: 영상 테이블 |
| `frontend/src/components/DebutWindowSignalPanel.tsx` | new | B: 우측 detail panel |
| `frontend/src/components/CompetitorOrganicityBar.tsx` | new | C: 막대 비교 차트 |
| `frontend/src/views/MarketOverview.tsx` | modify | KPI 삽입 |
| `frontend/src/views/GroupContent.tsx` | modify | Debut Window 탭 추가 |
| `frontend/src/views/MiiWANBriefing.tsx` | modify | 경쟁사 비교 섹션 추가 |
| `docs/onboarding.md` | modify | 1회성 백필 절차 추가 |

---

## Task 1: DB 마이그레이션

**Files:**
- Create: `migrations/0052_debut_window_organicity.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- migrations/0052_debut_window_organicity.sql
--
-- Debut Window Organicity — 데뷔 ±60일 영상 organic vs paid-viral 분석
-- 결과를 두 테이블에 저장. 영상별 drill-down 테이블 + 그룹×버킷 집계 테이블.
--
-- 윈도우 버킷 (5개 비중복):
--   D-60   = days_relative_to_debut ∈ [-60, -31]
--   D-30   = days_relative_to_debut ∈ [-30,  -2]
--   D-Day  = days_relative_to_debut ∈ [ -1,  +1]
--   D+30   = days_relative_to_debut ∈ [ +2, +30]
--   D+60   = days_relative_to_debut ∈ [+31, +60]
--
-- verdict 값: 'organic' | 'suspect' | 'likely_paid' | 'insufficient_data'

CREATE TABLE debut_window_video_organicity (
  video_id               TEXT PRIMARY KEY,
  group_key              TEXT NOT NULL,
  is_short               INTEGER NOT NULL,
  published_at           TEXT NOT NULL,
  days_relative_to_debut INTEGER NOT NULL,
  window_bucket          TEXT NOT NULL,
  view_count             INTEGER,
  like_count             INTEGER,
  comment_count          INTEGER,
  engagement_rate        REAL,
  like_comment_ratio     REAL,
  velocity_ratio         REAL,
  organic_score          INTEGER,
  verdict                TEXT NOT NULL,
  signal_breakdown       TEXT NOT NULL,
  computed_at            TEXT NOT NULL,
  FOREIGN KEY (video_id) REFERENCES youtube_videos(video_id)
);
CREATE INDEX idx_dwo_group_bucket
  ON debut_window_video_organicity(group_key, window_bucket);

CREATE TABLE debut_window_organicity_summary (
  group_key             TEXT NOT NULL,
  window_bucket         TEXT NOT NULL,
  video_count           INTEGER NOT NULL,
  long_form_count       INTEGER NOT NULL,
  short_form_count      INTEGER NOT NULL,
  organic_score_mean    REAL,
  organic_ratio         REAL,
  suspect_ratio         REAL,
  likely_paid_ratio     REAL,
  total_views           INTEGER,
  total_engagement      INTEGER,
  computed_at           TEXT NOT NULL,
  PRIMARY KEY (group_key, window_bucket)
);
```

- [ ] **Step 2: Apply migration locally to verify SQL**

Run:
```bash
cd frontend && wrangler d1 migrations apply idol-sight --local
```
Expected: `Migration 0052_debut_window_organicity.sql executed successfully.` 또는 동등한 성공 메시지. 에러 시 SQL 문법 확인.

- [ ] **Step 3: Verify tables created in local D1**

Run:
```bash
cd frontend && wrangler d1 execute idol-sight --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'debut_window_%'"
```
Expected: 두 행 `debut_window_video_organicity`, `debut_window_organicity_summary`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0052_debut_window_organicity.sql
git commit -m "feat(db): 0052 debut window organicity migration"
```

---

## Task 2: WINDOW_BUCKETS 상수 + bucket_for 함수 (TDD)

**Files:**
- Create: `worker/src/idol_sight/analysis/debut_window.py`
- Create: `worker/tests/unit/test_debut_window.py`

- [ ] **Step 1: Write failing tests**

`worker/tests/unit/test_debut_window.py`:
```python
"""Tests for debut window organicity analysis module."""

import pytest

from idol_sight.analysis.debut_window import WINDOW_BUCKETS, bucket_for


def test_window_buckets_are_5_non_overlapping_ranges():
    """5 buckets, contiguous from -60 to +60, no overlap."""
    assert len(WINDOW_BUCKETS) == 5
    labels = [b[0] for b in WINDOW_BUCKETS]
    assert labels == ["D-60", "D-30", "D-Day", "D+30", "D+60"]
    # Ranges contiguous
    flat = []
    for _, lo, hi in WINDOW_BUCKETS:
        flat.append((lo, hi))
    assert flat == [(-60, -31), (-30, -2), (-1, 1), (2, 30), (31, 60)]


@pytest.mark.parametrize("days,expected", [
    (-60, "D-60"),
    (-45, "D-60"),
    (-31, "D-60"),
    (-30, "D-30"),
    (-2, "D-30"),
    (-1, "D-Day"),
    (0, "D-Day"),
    (1, "D-Day"),
    (2, "D+30"),
    (30, "D+30"),
    (31, "D+60"),
    (60, "D+60"),
])
def test_bucket_for_returns_correct_bucket(days, expected):
    assert bucket_for(days) == expected


@pytest.mark.parametrize("days", [-61, -100, 61, 100])
def test_bucket_for_returns_none_outside_window(days):
    assert bucket_for(days) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py -v
```
Expected: ImportError, `cannot import name 'WINDOW_BUCKETS' from 'idol_sight.analysis.debut_window'` (모듈 없음).

- [ ] **Step 3: Create module with minimum impl**

`worker/src/idol_sight/analysis/debut_window.py`:
```python
"""Debut window organicity — organic vs paid-viral classifier for YouTube
videos uploaded in the ±60 day window around each group's debut date.

See docs/superpowers/specs/2026-05-12-debut-window-organicity-design.md for
the algorithm rationale, signal weights, and verdict thresholds.
"""

from __future__ import annotations

# (label, days_lo_inclusive, days_hi_inclusive). Ranges are non-overlapping
# and contiguous from -60 (60 days before debut) to +60.
WINDOW_BUCKETS: list[tuple[str, int, int]] = [
    ("D-60",  -60, -31),
    ("D-30",  -30,  -2),
    ("D-Day",  -1,   1),
    ("D+30",   2,  30),
    ("D+60",  31,  60),
]


def bucket_for(days_relative: int) -> str | None:
    """Map a signed day offset to its bucket label, or None if out of window.

    ``days_relative`` is days from debut: negative = before, positive = after.
    """
    for label, lo, hi in WINDOW_BUCKETS:
        if lo <= days_relative <= hi:
            return label
    return None
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py -v
```
Expected: 모든 `test_window_buckets_*` 와 `test_bucket_for_*` PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/debut_window.py worker/tests/unit/test_debut_window.py
git commit -m "feat(analysis): debut_window WINDOW_BUCKETS + bucket_for"
```

---

## Task 3: compute_engagement_score (TDD)

**Files:**
- Modify: `worker/src/idol_sight/analysis/debut_window.py`
- Modify: `worker/tests/unit/test_debut_window.py`

- [ ] **Step 1: Append failing tests to test file**

Add to `worker/tests/unit/test_debut_window.py`:
```python
from idol_sight.analysis.debut_window import compute_engagement_score


@pytest.mark.parametrize("er,is_short,expected", [
    # Long-form: 0pt at 0.5%, 100pt at 5.5%
    (0.000, False, 0),     # below floor
    (0.005, False, 0),     # exact floor
    (0.030, False, 50),    # midpoint
    (0.055, False, 100),   # exact ceiling
    (0.100, False, 100),   # above ceiling clamps
    # Shorts: 0pt at 0.3%, 100pt at 3.3%
    (0.000, True, 0),
    (0.003, True, 0),
    (0.018, True, 50),
    (0.033, True, 100),
    (0.100, True, 100),
])
def test_compute_engagement_score(er, is_short, expected):
    assert compute_engagement_score(er, is_short) == expected
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_compute_engagement_score -v
```
Expected: ImportError on `compute_engagement_score`.

- [ ] **Step 3: Implement function**

Append to `worker/src/idol_sight/analysis/debut_window.py`:
```python
def compute_engagement_score(engagement_rate: float, is_short: bool) -> int:
    """0-100 score from engagement_rate. Shorts baseline lower than long-form."""
    if is_short:
        floor, ceil = 0.003, 0.033
    else:
        floor, ceil = 0.005, 0.055
    span = ceil - floor
    raw = (engagement_rate - floor) / span * 100.0
    return max(0, min(100, round(raw)))
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_compute_engagement_score -v
```
Expected: 10 PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/debut_window.py worker/tests/unit/test_debut_window.py
git commit -m "feat(analysis): debut_window compute_engagement_score"
```

---

## Task 4: compute_balance_score (TDD)

**Files:**
- Modify: `worker/src/idol_sight/analysis/debut_window.py`
- Modify: `worker/tests/unit/test_debut_window.py`

- [ ] **Step 1: Append failing tests**

Add to test file:
```python
from idol_sight.analysis.debut_window import compute_balance_score


@pytest.mark.parametrize("ratio,expected", [
    # Normal zone: 15-80 returns 100
    (15.0, 100),
    (40.0, 100),
    (80.0, 100),
    # Below 15: penalize comment-farm (slope -8 per unit)
    (14.0, 92),    # 100 - (15-14)*8 = 92
    (10.0, 60),    # 100 - (15-10)*8 = 60
    (5.0, 20),
    (0.0, 0),      # clamp floor
    # Above 80: penalize like-farm (slope -0.2 per unit)
    (81.0, 100),   # 100 - 1/5 = 99.8 → rounds to 100
    (100.0, 96),   # 100 - 20/5 = 96
    (200.0, 76),
    (500.0, 16),
    (1000.0, 0),   # clamp floor
])
def test_compute_balance_score(ratio, expected):
    assert compute_balance_score(ratio) == expected
```

- [ ] **Step 2: Verify they fail**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_compute_balance_score -v
```
Expected: ImportError on `compute_balance_score`.

- [ ] **Step 3: Implement**

Append to `debut_window.py`:
```python
def compute_balance_score(like_comment_ratio: float) -> int:
    """0-100 score. Normal K-pop ratio is 15-80; outside penalizes farms."""
    r = like_comment_ratio
    if 15.0 <= r <= 80.0:
        return 100
    if r < 15.0:
        return max(0, round(100 - (15.0 - r) * 8))
    # r > 80
    return max(0, round(100 - (r - 80.0) / 5.0))
```

- [ ] **Step 4: Verify they pass**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_compute_balance_score -v
```
Expected: 12 PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/debut_window.py worker/tests/unit/test_debut_window.py
git commit -m "feat(analysis): debut_window compute_balance_score"
```

---

## Task 5: compute_velocity_coherence (TDD)

**Files:**
- Modify: `worker/src/idol_sight/analysis/debut_window.py`
- Modify: `worker/tests/unit/test_debut_window.py`

- [ ] **Step 1: Append failing tests**

```python
from idol_sight.analysis.debut_window import compute_velocity_coherence


@pytest.mark.parametrize("velocity,er,expected", [
    # Low/None velocity = neutral (50)
    (None, 0.02, 50),
    (0.5, 0.02, 50),
    (1.4, 0.02, 50),
    # Viral velocity (≥1.5) + good engagement = real viral
    (1.5, 0.04, 100),
    (5.0, 0.05, 100),
    # Viral velocity + moderate engagement = weak suspicion
    (3.0, 0.020, 60),
    (3.0, 0.015, 60),
    # Viral velocity + dead engagement = paid burst
    (3.0, 0.010, 20),
    (10.0, 0.001, 20),
])
def test_compute_velocity_coherence(velocity, er, expected):
    assert compute_velocity_coherence(velocity, er) == expected
```

- [ ] **Step 2: Verify they fail**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_compute_velocity_coherence -v
```
Expected: ImportError.

- [ ] **Step 3: Implement**

Append:
```python
def compute_velocity_coherence(
    velocity_ratio: float | None,
    engagement_rate: float,
) -> int:
    """Cross-check: high velocity should bring proportional engagement.

    velocity_ratio < 1.5 → neutral 50 (no virality to assess).
    velocity_ratio ≥ 1.5 + ER ≥ 3% → 100 (real viral).
    velocity_ratio ≥ 1.5 + ER ≥ 1.5% → 60 (weak suspicion).
    velocity_ratio ≥ 1.5 + ER < 1.5% → 20 (paid burst).
    """
    if velocity_ratio is None or velocity_ratio < 1.5:
        return 50
    if engagement_rate >= 0.03:
        return 100
    if engagement_rate >= 0.015:
        return 60
    return 20
```

- [ ] **Step 4: Verify they pass**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_compute_velocity_coherence -v
```
Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/debut_window.py worker/tests/unit/test_debut_window.py
git commit -m "feat(analysis): debut_window compute_velocity_coherence"
```

---

## Task 6: compute_organic_score + classify_verdict (TDD)

**Files:**
- Modify: `worker/src/idol_sight/analysis/debut_window.py`
- Modify: `worker/tests/unit/test_debut_window.py`

- [ ] **Step 1: Append failing tests**

```python
from idol_sight.analysis.debut_window import (
    compute_organic_score,
    classify_verdict,
)


def test_classify_verdict_thresholds():
    assert classify_verdict(70) == "organic"
    assert classify_verdict(85) == "organic"
    assert classify_verdict(69) == "suspect"
    assert classify_verdict(40) == "suspect"
    assert classify_verdict(39) == "likely_paid"
    assert classify_verdict(0) == "likely_paid"


def test_compute_organic_score_insufficient_data_low_views():
    """View count < 1000 AND engagement < 10 → insufficient_data, score None."""
    video = {
        "is_short": 0,
        "view_count": 500,
        "like_count": 3,
        "comment_count": 2,
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    assert score is None
    assert breakdown["verdict"] == "insufficient_data"


def test_compute_organic_score_long_form_clearly_organic():
    """High engagement, balanced ratio, no velocity signal → score ≥ 70."""
    video = {
        "is_short": 0,
        "view_count": 1_000_000,
        "like_count": 60_000,    # 6% engagement (likes+comments)/views
        "comment_count": 2_000,  # like:comment = 30 (normal zone)
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    # engagement_rate = 62000/1000000 = 0.062 → engagement_score=100
    # balance_score (30) = 100
    # velocity_coherence (None) = 50
    # composite = 0.5*100 + 0.3*100 + 0.2*50 = 90
    assert score == 90
    assert breakdown["verdict"] == "organic"
    assert breakdown["weights"] == {
        "engagement": 0.5, "balance": 0.3, "velocity": 0.2,
    }


def test_compute_organic_score_paid_burst_pattern():
    """High views, dead engagement, velocity spike → score < 40."""
    video = {
        "is_short": 0,
        "view_count": 3_000_000,
        "like_count": 18_000,    # 0.6% engagement → engagement_score=0 (≤0.5%)
        "comment_count": 200,    # like:comment = 90 → balance_score≈98
        "viral_velocity_ratio": 5.0,  # velocity spike, low ER → coherence=20
    }
    score, breakdown = compute_organic_score(video)
    # composite = 0.5*0 + 0.3*98 + 0.2*20 = 33.4 → 33
    assert score == 33
    assert breakdown["verdict"] == "likely_paid"


def test_compute_organic_score_handles_zero_view_safely():
    """Zero views shouldn't crash; falls to insufficient_data."""
    video = {
        "is_short": 0,
        "view_count": 0,
        "like_count": 0,
        "comment_count": 0,
        "viral_velocity_ratio": None,
    }
    score, breakdown = compute_organic_score(video)
    assert score is None
    assert breakdown["verdict"] == "insufficient_data"
```

- [ ] **Step 2: Verify they fail**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py -k "organic_score or classify_verdict" -v
```
Expected: ImportError on `compute_organic_score` or `classify_verdict`.

- [ ] **Step 3: Implement**

Append:
```python
WEIGHTS = {"engagement": 0.5, "balance": 0.3, "velocity": 0.2}


def classify_verdict(score: int) -> str:
    if score >= 70:
        return "organic"
    if score >= 40:
        return "suspect"
    return "likely_paid"


def compute_organic_score(video: dict) -> tuple[int | None, dict]:
    """Compute composite 0-100 score + signal breakdown for one video.

    Returns (None, breakdown_with_verdict='insufficient_data') when sample
    is too small to trust (view_count < 1000 AND engagement total < 10).
    """
    view_count = video.get("view_count") or 0
    like_count = video.get("like_count") or 0
    comment_count = video.get("comment_count") or 0
    is_short = bool(video.get("is_short"))
    velocity_ratio = video.get("viral_velocity_ratio")

    engagement_total = like_count + comment_count
    if view_count < 1000 and engagement_total < 10:
        return None, {
            "view_count": view_count,
            "engagement_total": engagement_total,
            "verdict": "insufficient_data",
        }

    safe_views = max(view_count, 1)
    safe_comments = max(comment_count, 1)
    engagement_rate = engagement_total / safe_views
    like_comment_ratio = like_count / safe_comments

    e_score = compute_engagement_score(engagement_rate, is_short)
    b_score = compute_balance_score(like_comment_ratio)
    v_score = compute_velocity_coherence(velocity_ratio, engagement_rate)

    composite = round(
        WEIGHTS["engagement"] * e_score
        + WEIGHTS["balance"]    * b_score
        + WEIGHTS["velocity"]   * v_score
    )
    verdict = classify_verdict(composite)

    breakdown = {
        "engagement_rate": round(engagement_rate, 4),
        "engagement_score": e_score,
        "like_comment_ratio": round(like_comment_ratio, 2),
        "balance_score": b_score,
        "velocity_ratio": velocity_ratio,
        "velocity_coherence_score": v_score,
        "weights": WEIGHTS,
        "verdict": verdict,
    }
    return composite, breakdown
```

- [ ] **Step 4: Verify they pass**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py -v
```
Expected: 모든 테스트 PASS (Task 2~6 누적).

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/debut_window.py worker/tests/unit/test_debut_window.py
git commit -m "feat(analysis): debut_window composite organic_score + verdict"
```

---

## Task 7: build_video_organicity — D1 read + upsert statements (TDD)

**Files:**
- Modify: `worker/src/idol_sight/analysis/debut_window.py`
- Modify: `worker/tests/unit/test_debut_window.py`

- [ ] **Step 1: Append failing test**

```python
import json
from unittest.mock import MagicMock

from idol_sight.analysis.debut_window import build_video_organicity


def _client(rows_by_sql_substring):
    """Test helper: MagicMock client whose .execute(sql) returns rows
    based on first matching substring in rows_by_sql_substring."""
    client = MagicMock()
    def _execute(sql, params=None):
        for sub, rows in rows_by_sql_substring.items():
            if sub in sql:
                return rows
        return []
    client.execute.side_effect = _execute
    return client


def test_build_video_organicity_filters_window_and_emits_upserts():
    """Reads videos in ±60 day window, scores each, returns upsert statements."""
    # Two miiwan videos: one inside D-30 window, one outside (D-90)
    client = _client({
        "FROM youtube_videos": [
            {
                "video_id": "vid_inside",
                "group_key": "miiwan",
                "is_short": 0,
                "published_at": "2026-05-12T00:00:00Z",
                "view_count": 500_000,
                "like_count": 30_000,
                "comment_count": 1_000,
                "viral_velocity_ratio": None,
                "debut_date": "2026-06-16",
            },
            {
                "video_id": "vid_outside",
                "group_key": "miiwan",
                "is_short": 0,
                "published_at": "2026-01-01T00:00:00Z",  # ~D-166
                "view_count": 100_000,
                "like_count": 5_000,
                "comment_count": 100,
                "viral_velocity_ratio": None,
                "debut_date": "2026-06-16",
            },
        ],
    })
    result = build_video_organicity(client)

    # Only the in-window video gets an upsert; out-of-window is skipped
    sqls = [s[0] for s in result.statements]
    params_list = [s[1] for s in result.statements]
    assert len(result.statements) == 1
    assert "INSERT INTO debut_window_video_organicity" in sqls[0]
    assert "ON CONFLICT(video_id) DO UPDATE" in sqls[0]
    # video_id in first param position
    assert params_list[0][0] == "vid_inside"
    # window_bucket present (D-Day since published 2026-05-12 is ~D-35 = D-30 bucket)
    # debut 2026-06-16, published 2026-05-12 → 35 days before = D-30 bucket
    assert "D-30" in params_list[0]
    # signal_breakdown is JSON
    breakdown_json = next(p for p in params_list[0] if isinstance(p, str) and p.startswith("{"))
    parsed = json.loads(breakdown_json)
    assert "engagement_score" in parsed
```

- [ ] **Step 2: Verify it fails**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_build_video_organicity_filters_window_and_emits_upserts -v
```
Expected: ImportError on `build_video_organicity`.

- [ ] **Step 3: Implement build_video_organicity**

Append to `debut_window.py`:
```python
import json
from datetime import UTC, datetime
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_FETCH_VIDEOS_SQL = """
SELECT v.video_id, v.group_key, v.is_short, v.published_at,
       v.viral_velocity_ratio,
       g.debut_date,
       s.view_count, s.like_count, s.comment_count
FROM youtube_videos v
JOIN groups g ON g.key = v.group_key
LEFT JOIN youtube_video_stats s
       ON s.video_id = v.video_id
      AND s.snapshot_at = (
            SELECT MAX(snapshot_at) FROM youtube_video_stats s2
             WHERE s2.video_id = v.video_id
          )
WHERE g.debut_date IS NOT NULL
  AND v.published_at IS NOT NULL
  AND julianday(v.published_at)
        BETWEEN julianday(g.debut_date) - 60
            AND julianday(g.debut_date) + 60
"""


_UPSERT_VIDEO_SQL = """
INSERT INTO debut_window_video_organicity
  (video_id, group_key, is_short, published_at,
   days_relative_to_debut, window_bucket,
   view_count, like_count, comment_count,
   engagement_rate, like_comment_ratio, velocity_ratio,
   organic_score, verdict, signal_breakdown, computed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(video_id) DO UPDATE SET
  group_key=excluded.group_key,
  is_short=excluded.is_short,
  published_at=excluded.published_at,
  days_relative_to_debut=excluded.days_relative_to_debut,
  window_bucket=excluded.window_bucket,
  view_count=excluded.view_count,
  like_count=excluded.like_count,
  comment_count=excluded.comment_count,
  engagement_rate=excluded.engagement_rate,
  like_comment_ratio=excluded.like_comment_ratio,
  velocity_ratio=excluded.velocity_ratio,
  organic_score=excluded.organic_score,
  verdict=excluded.verdict,
  signal_breakdown=excluded.signal_breakdown,
  computed_at=excluded.computed_at
"""


def _days_between(debut_date: str, published_at: str) -> int:
    """Return days_relative_to_debut. published_at is ISO8601 timestamp,
    debut_date is YYYY-MM-DD. Negative = before debut."""
    d_debut = datetime.fromisoformat(debut_date).date()
    d_pub = datetime.fromisoformat(published_at.replace("Z", "+00:00")).date()
    return (d_pub - d_debut).days


def build_video_organicity(client: _Executor) -> CollectionResult:
    """Score every video in each group's ±60d debut window, return upsert
    statements. Idempotent on video_id."""
    rows = client.execute(_FETCH_VIDEOS_SQL)
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    statements: list[tuple[str, list[Any]]] = []

    for r in rows:
        days_rel = _days_between(r["debut_date"], r["published_at"])
        bucket = bucket_for(days_rel)
        if bucket is None:
            continue  # outside window; defensive (SQL already filtered)

        video = {
            "is_short": r.get("is_short") or 0,
            "view_count": r.get("view_count") or 0,
            "like_count": r.get("like_count") or 0,
            "comment_count": r.get("comment_count") or 0,
            "viral_velocity_ratio": r.get("viral_velocity_ratio"),
        }
        score, breakdown = compute_organic_score(video)
        verdict = breakdown["verdict"]
        # Derived fields stored alongside for fast UI sort/filter
        view_count = video["view_count"]
        like_count = video["like_count"]
        comment_count = video["comment_count"]
        if score is None:
            engagement_rate = None
            like_comment_ratio = None
        else:
            engagement_rate = breakdown["engagement_rate"]
            like_comment_ratio = breakdown["like_comment_ratio"]

        statements.append((_UPSERT_VIDEO_SQL, [
            r["video_id"], r["group_key"], video["is_short"],
            r["published_at"], days_rel, bucket,
            view_count, like_count, comment_count,
            engagement_rate, like_comment_ratio, video["viral_velocity_ratio"],
            score, verdict, json.dumps(breakdown), now,
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
```

- [ ] **Step 4: Verify test passes**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py -v
```
Expected: 모든 테스트 (Task 2~7 누적) PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/debut_window.py worker/tests/unit/test_debut_window.py
git commit -m "feat(analysis): debut_window build_video_organicity"
```

---

## Task 8: build_summary — 그룹×버킷 집계 (TDD)

**Files:**
- Modify: `worker/src/idol_sight/analysis/debut_window.py`
- Modify: `worker/tests/unit/test_debut_window.py`

- [ ] **Step 1: Append failing test**

```python
from idol_sight.analysis.debut_window import build_summary


def test_build_summary_groups_by_bucket_with_view_weighted_mean():
    """Aggregates per (group_key, window_bucket). Excludes insufficient_data
    from ratio denominator. Score mean is view-weighted."""
    client = _client({
        "FROM debut_window_video_organicity": [
            # plave D-30: 3 videos, 2 organic + 1 likely_paid
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 0,
             "view_count": 1_000_000, "organic_score": 80, "verdict": "organic",
             "like_count": 50_000, "comment_count": 1_500},
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 0,
             "view_count": 500_000, "organic_score": 85, "verdict": "organic",
             "like_count": 30_000, "comment_count": 1_000},
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 1,
             "view_count": 2_000_000, "organic_score": 25, "verdict": "likely_paid",
             "like_count": 10_000, "comment_count": 100},
            # plave D-30: 1 insufficient_data — excluded from ratios but
            # counted in video_count (UI shows it; just doesn't skew ratios)
            {"group_key": "plave", "window_bucket": "D-30", "is_short": 0,
             "view_count": 50, "organic_score": None, "verdict": "insufficient_data",
             "like_count": 1, "comment_count": 0},
        ],
    })
    result = build_summary(client)
    sqls = [s[0] for s in result.statements]
    params_list = [s[1] for s in result.statements]
    assert len(result.statements) == 1
    assert "INSERT INTO debut_window_organicity_summary" in sqls[0]
    # Params: group_key, bucket, video_count, long_count, short_count,
    #         mean, organic_ratio, suspect_ratio, likely_ratio,
    #         total_views, total_engagement, computed_at
    p = params_list[0]
    assert p[0] == "plave"
    assert p[1] == "D-30"
    assert p[2] == 4               # total video_count
    assert p[3] == 3               # long_form_count (3 long + 1 long insufficient)
    assert p[4] == 1               # short_form_count
    # View-weighted mean over scored videos (exclude None):
    #   (80*1M + 85*0.5M + 25*2M) / (1M + 0.5M + 2M) = 172.5M / 3.5M = 49.29
    assert abs(p[5] - 49.29) < 0.5
    # Ratios over scored videos (3, excluding insufficient_data)
    assert abs(p[6] - 2/3) < 0.01  # organic_ratio
    assert abs(p[7] - 0.0) < 0.01  # suspect_ratio
    assert abs(p[8] - 1/3) < 0.01  # likely_paid_ratio
    assert p[9] == 1_000_000 + 500_000 + 2_000_000 + 50  # total_views
    assert p[10] == 50_000 + 1_500 + 30_000 + 1_000 + 10_000 + 100 + 1 + 0  # total_engagement
```

- [ ] **Step 2: Verify it fails**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_build_summary_groups_by_bucket_with_view_weighted_mean -v
```
Expected: ImportError on `build_summary`.

- [ ] **Step 3: Implement**

Append to `debut_window.py`:
```python
from collections import defaultdict


_FETCH_VIDEO_ORG_SQL = """
SELECT group_key, window_bucket, is_short,
       view_count, like_count, comment_count,
       organic_score, verdict
FROM debut_window_video_organicity
"""


_UPSERT_SUMMARY_SQL = """
INSERT INTO debut_window_organicity_summary
  (group_key, window_bucket, video_count, long_form_count, short_form_count,
   organic_score_mean, organic_ratio, suspect_ratio, likely_paid_ratio,
   total_views, total_engagement, computed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(group_key, window_bucket) DO UPDATE SET
  video_count=excluded.video_count,
  long_form_count=excluded.long_form_count,
  short_form_count=excluded.short_form_count,
  organic_score_mean=excluded.organic_score_mean,
  organic_ratio=excluded.organic_ratio,
  suspect_ratio=excluded.suspect_ratio,
  likely_paid_ratio=excluded.likely_paid_ratio,
  total_views=excluded.total_views,
  total_engagement=excluded.total_engagement,
  computed_at=excluded.computed_at
"""


def build_summary(client: _Executor) -> CollectionResult:
    """Aggregate the per-video organicity table into per-(group, bucket)
    summary rows. `insufficient_data` videos still count toward video_count
    and total_views/engagement, but are excluded from score_mean and ratio
    denominators so noise doesn't skew judgment."""
    rows = client.execute(_FETCH_VIDEO_ORG_SQL)
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        grouped[(r["group_key"], r["window_bucket"])].append(r)

    statements: list[tuple[str, list[Any]]] = []
    for (group_key, bucket), bucket_rows in grouped.items():
        scored = [r for r in bucket_rows if r.get("verdict") != "insufficient_data"]
        long_count = sum(1 for r in bucket_rows if not (r.get("is_short") or 0))
        short_count = sum(1 for r in bucket_rows if (r.get("is_short") or 0))

        if scored:
            weight_sum = sum(r.get("view_count") or 0 for r in scored)
            if weight_sum > 0:
                score_mean = sum(
                    (r["organic_score"] or 0) * (r.get("view_count") or 0)
                    for r in scored
                ) / weight_sum
            else:
                score_mean = sum(r["organic_score"] or 0 for r in scored) / len(scored)
            n = len(scored)
            organic_ratio = sum(1 for r in scored if r["verdict"] == "organic") / n
            suspect_ratio = sum(1 for r in scored if r["verdict"] == "suspect") / n
            likely_ratio = sum(1 for r in scored if r["verdict"] == "likely_paid") / n
        else:
            score_mean = None
            organic_ratio = None
            suspect_ratio = None
            likely_ratio = None

        total_views = sum((r.get("view_count") or 0) for r in bucket_rows)
        total_engagement = sum(
            (r.get("like_count") or 0) + (r.get("comment_count") or 0)
            for r in bucket_rows
        )

        statements.append((_UPSERT_SUMMARY_SQL, [
            group_key, bucket, len(bucket_rows), long_count, short_count,
            score_mean, organic_ratio, suspect_ratio, likely_ratio,
            total_views, total_engagement, now,
        ]))

    return CollectionResult(
        rows_inserted=0,
        rows_updated=len(statements),
        statements=statements,
    )
```

- [ ] **Step 4: Verify it passes**

Run:
```bash
cd worker && uv run pytest tests/unit/test_debut_window.py -v
```
Expected: All Task 2~8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/debut_window.py worker/tests/unit/test_debut_window.py
git commit -m "feat(analysis): debut_window build_summary aggregation"
```

---

## Task 9: CLI 통합 — `_run_aggregate` 안에 wire (TDD)

**Files:**
- Modify: `worker/src/idol_sight/cli.py`
- Modify: `worker/tests/unit/test_cli_aggregate.py`

- [ ] **Step 1: Extend cli_aggregate test to verify wiring**

Edit `worker/tests/unit/test_cli_aggregate.py` — add a new patch for the two new builders to both existing tests, plus a focused test:

Append to bottom of file:
```python
@patch("idol_sight.cli._recompute_health_scores", return_value=9)
@patch("idol_sight.analysis.debut_window.build_summary")
@patch("idol_sight.analysis.debut_window.build_video_organicity")
@patch("idol_sight.analysis.platform_reactivity.compute_reactivity")
@patch("idol_sight.analysis.video_velocity.compute_velocity")
@patch("idol_sight.analysis.group_combined.build_agg_group_combined")
@patch("idol_sight.analysis.agg_summary.build_agg_summary")
def test_default_runs_debut_window_stages(
    mock_summary, mock_combined, mock_velocity, mock_reactivity,
    mock_dw_video, mock_dw_summary, mock_health,
):
    mock_summary.return_value = _stub_build_result()
    mock_combined.return_value = _stub_build_result()
    mock_velocity.return_value = _stub_build_result()
    mock_reactivity.return_value = []
    mock_dw_video.return_value = _stub_build_result()
    mock_dw_summary.return_value = _stub_build_result()
    client = _make_client()

    _run_aggregate(client, snap="2026-05-12T00:00:00Z")

    mock_dw_video.assert_called_once_with(client)
    mock_dw_summary.assert_called_once_with(client)


@patch("idol_sight.cli._recompute_health_scores", return_value=9)
@patch("idol_sight.analysis.debut_window.build_summary")
@patch("idol_sight.analysis.debut_window.build_video_organicity")
@patch("idol_sight.analysis.platform_reactivity.compute_reactivity")
@patch("idol_sight.analysis.video_velocity.compute_velocity")
@patch("idol_sight.analysis.group_combined.build_agg_group_combined")
@patch("idol_sight.analysis.agg_summary.build_agg_summary")
def test_skip_derived_skips_debut_window_stages(
    mock_summary, mock_combined, mock_velocity, mock_reactivity,
    mock_dw_video, mock_dw_summary, mock_health,
):
    mock_summary.return_value = _stub_build_result()
    client = _make_client()

    _run_aggregate(client, snap="2026-05-12T00:00:00Z", skip_derived=True)

    mock_dw_video.assert_not_called()
    mock_dw_summary.assert_not_called()
```

- [ ] **Step 2: Verify the new tests fail**

Run:
```bash
cd worker && uv run pytest tests/unit/test_cli_aggregate.py -k "debut_window" -v
```
Expected: 2 tests FAIL (debut_window not yet called inside `_run_aggregate`). The mock_dw_video.assert_called_once_with(client) will fail with "not called".

- [ ] **Step 3: Wire debut_window into `_run_aggregate`**

In `worker/src/idol_sight/cli.py`, find the `if not skip_derived:` block inside `_run_aggregate` (just after platform_reactivity, before the closing of the block). After the reactivity statements, add:

```python
        # V2.20: debut window organicity. Reads ±60d videos per group, scores
        # organic vs paid-viral via 3-signal composite. Independent of melon,
        # so lives inside the skip_derived branch — 2nd aggregate skips this.
        from idol_sight.analysis.debut_window import (
            build_video_organicity,
            build_summary as build_dw_summary,
        )
        dw_video = build_video_organicity(client)
        if dw_video.statements:
            client.batch(dw_video.statements)
        typer.echo(f"debut_window_videos: wrote {len(dw_video.statements)} rows")

        dw_summary = build_dw_summary(client)
        if dw_summary.statements:
            client.batch(dw_summary.statements)
        typer.echo(f"debut_window_summary: wrote {len(dw_summary.statements)} rows")
```

- [ ] **Step 4: Verify all aggregate tests pass**

Run:
```bash
cd worker && uv run pytest tests/unit/test_cli_aggregate.py -v
```
Expected: 모든 4개 (기존 2 + 신규 2) tests PASS.

- [ ] **Step 5: Full regression test**

Run:
```bash
cd worker && uv run pytest
```
Expected: All tests pass (이전 272 + 신규 debut_window 테스트 모두).

- [ ] **Step 6: Commit**

```bash
git add worker/src/idol_sight/cli.py worker/tests/unit/test_cli_aggregate.py
git commit -m "feat(cli): wire debut_window into aggregate pipeline"
```

---

## Task 10: API endpoint — debut-window/summary

**Files:**
- Create: `frontend/functions/api/debut-window/summary.ts`

- [ ] **Step 1: Write the endpoint**

```typescript
// frontend/functions/api/debut-window/summary.ts
//
// Returns per-(group, bucket) organicity summary. Optional ?bucket=X filter.

import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

interface SummaryRow {
  group_key: string;
  window_bucket: string;
  video_count: number;
  long_form_count: number;
  short_form_count: number;
  organic_score_mean: number | null;
  organic_ratio: number | null;
  suspect_ratio: number | null;
  likely_paid_ratio: number | null;
  total_views: number;
  total_engagement: number;
  computed_at: string;
}

const VALID_BUCKETS = new Set(["D-60", "D-30", "D-Day", "D+30", "D+60"]);

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const bucket = url.searchParams.get("bucket");
  let sql = `SELECT * FROM debut_window_organicity_summary`;
  const params: string[] = [];
  if (bucket) {
    if (!VALID_BUCKETS.has(bucket)) {
      return jsonResponse({ error: "invalid bucket" }, 400);
    }
    sql += ` WHERE window_bucket = ?`;
    params.push(bucket);
  }
  sql += ` ORDER BY group_key ASC, window_bucket ASC`;
  const rows = await d1Query<SummaryRow>(env.DB, sql, params);
  return jsonResponse({ rows }, 200, {
    "Cache-Control": "public, max-age=600",
  });
};
```

- [ ] **Step 2: Verify endpoint compiles**

Run:
```bash
cd frontend && pnpm typecheck
```
Expected: No errors related to debut-window/summary.ts.

- [ ] **Step 3: Manual smoke test with local D1**

Run:
```bash
cd frontend && wrangler pages dev --local
```
In another terminal:
```bash
curl http://localhost:8788/api/debut-window/summary
```
Expected: `{"rows":[]}` (empty since no data yet locally; structure is correct).

Stop the wrangler dev server (Ctrl+C).

- [ ] **Step 4: Commit**

```bash
git add frontend/functions/api/debut-window/summary.ts
git commit -m "feat(api): /api/debut-window/summary endpoint"
```

---

## Task 11: API endpoint — debut-window/videos

**Files:**
- Create: `frontend/functions/api/debut-window/videos.ts`

- [ ] **Step 1: Write the endpoint**

```typescript
// frontend/functions/api/debut-window/videos.ts
//
// Returns videos in a (group, bucket) window with their signal_breakdown.
// Joins youtube_videos for title/published_at. Required: group, bucket.
// Optional: type=long|short|all (default all).

import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

interface VideoRow {
  video_id: string;
  title: string | null;
  is_short: number;
  published_at: string;
  days_relative_to_debut: number;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  engagement_rate: number | null;
  like_comment_ratio: number | null;
  velocity_ratio: number | null;
  organic_score: number | null;
  verdict: string;
  signal_breakdown: string;
}

const VALID_BUCKETS = new Set(["D-60", "D-30", "D-Day", "D+30", "D+60"]);

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const group = url.searchParams.get("group");
  const bucket = url.searchParams.get("bucket");
  const type = url.searchParams.get("type") ?? "all";

  if (!group) return jsonResponse({ error: "group required" }, 400);
  if (!bucket || !VALID_BUCKETS.has(bucket)) {
    return jsonResponse({ error: "valid bucket required" }, 400);
  }
  if (!["all", "long", "short"].includes(type)) {
    return jsonResponse({ error: "type must be all|long|short" }, 400);
  }

  let sql = `
    SELECT o.video_id, v.title, o.is_short, o.published_at,
           o.days_relative_to_debut,
           o.view_count, o.like_count, o.comment_count,
           o.engagement_rate, o.like_comment_ratio, o.velocity_ratio,
           o.organic_score, o.verdict, o.signal_breakdown
    FROM debut_window_video_organicity o
    LEFT JOIN youtube_videos v ON v.video_id = o.video_id
    WHERE o.group_key = ? AND o.window_bucket = ?
  `;
  const params: (string | number)[] = [group, bucket];
  if (type === "long") {
    sql += ` AND o.is_short = 0`;
  } else if (type === "short") {
    sql += ` AND o.is_short = 1`;
  }
  sql += ` ORDER BY o.days_relative_to_debut ASC, o.published_at ASC`;

  const rows = await d1Query<VideoRow>(env.DB, sql, params);
  return jsonResponse({ group, bucket, type, rows }, 200, {
    "Cache-Control": "public, max-age=600",
  });
};
```

- [ ] **Step 2: Verify typecheck**

Run:
```bash
cd frontend && pnpm typecheck
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/functions/api/debut-window/videos.ts
git commit -m "feat(api): /api/debut-window/videos endpoint"
```

---

## Task 12: Frontend api.ts — 클라이언트 함수 추가

**Files:**
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Locate the api object in api.ts**

The file exports an object like `export const api = { ... }`. Find the closing brace.

- [ ] **Step 2: Add two new functions inside the api object**

Add (in the same style as existing entries) before the closing brace:
```typescript
  debutWindowSummary: (bucket?: string) =>
    getJson<any>("/api/debut-window/summary" + (bucket ? `?bucket=${encodeURIComponent(bucket)}` : "")),
  debutWindowVideos: (group: string, bucket: string, type: "all" | "long" | "short" = "all") =>
    getJson<any>(`/api/debut-window/videos?group=${encodeURIComponent(group)}&bucket=${encodeURIComponent(bucket)}&type=${type}`),
```

- [ ] **Step 3: Typecheck**

Run:
```bash
cd frontend && pnpm typecheck
```
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api.ts
git commit -m "feat(api-client): add debutWindow{Summary,Videos} fetchers"
```

---

## Task 13: DebutWindowKPI 컴포넌트 + MarketOverview 통합

**Files:**
- Create: `frontend/src/components/DebutWindowKPI.tsx`
- Modify: `frontend/src/views/MarketOverview.tsx`

- [ ] **Step 1: Create the KPI component**

`frontend/src/components/DebutWindowKPI.tsx`:
```typescript
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

const BUCKETS = ["D-60", "D-30", "D-Day", "D+30", "D+60"] as const;

interface SummaryRow {
  group_key: string;
  window_bucket: string;
  video_count: number;
  organic_score_mean: number | null;
  organic_ratio: number | null;
  suspect_ratio: number | null;
  likely_paid_ratio: number | null;
}

interface Props {
  groupKey: string;
}

function colorForScore(score: number | null): string {
  if (score === null) return "#6b7280";   // gray
  if (score >= 70) return "#22c55e";       // organic green
  if (score >= 40) return "#eab308";       // suspect yellow
  return "#ef4444";                        // likely_paid red
}

export function DebutWindowKPI({ groupKey }: Props) {
  const [byBucket, setByBucket] = useState<Map<string, SummaryRow> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary().then((r: { rows: SummaryRow[] }) => {
      if (cancelled) return;
      const filtered = r.rows.filter((x) => x.group_key === groupKey);
      const m = new Map<string, SummaryRow>();
      for (const row of filtered) m.set(row.window_bucket, row);
      setByBucket(m);
    });
    return () => { cancelled = true; };
  }, [groupKey]);

  if (!byBucket) return <div class="kpi-debutwin loading">…</div>;

  return (
    <div class="kpi-debutwin">
      <div class="kpi-debutwin-label">Debut Window Organicity</div>
      <div class="kpi-debutwin-row">
        {BUCKETS.map((b) => {
          const row = byBucket.get(b);
          const score = row?.organic_score_mean ?? null;
          const display = score === null ? "—" : Math.round(score).toString();
          return (
            <div class="kpi-debutwin-cell" key={b}
                 title={row ? `${row.video_count} videos · organic ${(100 * (row.organic_ratio ?? 0)).toFixed(0)}% · likely_paid ${(100 * (row.likely_paid_ratio ?? 0)).toFixed(0)}%` : "no data"}>
              <div class="kpi-debutwin-bucket">{b}</div>
              <div class="kpi-debutwin-score" style={{ color: colorForScore(score) }}>
                {display}
              </div>
            </div>
          );
        })}
      </div>
      <div class="kpi-debutwin-note">view-weighted mean per bucket</div>
    </div>
  );
}
```

- [ ] **Step 2: Add minimal CSS**

Find the main stylesheet (probably `frontend/src/style.css` or similar — check directory). Append:
```css
.kpi-debutwin { font-size: 0.85em; margin-top: 8px; }
.kpi-debutwin-label { font-weight: 600; margin-bottom: 4px; }
.kpi-debutwin-row { display: flex; gap: 8px; }
.kpi-debutwin-cell { text-align: center; flex: 1; }
.kpi-debutwin-bucket { font-size: 0.75em; color: #9ca3af; }
.kpi-debutwin-score { font-weight: 700; font-size: 1.1em; }
.kpi-debutwin-note { font-size: 0.7em; color: #6b7280; margin-top: 2px; }
.kpi-debutwin.loading { opacity: 0.5; }
```

- [ ] **Step 3: Wire into MarketOverview**

In `frontend/src/views/MarketOverview.tsx`, find where group cards are rendered (look for `.map((g) =>` or similar over groups). Inside each card, after the existing KPI grid, add:

```tsx
import { DebutWindowKPI } from "../components/DebutWindowKPI";

// ...inside the group card render...
<DebutWindowKPI groupKey={g.key} />
```

- [ ] **Step 4: Typecheck and run dev server**

Run:
```bash
cd frontend && pnpm typecheck
```
Expected: No errors.

```bash
cd frontend && pnpm dev
```
Open http://localhost:5173 — visually verify that each group card now shows a "Debut Window Organicity" row with 5 buckets. Empty/N/A is OK at this stage (no data yet). No console errors.

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/DebutWindowKPI.tsx \
        frontend/src/views/MarketOverview.tsx \
        frontend/src/style.css
git commit -m "feat(frontend): DebutWindowKPI in group cards"
```

---

## Task 14: DebutWindowVideoTable + SignalPanel + GroupContent 통합

**Files:**
- Create: `frontend/src/components/DebutWindowVideoTable.tsx`
- Create: `frontend/src/components/DebutWindowSignalPanel.tsx`
- Modify: `frontend/src/views/GroupContent.tsx`

- [ ] **Step 1: Create SignalPanel component**

`frontend/src/components/DebutWindowSignalPanel.tsx`:
```typescript
interface Props {
  videoId: string;
  signalBreakdown: string;   // JSON string from API
  onClose: () => void;
}

export function DebutWindowSignalPanel({ videoId, signalBreakdown, onClose }: Props) {
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(signalBreakdown); } catch { /* keep empty */ }
  const ytUrl = `https://youtu.be/${videoId}`;

  return (
    <aside class="dw-signal-panel">
      <header>
        <h4>Signal Breakdown</h4>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </header>
      <a href={ytUrl} target="_blank" rel="noopener">Open on YouTube ↗</a>
      <dl>
        {Object.entries(parsed).map(([k, v]) => (
          <div class="dw-signal-row" key={k}>
            <dt>{k}</dt>
            <dd>{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
          </div>
        ))}
      </dl>
      <p class="dw-signal-disclaimer">
        v1 heuristic — verify manually before external use.
      </p>
    </aside>
  );
}
```

- [ ] **Step 2: Create VideoTable component**

`frontend/src/components/DebutWindowVideoTable.tsx`:
```typescript
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { DebutWindowSignalPanel } from "./DebutWindowSignalPanel";

const BUCKETS = ["D-60", "D-30", "D-Day", "D+30", "D+60"] as const;
type Bucket = typeof BUCKETS[number];
type FilterType = "all" | "long" | "short";

interface VideoRow {
  video_id: string;
  title: string | null;
  is_short: number;
  days_relative_to_debut: number;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  engagement_rate: number | null;
  organic_score: number | null;
  verdict: string;
  signal_breakdown: string;
}

interface Props {
  groupKey: string;
}

function colorForVerdict(v: string): string {
  if (v === "organic")        return "#22c55e";
  if (v === "suspect")        return "#eab308";
  if (v === "likely_paid")    return "#ef4444";
  return "#6b7280";  // insufficient_data
}

function fmtViews(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function DebutWindowVideoTable({ groupKey }: Props) {
  const [bucket, setBucket] = useState<Bucket>("D-30");
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [rows, setRows] = useState<VideoRow[] | null>(null);
  const [selected, setSelected] = useState<VideoRow | null>(null);

  useEffect(() => {
    setRows(null);
    let cancelled = false;
    api.debutWindowVideos(groupKey, bucket, filterType).then((r: { rows: VideoRow[] }) => {
      if (!cancelled) setRows(r.rows);
    });
    return () => { cancelled = true; };
  }, [groupKey, bucket, filterType]);

  return (
    <section class="dw-video-section">
      <nav class="dw-bucket-tabs">
        {BUCKETS.map((b) => (
          <button type="button"
                  key={b}
                  class={b === bucket ? "active" : ""}
                  onClick={() => setBucket(b)}>{b}</button>
        ))}
      </nav>

      <div class="dw-type-filter">
        Filter:
        {(["all", "long", "short"] as const).map((t) => (
          <label key={t}>
            <input type="radio" name="dw-type" checked={filterType === t}
                   onChange={() => setFilterType(t)} />
            {t === "all" ? "All" : t === "long" ? "Long-form" : "Shorts"}
          </label>
        ))}
      </div>

      <div class="dw-table-wrap">
        <table class="dw-video-table">
          <thead>
            <tr>
              <th>D-day</th><th>Title</th><th>Type</th>
              <th>Views</th><th>ER</th><th>Score</th><th>판정</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr><td colSpan={7}>Loading…</td></tr>
            )}
            {rows !== null && rows.length === 0 && (
              <tr><td colSpan={7}>No videos in this bucket</td></tr>
            )}
            {rows !== null && rows.map((r) => {
              const dayLabel = r.days_relative_to_debut >= 0
                ? `+${r.days_relative_to_debut}` : `${r.days_relative_to_debut}`;
              return (
                <tr key={r.video_id} onClick={() => setSelected(r)} class="dw-row-clickable">
                  <td>{dayLabel}</td>
                  <td title={r.title ?? ""}>{r.title ?? r.video_id}</td>
                  <td>{r.is_short ? "Shorts" : "Long"}</td>
                  <td>{fmtViews(r.view_count)}</td>
                  <td>{r.engagement_rate === null ? "—" : `${(r.engagement_rate * 100).toFixed(1)}%`}</td>
                  <td>{r.organic_score ?? "—"}</td>
                  <td style={{ color: colorForVerdict(r.verdict) }}>{r.verdict}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && (
        <DebutWindowSignalPanel
          videoId={selected.video_id}
          signalBreakdown={selected.signal_breakdown}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
```

- [ ] **Step 3: Add CSS**

Append to `frontend/src/style.css`:
```css
.dw-bucket-tabs { display: flex; gap: 4px; margin: 12px 0 8px; }
.dw-bucket-tabs button { padding: 6px 12px; border: 1px solid #d1d5db; background: #f9fafb; cursor: pointer; }
.dw-bucket-tabs button.active { background: #1f2937; color: #fff; border-color: #1f2937; }
.dw-type-filter { font-size: 0.85em; display: flex; gap: 12px; margin-bottom: 8px; }
.dw-type-filter label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.dw-table-wrap { overflow-x: auto; }
.dw-video-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.dw-video-table th, .dw-video-table td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #e5e7eb; }
.dw-row-clickable { cursor: pointer; }
.dw-row-clickable:hover { background: #f3f4f6; }
.dw-signal-panel { position: fixed; right: 0; top: 0; bottom: 0; width: 360px; background: #fff; border-left: 1px solid #d1d5db; padding: 16px; overflow-y: auto; z-index: 100; box-shadow: -4px 0 12px rgba(0,0,0,0.1); }
.dw-signal-panel header { display: flex; justify-content: space-between; align-items: center; }
.dw-signal-panel dl { margin: 12px 0; }
.dw-signal-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dotted #e5e7eb; }
.dw-signal-row dt { font-weight: 600; }
.dw-signal-disclaimer { font-size: 0.75em; color: #9ca3af; font-style: italic; margin-top: 16px; }
```

- [ ] **Step 4: Wire into GroupContent**

In `frontend/src/views/GroupContent.tsx`, locate the existing tab/view switching logic and add a "Debut Window" tab. The exact integration depends on the file's current structure — find the tabs container and add an entry. Then conditionally render `<DebutWindowVideoTable groupKey={groupKey} />` when that tab is active.

Minimal pattern (adapt to actual file's tab framework):
```tsx
import { DebutWindowVideoTable } from "../components/DebutWindowVideoTable";

// add 'debut-window' to the tab type union and tab list
// in the conditional render:
{activeTab === "debut-window" && <DebutWindowVideoTable groupKey={groupKey} />}
```

- [ ] **Step 5: Typecheck and dev test**

Run:
```bash
cd frontend && pnpm typecheck
```
Expected: No errors.

```bash
cd frontend && pnpm dev
```
Navigate to a group's detail page → click "Debut Window" tab → bucket tabs render, table shows (likely empty initially), no console errors. Click any row → panel opens with signal breakdown JSON.

Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/DebutWindowVideoTable.tsx \
        frontend/src/components/DebutWindowSignalPanel.tsx \
        frontend/src/views/GroupContent.tsx \
        frontend/src/style.css
git commit -m "feat(frontend): debut window video table + signal panel"
```

---

## Task 15: CompetitorOrganicityBar + MiiWANBriefing 통합

**Files:**
- Create: `frontend/src/components/CompetitorOrganicityBar.tsx`
- Modify: `frontend/src/views/MiiWANBriefing.tsx`

- [ ] **Step 1: Create CompetitorOrganicityBar component**

`frontend/src/components/CompetitorOrganicityBar.tsx`:
```typescript
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

const BUCKETS = ["D-60", "D-30", "D-Day", "D+30", "D+60"] as const;
type Bucket = typeof BUCKETS[number];

interface SummaryRow {
  group_key: string;
  window_bucket: string;
  organic_score_mean: number | null;
  video_count: number;
}

function colorForScore(score: number | null): string {
  if (score === null) return "#6b7280";
  if (score >= 70) return "#22c55e";
  if (score >= 40) return "#eab308";
  return "#ef4444";
}

export function CompetitorOrganicityBar() {
  const [bucket, setBucket] = useState<Bucket>("D-30");
  const [rows, setRows] = useState<SummaryRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    let cancelled = false;
    api.debutWindowSummary(bucket).then((r: { rows: SummaryRow[] }) => {
      if (!cancelled) setRows(r.rows);
    });
    return () => { cancelled = true; };
  }, [bucket]);

  if (!rows) return <div class="cob-section">Loading…</div>;

  // Sort by score desc, N/A last
  const sorted = [...rows].sort((a, b) => {
    if (a.organic_score_mean === null && b.organic_score_mean === null) return 0;
    if (a.organic_score_mean === null) return 1;
    if (b.organic_score_mean === null) return -1;
    return b.organic_score_mean - a.organic_score_mean;
  });

  const max = 100;

  return (
    <section class="cob-section">
      <h3>Competitive Debut Window Posture</h3>
      <div class="cob-bucket-picker">
        View bucket:
        {BUCKETS.map((b) => (
          <button type="button"
                  key={b}
                  class={b === bucket ? "active" : ""}
                  onClick={() => setBucket(b)}>{b}</button>
        ))}
      </div>
      <div class="cob-bars">
        {sorted.map((r) => {
          const score = r.organic_score_mean;
          const width = score === null ? 0 : (score / max) * 100;
          const isOurs = r.group_key === "miiwan";
          const label = score === null ? "N/A" : Math.round(score).toString();
          return (
            <div class={`cob-row ${isOurs ? "ours" : ""}`} key={r.group_key}>
              <div class="cob-name">{r.group_key.toUpperCase()}</div>
              <div class="cob-bar-track">
                <div class="cob-bar-fill"
                     style={{ width: `${width}%`, background: colorForScore(score) }} />
              </div>
              <div class="cob-score">{label}</div>
              {isOurs && <div class="cob-tag">← ours</div>}
            </div>
          );
        })}
      </div>
      <div class="cob-footer">
        Showing {sorted.length} groups for bucket {bucket}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Add CSS**

Append to `frontend/src/style.css`:
```css
.cob-section { margin: 24px 0; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; }
.cob-bucket-picker { display: flex; gap: 6px; align-items: center; margin: 8px 0 16px; font-size: 0.9em; }
.cob-bucket-picker button { padding: 4px 10px; border: 1px solid #d1d5db; background: #f9fafb; cursor: pointer; font-size: 0.85em; }
.cob-bucket-picker button.active { background: #1f2937; color: #fff; border-color: #1f2937; }
.cob-bars { display: flex; flex-direction: column; gap: 6px; }
.cob-row { display: grid; grid-template-columns: 100px 1fr 48px 70px; gap: 8px; align-items: center; font-size: 0.9em; }
.cob-row.ours { font-weight: 700; }
.cob-name { font-family: monospace; }
.cob-bar-track { height: 18px; background: #f3f4f6; border-radius: 2px; overflow: hidden; }
.cob-bar-fill { height: 100%; transition: width 0.2s; }
.cob-score { text-align: right; font-family: monospace; }
.cob-tag { font-size: 0.75em; color: #1f2937; }
.cob-footer { font-size: 0.75em; color: #6b7280; margin-top: 12px; }

@media (max-width: 720px) {
  .cob-row { grid-template-columns: 80px 1fr 40px; }
  .cob-tag { display: none; }
}
```

- [ ] **Step 3: Wire into MiiWANBriefing**

In `frontend/src/views/MiiWANBriefing.tsx`, find an appropriate place to insert the new section (likely after the existing briefing content blocks). Add:

```tsx
import { CompetitorOrganicityBar } from "../components/CompetitorOrganicityBar";

// ...inside the main render block, in a natural spot...
<CompetitorOrganicityBar />
```

- [ ] **Step 4: Typecheck and dev verify**

Run:
```bash
cd frontend && pnpm typecheck
```
Expected: No errors.

```bash
cd frontend && pnpm dev
```
Navigate to MiiWAN Briefing page → see "Competitive Debut Window Posture" section with bucket selector and bar chart placeholder. Switch buckets; verify network call to `/api/debut-window/summary?bucket=...`. No console errors.

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/CompetitorOrganicityBar.tsx \
        frontend/src/views/MiiWANBriefing.tsx \
        frontend/src/style.css
git commit -m "feat(frontend): competitor organicity bar in MiiWAN briefing"
```

---

## Task 16: 백필 + 운영 문서 + 배포

**Files:**
- Modify: `docs/onboarding.md`

- [ ] **Step 1: Document the one-time backfill procedure**

Append a new section to `docs/onboarding.md`:
```markdown
## V2.20 Debut Window Organicity 백필 (1회성)

새로 마이그레이션된 `debut_window_video_organicity` / `debut_window_organicity_summary`
테이블을 처음 채우는 절차. 이미 데뷔한 그룹의 D-60~D+60 영상 메타데이터/통계가
필요하므로 `backfill-yt-videos` 워크플로를 9개 그룹 각각 실행한 뒤, 일일
aggregate를 한 번 돌려 신규 테이블을 채운다.

1. 마이그레이션 원격 적용:
   ```
   cd frontend && wrangler d1 migrations apply idol-sight --remote
   ```
2. 9개 그룹 백필 — GitHub Actions UI에서 `backfill-yt-videos` workflow_dispatch
   를 그룹마다 실행하거나, 다음 CLI를 9번 호출:
   ```
   gh workflow run backfill-yt-videos.yml -f group=plave
   gh workflow run backfill-yt-videos.yml -f group=isedol
   # ... 나머지 7개
   ```
3. 백필 완료 후 collect-daily 또는 melon-chart 워크플로의 다음 자동 실행이
   `aggregate` 안에서 신규 단계(`debut_window_videos`, `debut_window_summary`)
   를 자동으로 실행한다. 즉시 채우려면:
   ```
   gh workflow run collect-daily.yml
   ```
4. 대시보드에서 그룹 카드의 "Debut Window Organicity" 행이 N/A 가 아닌 점수
   로 채워졌는지 확인.
```

- [ ] **Step 2: Apply remote migration**

Run (사용자 확인 후, 원격 D1에 영향):
```bash
cd frontend && wrangler d1 migrations apply idol-sight --remote
```
Expected: `0052_debut_window_organicity.sql` 적용 완료 메시지.

- [ ] **Step 3: Trigger backfill workflows for each group**

Run (or use GitHub UI):
```bash
for g in plave isedol stellive skinz myrakl miiwan owis bdawn wegosix; do
  gh workflow run backfill-yt-videos.yml -f group=$g
done
```
Expected: 각 명령마다 `Created workflow_dispatch event for backfill-yt-videos.yml at main`. GitHub Actions UI에서 9개 run이 queued 됨을 확인.

- [ ] **Step 4: Wait for backfill, then trigger collect-daily**

기다린 뒤 (`gh run list --workflow=backfill-yt-videos.yml --limit 9` 로 확인):
```bash
gh workflow run collect-daily.yml
```
collect-daily가 끝나면 새 두 테이블이 채워져 있어야 함. D1에서 확인:
```bash
cd frontend && wrangler d1 execute idol-sight --remote --command="SELECT COUNT(*) FROM debut_window_video_organicity"
cd frontend && wrangler d1 execute idol-sight --remote --command="SELECT group_key, window_bucket, video_count, organic_score_mean FROM debut_window_organicity_summary ORDER BY group_key, window_bucket"
```
Expected: row 수 > 0 in 첫 쿼리. 두 번째 쿼리는 그룹×버킷 점수 매트릭스 출력.

- [ ] **Step 5: Verify dashboard**

Pages 도메인 (idol-sight.pages.dev) 접속 →
- Market Overview 카드에 점수 표시 확인
- 한 그룹 클릭 → GroupContent의 Debut Window 탭에서 영상 테이블 보이는지 확인
- MiiWAN Briefing → Competitor Organicity bar 차트 보이는지 확인

- [ ] **Step 6: Commit docs**

```bash
git add docs/onboarding.md
git commit -m "chore(docs): debut window organicity backfill procedure"
git push origin main
```

---

## 완료 후 후속 (별도 PR / v1.1)

이번 plan에는 포함하지 않음 — spec §5 Phase 7 참조:

- `insights.ai_comment` 인프라에 'organicity_compare' 프롬프트 추가, analyze-weekly cron에서 §4-C 차트 하단 자동 코멘트 생성
- 점수 임계값/가중치 calibration (실 데이터 분포 1개월 모은 뒤)
- 시간 흐름 sparkline (그룹별 5버킷 점수 추이)

---

## 자기 점검 / Self-Review

각 spec 섹션 → 대응 task:
- §1 Problem & Scope: 전체 plan이 이 범위를 다룸
- §2 Data Model: Task 1 (migration)
- §3 Algorithm: Tasks 2-6 (TDD로 각 sub-score, composite, verdict)
- §4-A KPI: Task 13
- §4-B 영상 테이블: Task 14
- §4-C 경쟁사 차트: Task 15
- §4-D API: Tasks 10, 11
- §5 Phase 1 (DB): Task 1
- §5 Phase 2 (분석 모듈): Tasks 2-8
- §5 Phase 3 (CLI 통합): Task 9
- §5 Phase 4 (백필): Task 16
- §5 Phase 5 (API): Tasks 10, 11
- §5 Phase 6 (Frontend): Tasks 12, 13, 14, 15
- §5 Phase 7 (LLM): 의도적 제외, "완료 후 후속" 섹션 명시

타입 일관성:
- `_Executor` Protocol은 `worker/src/idol_sight/analysis/agg_summary.py` 등에 이미 정의된 동일한 형태 (Tasks 7, 8에서 import 가능 또는 재정의)
- `CollectionResult`는 `idol_sight.collectors.base` 에서 import (Tasks 7, 8)
- `bucket_for` 반환 타입 `str | None` 일관 (Tasks 2, 7)
- `compute_organic_score` 반환 타입 `tuple[int | None, dict]` — `int | None` 일관 (Task 6, 7)
- API endpoint의 `VALID_BUCKETS` 문자열 (Tasks 10, 11) — Python 쪽 `WINDOW_BUCKETS` 라벨과 동일 표기
- Frontend `BUCKETS` 상수 동일 (Tasks 13, 14, 15)

총 16 tasks, 추정 작업량 6-10시간 (frontend integration이 가장 까다로움 — 기존 GroupContent.tsx, MiiWANBriefing.tsx 구조 파악 필요).
