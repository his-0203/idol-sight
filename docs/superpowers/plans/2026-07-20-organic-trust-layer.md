# V2.53 Organic Trust Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** organicity 유료 의심 신호를 인지도·추정 코어 점수에 신뢰 할인으로 반영하고, 잠정 데뷔 앵커 그룹(BTHD)의 등급을 PRE로 게이트한다.

**Architecture:** 신규 순수 모듈 `organic_confidence.py`가 `debut_window_video_organicity` verdict 분포를 그룹별 0~1 계수로 압축 → awareness/core_fan_estimate 빌더가 이를 소비해 `_adj` 컬럼(additive)에 보정값 저장 → API는 별도 쿼리 `.catch` merge(graceful) → 프론트는 adj-first 폴백 표시. 등급은 `groups.debut_confirmed=0`이면 PRE.

**Tech Stack:** Python 3.12 (worker, pytest), Preact+TS (frontend, vitest), Cloudflare D1 (SQLite migrations).

**Spec:** `docs/superpowers/specs/2026-07-20-organic-trust-layer-design.md`

## Global Constraints

- 스펙 A의 상수 고정: `VERDICT_WEIGHTS = {organic_strong:1.0, organic:1.0, borderline:0.7, suspect:0.4, likely_paid:0.15}`, `CONFIDENCE_PRIOR=0.75`, `CONFIDENCE_SHRINKAGE_K=3`, n=0 → **1.0 (무할인)**.
- count 기반 단순 평균 — 조회수 가중 금지 (V2.40 원칙).
- migration은 전부 additive. 워커·API는 **migration 미적용 D1에서도 기존 동작 유지** (컬럼 감지 try/except · API 별도 쿼리 `.catch(()=>[])` 후 merge — mig 0095 패턴).
- 사분면(BreadthDepthQuadrant/breadthDepth.ts)은 **원값 유지** — 로직 변경 금지.
- frontend 커밋 subject는 **ASCII-only** (Cloudflare Pages 8000111 거부).
- worker 실행 전 `cd worker && uv sync`, frontend는 `cd frontend && pnpm i` (의존성 미설치 환경).
- 테스트 명령: worker `cd worker && uv run pytest tests -q`, frontend `cd frontend && pnpm vitest run`.
- 기존 테스트 전부 유지 (worker 770+, frontend 302).
- 커밋 트레일러:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01W2ow8qKE3iERgpE55TpDd5`

---

### Task 1: organic_confidence 신규 모듈 (모델: opus)

**Files:**
- Create: `worker/src/idol_sight/analysis/organic_confidence.py`
- Test: `worker/tests/unit/test_organic_confidence.py`

**Interfaces:**
- Produces: `compute_organic_confidence(verdicts: list[str]) -> float` (0~1, round 3자리), `load_organic_confidence(client) -> dict[str, float]` (채점 영상 없는 그룹은 dict에 부재 — 호출부가 1.0으로 취급), 상수 `VERDICT_WEIGHTS`, `CONFIDENCE_PRIOR`, `CONFIDENCE_SHRINKAGE_K`.

- [ ] **Step 1: Write the failing test**

```python
"""V2.53 Organic Trust Layer — organic_confidence 단위 테스트."""
from idol_sight.analysis.organic_confidence import (
    CONFIDENCE_PRIOR,
    compute_organic_confidence,
    load_organic_confidence,
)


class FakeClient:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, sql, params=None):
        return self.rows


def test_bthd_fixture_regression():
    """BTHD 2026-07-20 실측 분포(organic 3 / borderline 6 / suspect 5 /
    likely_paid 8) → mean 0.4727..., shrinkage 후 0.506."""
    verdicts = (["organic"] * 3 + ["borderline"] * 6
                + ["suspect"] * 5 + ["likely_paid"] * 8)
    assert compute_organic_confidence(verdicts) == 0.506


def test_all_organic_is_shrunk_toward_prior():
    # n=2 전부 organic: (2*1.0 + 3*0.75) / 5 = 0.85 — 만점 방지
    assert compute_organic_confidence(["organic", "organic_strong"]) == 0.85


def test_all_paid_is_shrunk_up():
    # n=1 likely_paid: (0.15 + 2.25) / 4 = 0.6
    assert compute_organic_confidence(["likely_paid"]) == 0.6


def test_empty_means_no_discount():
    assert compute_organic_confidence([]) == 1.0


def test_unknown_and_insufficient_verdicts_ignored():
    # 알 수 없는 verdict 는 표본에서 제외 — 전부 미지면 무할인
    assert compute_organic_confidence(["insufficient_data", "???"]) == 1.0


def test_load_groups_by_key():
    client = FakeClient([
        {"group_key": "a", "verdict": "organic"},
        {"group_key": "a", "verdict": "likely_paid"},
        {"group_key": "b", "verdict": "organic"},
    ])
    conf = load_organic_confidence(client)
    # a: mean 0.575 → (2*0.575+2.25)/5 = 0.68 / b: (1.0+2.25)/4 = 0.8125
    assert conf == {"a": 0.68, "b": 0.813}


def test_prior_constant():
    assert CONFIDENCE_PRIOR == 0.75
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_organic_confidence.py -q`
Expected: FAIL (ModuleNotFoundError: organic_confidence)

- [ ] **Step 3: Write minimal implementation**

```python
"""Organic Trust Layer (V2.53) — 그룹별 organicity 신뢰 계수.

debut_window_video_organicity 전 영상 verdict 분포를 0~1 계수 하나로 압축해
인지도(awareness)·추정 코어(core_fan_estimate)가 유료 의심 할인에 쓰는 공용
신호. count 기반 단순 평균(V2.40 원칙, 조회수 가중 금지) + thin-sample
shrinkage(mig 0092 패턴, PRIOR=0.75/K=3). 채점 영상 0 → 1.0(무할인) —
판정 근거 없이 감점하지 않는다. prior 수렴이 아닌 이유: 미채점 그룹 전원이
25% 감점되는 부작용.
"""
from __future__ import annotations

from typing import Any, Protocol

__all__ = [
    "VERDICT_WEIGHTS",
    "CONFIDENCE_PRIOR",
    "CONFIDENCE_SHRINKAGE_K",
    "compute_organic_confidence",
    "load_organic_confidence",
]

VERDICT_WEIGHTS: dict[str, float] = {
    "organic_strong": 1.0,
    "organic": 1.0,
    "borderline": 0.7,
    "suspect": 0.4,
    "likely_paid": 0.15,
}
CONFIDENCE_PRIOR: float = 0.75
CONFIDENCE_SHRINKAGE_K: int = 3

# insufficient_data 는 표본 제외 (판정 불가 ≠ 유료 의심)
_VERDICTS_SQL = (
    "SELECT group_key, verdict FROM debut_window_video_organicity "
    "WHERE verdict != 'insufficient_data'"
)


def compute_organic_confidence(verdicts: list[str]) -> float:
    """verdict 리스트 → 신뢰 계수 (순수). 미지 verdict 는 표본에서 제외."""
    weights = [VERDICT_WEIGHTS[v] for v in verdicts if v in VERDICT_WEIGHTS]
    n = len(weights)
    if n == 0:
        return 1.0
    mean = sum(weights) / n
    conf = (n * mean + CONFIDENCE_SHRINKAGE_K * CONFIDENCE_PRIOR) / (
        n + CONFIDENCE_SHRINKAGE_K
    )
    return round(conf, 3)


class _Executor(Protocol):
    def execute(self, sql: str, params: list[Any] | None = ...) -> list[dict]: ...


def load_organic_confidence(client: _Executor) -> dict[str, float]:
    """그룹별 신뢰 계수. 채점 영상 없는 그룹은 키 부재 → 호출부에서 1.0."""
    by_group: dict[str, list[str]] = {}
    for r in client.execute(_VERDICTS_SQL):
        by_group.setdefault(r["group_key"], []).append(r["verdict"])
    return {k: compute_organic_confidence(v) for k, v in by_group.items()}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_organic_confidence.py -q`
Expected: PASS (7 tests). 검산 주의: `load` 테스트의 0.813은 round(0.8125,3)=0.813 (banker's rounding 아님 — Python round(0.8125,3)이 0.812가 나오면 기대값을 실제 값으로 수정하고 커밋 메시지에 명기).

- [ ] **Step 5: Run full worker suite + commit**

Run: `cd worker && uv run pytest tests -q` — 기존 테스트 전부 PASS 확인.

```bash
git add worker/src/idol_sight/analysis/organic_confidence.py worker/tests/unit/test_organic_confidence.py
git commit -m "feat(worker): V2.53 organic confidence coefficient module"
```

---

### Task 2: 인지도 신뢰 할인 (모델: opus)

**Files:**
- Modify: `worker/src/idol_sight/analysis/awareness.py`
- Test: `worker/tests/unit/test_awareness.py` (기존 테스트 유지 + 추가)

**Interfaces:**
- Consumes: Task 1의 `load_organic_confidence(client)`.
- Produces: `compute_awareness(groups, *, confidence_by_key: dict[str, float] | None = None)` — 기존 출력 dict에 `awareness_score_adj` (float|None), `organic_confidence` (float), `category_rank_adj` (int|None) 3키 추가. `build_awareness`는 D1에 컬럼 존재 시 확장 INSERT, 부재 시 기존 INSERT (graceful).

- [ ] **Step 1: Write the failing tests** (기존 테스트 파일에 추가)

```python
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
```

- [ ] **Step 2: Run to verify fail** — `cd worker && uv run pytest tests/unit/test_awareness.py -q` → 신규 4건 FAIL (KeyError/TypeError).

- [ ] **Step 3: Implement `compute_awareness` 확장**

`compute_awareness(groups, *, confidence_by_key=None)`으로 시그니처 변경. 3)단계 rows 생성 시:

```python
        conf = (confidence_by_key or {}).get(e["group_key"], 1.0)
        score_adj = round(score * conf, 1) if score is not None else None
```

row dict에 `"awareness_score_adj": score_adj, "organic_confidence": conf, "category_rank_adj": None` 추가. 4)단계 뒤에 보정 랭킹 블록 추가 (원값 랭킹 로직과 동일 구조, `awareness_score_adj` 기준):

```python
    for cat_rows in by_cat.values():
        scored = [r for r in cat_rows if r["awareness_score_adj"] is not None]
        scored.sort(key=lambda r: (-r["awareness_score_adj"], -r["_sub_raw"]))
        for i, r in enumerate(scored, start=1):
            r["category_rank_adj"] = i
```

(주의: `_sub_raw` pop은 두 랭킹 블록이 모두 끝난 뒤로 이동.)

- [ ] **Step 4: `build_awareness` 확장 — confidence 로드 + graceful INSERT**

```python
_INSERT_SQL_ADJ = """
INSERT INTO agg_awareness
  (group_key, snapshot_at, category, awareness_score, category_rank,
   sub_n, view_n, news_n, basis, generated_at,
   awareness_score_adj, organic_confidence, category_rank_adj)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
""".strip()


def _has_adj_columns(client: _Executor) -> bool:
    """mig 0106 적용 여부 감지 — 미적용 D1에서도 기존 INSERT로 동작(graceful)."""
    try:
        client.execute("SELECT awareness_score_adj FROM agg_awareness LIMIT 1")
        return True
    except Exception:
        return False
```

`build_awareness` 내부: `from idol_sight.analysis.organic_confidence import load_organic_confidence` 후

```python
    try:
        confidence_by_key = load_organic_confidence(client)
    except Exception:
        confidence_by_key = {}   # organicity 테이블 이상 시 무할인 (graceful)
    rows = compute_awareness(groups_in, confidence_by_key=confidence_by_key)
    use_adj = _has_adj_columns(client)
```

INSERT 분기: `use_adj`면 `_INSERT_SQL_ADJ`에 `r["awareness_score_adj"], r["organic_confidence"], r["category_rank_adj"]` 추가 바인딩, 아니면 기존 `_INSERT_SQL`.

build 테스트 추가 (기존 build 테스트의 FakeClient 패턴 재사용 — 파일 내 기존 fake가 execute만 갖고 있으면 그대로): adj 컬럼 감지 성공 케이스에서 INSERT 문에 `awareness_score_adj`가 포함되는지, 감지 실패(fake가 해당 SELECT에서 raise) 시 기존 INSERT로 나가는지 2건.

- [ ] **Step 5: Run** — `cd worker && uv run pytest tests/unit/test_awareness.py -q` → 전부 PASS. 이어서 `uv run pytest tests -q` 전체 PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/src/idol_sight/analysis/awareness.py worker/tests/unit/test_awareness.py
git commit -m "feat(worker): V2.53 awareness organic-trust discount (adj score/rank)"
```

---

### Task 3: 추정 코어 유료 의심 영상 제외 (모델: opus)

**Files:**
- Modify: `worker/src/idol_sight/analysis/core_fan_estimate.py`
- Test: `worker/tests/unit/test_core_fan_estimate.py`

**Interfaces:**
- Produces: `select_organic_videos(window_videos, fallback_videos, suspect_ids) -> list | None` (순수), `compute_core_fan_estimate(group_videos)` — 입력 entry에 `videos_adj: list | None` 키 추가 소비, 출력에 `est_engaged_fans_adj`, `est_active_core_adj`, `organic_video_count` 추가, `basis`는 `'scored' | 'insufficient' | 'insufficient_organic'`.
- basis 규칙: videos 없음 → `insufficient` (기존). videos 있고 videos_adj None → `insufficient_organic` (adj값 None, 원값은 유지 저장). 둘 다 있으면 `scored`.

- [ ] **Step 1: Write the failing tests** (기존 파일에 추가)

```python
# ── V2.53 Organic Trust Layer ──────────────────────────────────────

def _vid(i, views=1000, likes=50, comments=10):
    return {"video_id": f"v{i}", "published_at": "2026-07-01T00:00:00Z",
            "views": views, "likes": likes, "comments": comments}


def test_select_organic_videos_filters_suspects():
    window = [_vid(1), _vid(2), _vid(3), _vid(4)]
    out = select_organic_videos(window, [], {"v4"})
    assert [v["video_id"] for v in out] == ["v1", "v2", "v3"]


def test_select_organic_videos_falls_back_then_none():
    window = [_vid(1), _vid(2), _vid(3)]
    fallback = [_vid(1), _vid(2), _vid(3), _vid(4), _vid(5)]
    # window 필터 후 1편 → 폴백 필터 적용 3편 → 폴백 채택
    out = select_organic_videos(window, fallback, {"v2", "v3"})
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
```

- [ ] **Step 2: Run to verify fail** — `cd worker && uv run pytest tests/unit/test_core_fan_estimate.py -q` → 신규 FAIL.

- [ ] **Step 3: Implement**

`select_organic_videos` (모듈 상단 `__all__`에 추가):

```python
def select_organic_videos(
    window_videos: list[dict[str, Any]],
    fallback_videos: list[dict[str, Any]],
    suspect_ids: set[str],
) -> list[dict[str, Any]] | None:
    """suspect/likely_paid 제외 후 표본 확보 (순수).

    윈도우에서 제외 후 < _MIN_WINDOW_VIDEOS 면 폴백(최신 12편)에도 동일
    필터 적용, 그래도 부족하면 None (→ basis='insufficient_organic').
    """
    filtered = [v for v in window_videos if v.get("video_id") not in suspect_ids]
    if len(filtered) >= _MIN_WINDOW_VIDEOS:
        return filtered
    fb = [v for v in fallback_videos if v.get("video_id") not in suspect_ids]
    if len(fb) >= _MIN_WINDOW_VIDEOS:
        return fb
    return None
```

`compute_core_fan_estimate` 루프 확장:

```python
        videos_adj = g.get("videos_adj", videos)   # 키 부재 = 필터 없음(호환)
        if videos:
            est_adj = (estimate_video_engagement(videos_adj, subscribers=None)
                       if videos_adj else None)
            basis = "scored" if videos_adj else "insufficient_organic"
        else:
            est_adj = None
            basis = "insufficient"
```

출력 dict에 `est_engaged_fans_adj`/`est_active_core_adj` (est_adj에서, None이면 None), `organic_video_count` (len(videos_adj) 또는 None) 추가.

`build_core_fan_estimate`: suspect 셋 로드 + 그룹 루프에서 videos_adj 결정 + graceful INSERT.

```python
_SUSPECT_SQL = (
    "SELECT video_id FROM debut_window_video_organicity "
    "WHERE verdict IN ('suspect', 'likely_paid')"
)
```

루프 전: `try: suspect_ids = {r["video_id"] for r in client.execute(_SUSPECT_SQL)}\nexcept Exception: suspect_ids = set()`.
루프 내(윈도우/폴백 fetch 후): 폴백 목록은 adj 산정에 필요할 때만 추가 fetch:

```python
        window_videos = client.execute(_VIDEOS_WINDOW_SQL, [key, cutoff])
        fallback_videos: list[dict[str, Any]] = []
        need_fallback = (
            len(window_videos) < _MIN_WINDOW_VIDEOS
            or len([v for v in window_videos
                    if v.get("video_id") not in suspect_ids]) < _MIN_WINDOW_VIDEOS
        )
        if need_fallback:
            fallback_videos = client.execute(
                _VIDEOS_FALLBACK_SQL, [key, _VIDEO_FALLBACK_LIMIT])
        videos = (window_videos if len(window_videos) >= _MIN_WINDOW_VIDEOS
                  else fallback_videos or window_videos)
        videos_adj = select_organic_videos(
            window_videos, fallback_videos, suspect_ids)
        group_videos.append(
            {"key": key, "videos": list(videos), "videos_adj": videos_adj})
```

(주의: 기존 원값 폴백 semantics 보존 — window ≥3이면 window, 아니면 fallback. fallback을 못 불렀는데 window <3인 기존 케이스는 need_fallback이 참이므로 동일.)

INSERT graceful — Task 2와 동일한 감지 패턴 (`SELECT est_engaged_fans_adj FROM agg_core_fan_estimate LIMIT 1`), 확장 INSERT:

```python
_INSERT_SQL_ADJ = (
    "INSERT INTO agg_core_fan_estimate\n"
    "  (group_key, snapshot_at, est_engaged_fans, est_active_core,\n"
    "   like_rate, comment_rate, video_count, basis, generated_at,\n"
    "   est_engaged_fans_adj, est_active_core_adj, organic_video_count)\n"
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)
```

build 테스트 2건 추가 (suspect 필터 결과가 INSERT 파라미터에 반영·컬럼 미존재 시 기존 INSERT) — 기존 build 테스트의 FakeClient 확장.

- [ ] **Step 4: Run** — `cd worker && uv run pytest tests/unit/test_core_fan_estimate.py -q` PASS → `uv run pytest tests -q` 전체 PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/core_fan_estimate.py worker/tests/unit/test_core_fan_estimate.py
git commit -m "feat(worker): V2.53 core fan estimate excludes paid-suspect videos"
```

---

### Task 4: 등급 PRE 게이트 — debut_confirmed (모델: opus)

**Files:**
- Modify: `worker/src/idol_sight/analysis/health_score.py` (`compute_health_score` 시그니처, `_is_pre_debut` 인근)
- Modify: `worker/src/idol_sight/cli.py` (`_load_active_groups_full`, `_recompute_health_scores`의 compute 호출부 — 현재 1675행 인근)
- Test: `worker/tests/unit/test_health_score.py`, `worker/tests/unit/test_cli_health.py`

**Interfaces:**
- Produces: `compute_health_score(..., debut_confirmed: Any = 1)` — `debut_confirmed`가 0/False면 debut_date와 무관하게 PRE 반환. None/1/미전달 = 확정 취급(하위 호환).
- `_load_active_groups_full(client)` — `debut_confirmed` 컬럼 포함 시도, 컬럼 부재 시 기존 SELECT 폴백(모든 그룹 confirmed=1).

- [ ] **Step 1: Write the failing tests**

`test_health_score.py`에 추가:

```python
def test_unconfirmed_debut_gates_to_pre():
    """잠정 앵커(BTHD): debut_date 가 과거여도 debut_confirmed=0 → PRE."""
    score = compute_health_score(
        "bthd", {"yt_subscribers": 100000}, "2026-06-26", debut_confirmed=0)
    assert score.grade == "PRE"
    assert score.total is None


def test_confirmed_default_keeps_existing_behavior():
    a = compute_health_score("g", {"yt_subscribers": 1000}, "2020-01-01")
    b = compute_health_score(
        "g", {"yt_subscribers": 1000}, "2020-01-01", debut_confirmed=None)
    assert a.grade == b.grade != "PRE"
```

`test_cli_health.py`에 추가: FakeClient가 `debut_confirmed` 포함 SELECT에서 raise하는 케이스 → 기존 SELECT로 폴백해 그룹 로드 성공 + 전 그룹 confirmed 취급을 검증하는 테스트 1건, 컬럼 있는 케이스에서 `debut_confirmed=0` 그룹이 PRE로 기록되는 테스트 1건 (기존 `_recompute_health_scores` 테스트 fixture 패턴 재사용).

- [ ] **Step 2: Run to verify fail** — `cd worker && uv run pytest tests/unit/test_health_score.py tests/unit/test_cli_health.py -q` → 신규 FAIL (TypeError: unexpected keyword).

- [ ] **Step 3: Implement**

`compute_health_score` 시그니처에 keyword `debut_confirmed: Any = 1` 추가, 게이트 확장:

```python
    if _is_pre_debut(debut_date) or debut_confirmed in (0, False):
        return HealthScore(
            total=None, raw_total=None,
            grade="PRE", label=GRADE_LABELS["PRE"],
            group_model=group_model or DEFAULT_GROUP_MODEL,
        )
```

(`_is_pre_debut` 자체는 불변. docstring에 "debut_confirmed=0 = 잠정 앵커(정식 데뷔 미확정) → PRE. None=미상=확정 취급(하위 호환·미적용 DB)" 명시.)

`cli.py` `_load_active_groups_full`:

```python
def _load_active_groups_full(client) -> list[dict]:
    """... (기존 docstring 유지) + V2.53: debut_confirmed(잠정 앵커 게이트).
    mig 0105 미적용 D1이면 기존 SELECT 로 폴백(전 그룹 확정 취급)."""
    try:
        return client.execute(
            "SELECT key, name, name_kr, debut_date, group_model, debut_confirmed "
            "FROM groups WHERE is_active=1"
        )
    except Exception:
        return client.execute(
            "SELECT key, name, name_kr, debut_date, group_model "
            "FROM groups WHERE is_active=1"
        )
```

compute 호출부(1674행 인근): `debut_confirmed=g.get("debut_confirmed", 1)` 키워드 추가.

- [ ] **Step 4: Run** — `cd worker && uv run pytest tests -q` 전체 PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/health_score.py worker/src/idol_sight/cli.py worker/tests/unit/test_health_score.py worker/tests/unit/test_cli_health.py
git commit -m "feat(worker): V2.53 PRE gate for provisional debut anchors (debut_confirmed)"
```

---

### Task 5: migrations 0105~0107 (모델: sonnet)

**Files:**
- Create: `migrations/0105_debut_confirmed.sql`
- Create: `migrations/0106_awareness_adj.sql`
- Create: `migrations/0107_core_fan_adj.sql`

**Interfaces:**
- Produces: Task 2~4·6이 참조하는 컬럼들. 전부 additive ALTER — 기존 행/코드 영향 없음.

- [ ] **Step 1: 파일 작성** (테스트 없음 — SQL 파일, 로컬 apply로 검증)

`0105_debut_confirmed.sql`:

```sql
-- migrations/0105_debut_confirmed.sql
--
-- V2.53 Organic Trust Layer — 정식 데뷔 확정 플래그.
-- 잠정 앵커(debut_date 는 있으나 정식 데뷔 미확정, mig 0093 BTHD)를 Health
-- Score PRE 게이트가 인식하게 한다. organicity/Debut Window/인지도 집계는
-- debut_date 를 그대로 사용(등급만 게이트).
-- 해제 절차: 정식 데뷔 확정 시
--   UPDATE groups SET debut_date='<확정일>', debut_confirmed=1 WHERE key='<key>';

ALTER TABLE groups ADD COLUMN debut_confirmed INTEGER NOT NULL DEFAULT 1;

-- BTHD: 2026-06-26 은 선공개 싱글 잠정 앵커(정식 데뷔 10월 초 예상, 미확정).
UPDATE groups SET debut_confirmed=0 WHERE key='bthd';
```

`0106_awareness_adj.sql`:

```sql
-- migrations/0106_awareness_adj.sql
--
-- V2.53 Organic Trust Layer — 인지도 신뢰 할인 컬럼 (additive).
-- awareness_score_adj = awareness_score × organic_confidence.
-- category_rank_adj = 보정값 기준 카테고리 순위. 원값 컬럼은 그대로 유지.

ALTER TABLE agg_awareness ADD COLUMN awareness_score_adj REAL;
ALTER TABLE agg_awareness ADD COLUMN organic_confidence REAL;
ALTER TABLE agg_awareness ADD COLUMN category_rank_adj INTEGER;
```

`0107_core_fan_adj.sql`:

```sql
-- migrations/0107_core_fan_adj.sql
--
-- V2.53 Organic Trust Layer — 추정 코어 유료 의심 제외 컬럼 (additive).
-- suspect/likely_paid verdict 영상 제외 후 median. organic_video_count =
-- 제외 후 표본 수. 표본 < 3 이면 basis='insufficient_organic' (adj NULL).

ALTER TABLE agg_core_fan_estimate ADD COLUMN est_engaged_fans_adj INTEGER;
ALTER TABLE agg_core_fan_estimate ADD COLUMN est_active_core_adj INTEGER;
ALTER TABLE agg_core_fan_estimate ADD COLUMN organic_video_count INTEGER;
```

- [ ] **Step 2: 로컬 검증**

Run: `cd frontend && wrangler d1 migrations apply idol-sight --local`
Expected: 0105~0107 적용 성공. 이어서
`wrangler d1 execute idol-sight --local --command "SELECT debut_confirmed FROM groups WHERE key='bthd'"` → `0`.
(원격 apply는 운영자 몫 — 실행하지 않는다.)

- [ ] **Step 3: Commit**

```bash
git add migrations/0105_debut_confirmed.sql migrations/0106_awareness_adj.sql migrations/0107_core_fan_adj.sql
git commit -m "feat(db): V2.53 organic trust layer migrations (0105-0107)"
```

---

### Task 6: market API adj 필드 (모델: sonnet)

**Files:**
- Modify: `frontend/functions/api/market.ts`
- Test: `frontend/tests/functions/api_market.test.ts`

**Interfaces:**
- Consumes: mig 0106/0107 컬럼 (부재 가능 — `.catch` 필수).
- Produces: 응답 `groups[key].awareness`에 `score_adj`, `category_rank_adj`, `organic_confidence` (전부 number|null), `groups[key].core_fan_estimate`에 `est_engaged_fans_adj`, `est_active_core_adj`, `basis` 추가. `core_fan_estimate`는 `basis === 'insufficient_organic'`일 때도 객체 반환(기존은 scored만).

- [ ] **Step 1: Write the failing tests** — 기존 api_market.test.ts의 fake D1 패턴을 따라: ① adj 쿼리 성공 시 awareness.score_adj 등이 응답에 실림, ② adj 쿼리 실패(mig 미적용 모사 — 해당 SQL만 reject하는 fake) 시 기존 응답 형태 유지(score_adj: null 또는 필드 부재가 아닌 **null**로 통일), ③ core basis='insufficient_organic' 행이 `{est_engaged_fans_adj: null, basis: 'insufficient_organic', ...}`로 노출, 3건 추가.

- [ ] **Step 2: Run to verify fail** — `cd frontend && pnpm vitest run tests/functions/api_market.test.ts` → FAIL.

- [ ] **Step 3: Implement** — 기존 awareness/coreFanEstimates 쿼리는 그대로 두고 **별도 쿼리 2개** 추가 (mig 0095 분리 조회 패턴):

```ts
interface AwarenessAdjRow {
  group_key: string; awareness_score_adj: number | null;
  category_rank_adj: number | null; organic_confidence: number | null;
}
const awarenessAdj = await d1Query<AwarenessAdjRow>(env.DB,
  `SELECT group_key, awareness_score_adj, category_rank_adj, organic_confidence
     FROM agg_awareness
    WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_awareness)`)
  .catch(() => [] as AwarenessAdjRow[]);   // mig 0106 미적용 → 원값만 (graceful)

interface CoreFanAdjRow {
  group_key: string; est_engaged_fans_adj: number | null;
  est_active_core_adj: number | null; organic_video_count: number | null;
}
const coreFanAdj = await d1Query<CoreFanAdjRow>(env.DB,
  `SELECT group_key, est_engaged_fans_adj, est_active_core_adj, organic_video_count
     FROM agg_core_fan_estimate
    WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_core_fan_estimate)`)
  .catch(() => [] as CoreFanAdjRow[]);     // mig 0107 미적용 → 원값만 (graceful)
```

byKey 맵 2개 추가 후 응답 조립:

```ts
      awareness: aw ? {
        score: aw.basis === "scored" ? aw.awareness_score : null,
        category_rank: aw.basis === "scored" ? aw.category_rank : null,
        score_adj: aw.basis === "scored" ? (awAdjByKey[g.key]?.awareness_score_adj ?? null) : null,
        category_rank_adj: aw.basis === "scored" ? (awAdjByKey[g.key]?.category_rank_adj ?? null) : null,
        organic_confidence: aw.basis === "scored" ? (awAdjByKey[g.key]?.organic_confidence ?? null) : null,
      } : null,
      // scored = 정상 / insufficient_organic = 유료 의심 제외 후 표본 부족(원값만 보유)
      core_fan_estimate: cf && (cf.basis === "scored" || cf.basis === "insufficient_organic") ? {
        est_engaged_fans: cf.est_engaged_fans,
        est_active_core: cf.est_active_core,
        est_engaged_fans_adj: cfAdjByKey[g.key]?.est_engaged_fans_adj ?? null,
        est_active_core_adj: cfAdjByKey[g.key]?.est_active_core_adj ?? null,
        basis: cf.basis,
      } : null,
```

- [ ] **Step 4: Run** — `cd frontend && pnpm vitest run` 전체 PASS + `pnpm tsc --noEmit` (또는 프로젝트 lint 스크립트) clean.

- [ ] **Step 5: Commit** (ASCII subject)

```bash
git add frontend/functions/api/market.ts frontend/tests/functions/api_market.test.ts
git commit -m "feat(api): market exposes organic-trust adjusted awareness/core fields"
```

---

### Task 7: MarketOverview 표시 전환 (모델: sonnet)

**Files:**
- Modify: `frontend/src/views/MarketOverview.tsx`
- Test: `frontend/src/views/MarketOverview.test.ts`

**Interfaces:**
- Consumes: Task 6 응답 형태 (`score_adj`/`category_rank_adj`/`organic_confidence`, `est_engaged_fans_adj`/`basis`).
- Produces: 표시·정렬 헬퍼 — `awarenessDisplay(aw): { score, rank, discounted }` (adj-first 폴백), `coreDisplay(cf): { value, insufficientOrganic }`. (기존 `fmtAwareness`, `sortByAwareness`, `tableSortValue`는 이 헬퍼 기반으로 수정.)

- [ ] **Step 1: Write the failing tests** — MarketOverview.test.ts에 추가:

```ts
describe("V2.53 organic trust display", () => {
  it("awarenessDisplay prefers adj and marks discounted", () => {
    expect(awarenessDisplay({ score: 76.1, category_rank: 3, score_adj: 38.4, category_rank_adj: 7, organic_confidence: 0.506 }))
      .toEqual({ score: 38.4, rank: 7, discounted: true });
  });
  it("awarenessDisplay falls back to raw when adj null (unmigrated)", () => {
    expect(awarenessDisplay({ score: 50, category_rank: 2, score_adj: null, category_rank_adj: null, organic_confidence: null }))
      .toEqual({ score: 50, rank: 2, discounted: false });
  });
  it("coreDisplay hides value on insufficient_organic", () => {
    expect(coreDisplay({ est_engaged_fans: 218, est_active_core: 18, est_engaged_fans_adj: null, est_active_core_adj: null, basis: "insufficient_organic" }))
      .toEqual({ value: null, insufficientOrganic: true });
  });
  it("coreDisplay prefers adj value", () => {
    expect(coreDisplay({ est_engaged_fans: 218, est_active_core: 18, est_engaged_fans_adj: 120, est_active_core_adj: 9, basis: "scored" }))
      .toEqual({ value: 120, insufficientOrganic: false });
  });
  it("tableSortValue awareness/core use adjusted values", () => {
    const g = { awareness: { score: 76.1, score_adj: 38.4 }, core_fan_estimate: { est_engaged_fans: 218, est_engaged_fans_adj: 120, basis: "scored" } };
    expect(tableSortValue("awareness", "k", g, {})).toBe(38.4);
    expect(tableSortValue("core", "k", g, {})).toBe(120);
  });
});
```

(기존 export 여부 확인 — `tableSortValue`가 미export면 export 추가. 신규 헬퍼 2개는 export.)

- [ ] **Step 2: Run to verify fail** — `cd frontend && pnpm vitest run src/views/MarketOverview.test.ts` → FAIL.

- [ ] **Step 3: Implement**

헬퍼 (기존 `fmtAwareness` 인근):

```ts
export interface AwarenessV253 extends Awareness {
  score_adj?: number | null; category_rank_adj?: number | null;
  organic_confidence?: number | null;
}
// adj-first: mig 0106 적용 + organicity 채점 그룹만 adj 보유. 미적용/구 스냅샷은 원값 폴백.
export function awarenessDisplay(aw: AwarenessV253 | null | undefined) {
  if (!aw) return { score: null, rank: null, discounted: false };
  const discounted = aw.score_adj != null;
  return {
    score: aw.score_adj ?? aw.score ?? null,
    rank: (aw.category_rank_adj ?? aw.category_rank) ?? null,
    discounted,
  };
}
export function coreDisplay(cf: any) {
  if (!cf) return { value: null, insufficientOrganic: false };
  if (cf.basis === "insufficient_organic") return { value: null, insufficientOrganic: true };
  return { value: cf.est_engaged_fans_adj ?? cf.est_engaged_fans ?? null, insufficientOrganic: false };
}
```

수정 지점:
- `tableSortValue`: `case "awareness": return awarenessDisplay(g.awareness).score;` / `case "core": return coreDisplay(g.core_fan_estimate).value;`
- `sortByAwareness`: `ra/rb`를 `awarenessDisplay(...).rank`로.
- 인지도 셀(447행 인근): `awarenessDisplay` 결과로 렌더. `discounted`면 셀 `title`에 `` `원값 ${aw.score} · 신뢰 계수 ${aw.organic_confidence} — 유료 의심 영상 비중만큼 할인` `` 부여, 값 옆 rank는 보정 순위.
- 추정 코어 셀(458행 인근): `coreDisplay` 사용. `insufficientOrganic`이면 `<span class="text-zinc-600" title="유료 의심 영상 제외 후 표본 부족 — 추정 보류">—</span>`.
- 산점도/사분면 points 구성부(377·383행 인근): **원값 유지** — `g.awareness?.score`/`est_active_core`(raw)를 계속 사용하는지 확인만 하고 변경하지 않는다.
- HELP 카피 갱신:
  - `awareness`: `"인지 폭(0~100). 카테고리 리더 대비 구독·조회·뉴스 log 정규화 후 organicity 신뢰 계수로 할인한 보정값(원값은 셀 툴팁). #N = 보정값 기준 카테고리 내 순위."`
  - `core`: `"추정 코어 = 최근 56일 영상별 '좋아요' 중앙값(고유 반응 팬 근사). 유료 의심(suspect/likely_paid) 영상은 제외. 추정 휴리스틱 — 실측 아님."`
  - `quad`: 끝에 `" 사분면의 인지도는 할인 전 원값 — '넓지만 얕음(광고형)' 패턴 탐지가 목적."` 추가.
  - `caveat`: `"...직교 참고 신호."` → `"...인지도·추정 코어에는 신뢰 할인으로 반영됨(V2.53)."`
  - ⚠ 배지 인라인 title(495행 인근)의 "인지도 점수엔 미반영(직교 참고)" 문구도 동일하게 교체.

- [ ] **Step 4: Run** — `cd frontend && pnpm vitest run` 전체 PASS + tsc clean + `pnpm build` 성공.

- [ ] **Step 5: Commit** (ASCII subject)

```bash
git add frontend/src/views/MarketOverview.tsx frontend/src/views/MarketOverview.test.ts
git commit -m "feat(ui): MarketOverview shows organic-trust adjusted awareness/core"
```

---

### Task 8: 산식 문서·스펙 노출 갱신 (모델: sonnet)

**Files:**
- Modify: `docs/analysis-formulas-reference.md` (인지도·추정 코어·Health 게이트 섹션)
- Modify: `frontend/src/components/HealthSpec.tsx` 및/또는 `frontend/functions/api/health/spec.ts` (스펙 표면에 PRE 게이트 조건 문구가 있으면 debut_confirmed 추가 — 없으면 skip하고 커밋 메시지에 명기)

**Interfaces:**
- Consumes: Task 1~4 확정 산식 (파일 `file:line` 인용 방식은 문서 기존 관례를 따름).

- [ ] **Step 1: `docs/analysis-formulas-reference.md` 갱신** — 새 섹션 "Organic Confidence (V2.53)"에 VERDICT_WEIGHTS·PRIOR·K·n=0 규칙·적용처(인지도 곱셈 할인, 코어 median 제외 필터)·BTHD 검산 예(0.506) 기록. 인지도 섹션에 `awareness_score_adj`/`category_rank_adj`, 추정 코어 섹션에 `insufficient_organic` basis, Health 섹션 게이트 조건에 `debut_confirmed=0` 추가. 각 산식에 `file:line` 인용.
- [ ] **Step 2: HealthSpec 표면 확인·갱신** — `grep -n "PRE\|데뷔" frontend/src/components/HealthSpec.tsx frontend/functions/api/health/spec.ts`로 게이트 문구 유무 확인 후 있으면 "정식 데뷔 미확정(잠정 앵커) 포함" 반영.
- [ ] **Step 3: Run** — `cd frontend && pnpm vitest run` (컴포넌트 수정 시) PASS.
- [ ] **Step 4: Commit**

```bash
git add docs/analysis-formulas-reference.md frontend/src/components/HealthSpec.tsx frontend/functions/api/health/spec.ts
git commit -m "docs: V2.53 organic trust layer formulas reference"
```

---

### Task 9: 통합 검증 (메인 세션)

- [ ] worker 전체 `uv run pytest tests -q` + frontend `pnpm vitest run` + `pnpm build` 최종 확인.
- [ ] 로컬 D1 migration 적용 상태에서 `python -m idol_sight aggregate` 스모크(가능 범위) 또는 빌더 3종 단위 실행으로 INSERT 문 생성 확인.
- [ ] superpowers:requesting-code-review로 리뷰 → 지적 반영.
- [ ] main push는 사용자 확인 후. **원격 D1 migration 0105~0107 apply는 운영자(사용자) 직접** — 적용 전까지 프론트·워커는 원값 폴백으로 동작함을 사용자에게 안내.
- [ ] 볼트 노트 `01_Projects/앱·서비스/idol-sight.md` 진행 요약 append + 다음 액션 갱신.
