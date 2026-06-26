# P1 — 산식 정확도 버그·구조 수정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** idol-sight 점수 산식의 명백한 로직·구조 결함을 표적 수정하고, Twitter를 산식에서 제거하며, 그로 드러난 논란 감지 단절을 커뮤니티 sentiment로 복구한다 — 각 수정에 회귀 테스트 포함.

**Architecture:** 접근법 A(표적 수정). "보정 예정" 임계값 재튜닝은 하지 않는다(별도 B 단계). 변경은 worker(Python, `worker/src/idol_sight/analysis/*`, `llm/prompts.py`)와 frontend(React/TS, `frontend/src/views/GroupContent.tsx`)에 국한. 각 task = 독립 테스트 가능 단위, TDD(실패 테스트 → 구현 → 통과 → 커밋).

**Tech Stack:** Python 3.12 + pytest(uv), TypeScript + vitest, Cloudflare D1(SQLite).

## Global Constraints

- **접근법 A 경계**: loyalty 앵커·organicity ER/balance 경계 등 "보정 예정" 임계값은 **이 플랜에서 재튜닝 금지**(B 단계로 이연).
- **점수 변동 허용**: `changes_scores` task는 일부 그룹 점수를 이동시킨다 — 이는 *의도된 교정*. 회귀 테스트에 "교정 전/후 값"을 픽스처로 고정해 의도성을 문서화한다.
- **K-POP / 서브컬처 분리 유지**: 서브컬처 코호트 결함을 카테고리 **병합으로 풀지 않는다**(옵션 b: category_z를 점등 필수에서 빼고 temporal_z+wow 사용).
- **Twitter 산식 완전 제외**: SOV 가중치·진단 축에서 제거. DB 컬럼/수집기 물리 삭제는 하지 않는다(P4).
- **SOV 가중치(확정, 합=1.0)**: yt_views 0.33 / community 0.28 / news 0.22 / subscribers 0.17.
- **논란 재소싱**: `controversy_count`를 `community_posts(sentiment='controversy')`의 **최근 윈도우(7~14일, posted_at 기준)** 카운트로. 누적 금지(Health 영구 0 붕괴 방지). `_controversy_factor(/10)`·alert(≥5건) 임계는 **이 플랜에서 바꾸지 말고** community 볼륨 sanity 관찰 포인트만 기록.
- **위기 알림 거버넌스**: controversy_spike 알림은 오탐 시 Streisand 위험 — 인간검증 전제 문구 유지.
- **테스트 실행**: worker는 `worker/` 디렉터리에서 `uv run python -m pytest ...`(plain `python -m pytest`는 `ModuleNotFoundError: idol_sight`). frontend는 `frontend/`에서 `npx vitest run ...`.
- **커밋 trailer**: 모든 커밋에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**구현 순서(의존성)**: Task 1(market_share) → Task 2(agg controversy 재소싱) → Task 3~4(진단: twitter 제거 후 서브컬처) → Task 5(health ritual) → Task 6(velocity) → Task 7~8(UI/copy). Task 2가 Task 3의 controversy_spike 입력을 만든다.

> 설계서: `docs/superpowers/specs/2026-06-27-p1-scoring-accuracy-fixes-design.md`

---

### Task 1: market_share.py: SOV all-equal/all-zero 신호 기여 0 + 가중치 재정규화(§3.1) & Twitter 산식 제거·가중치 재분배(§3.5) — 단일 최종본

**score_impact:** `changes_scores`

**Files:**
- Modify: worker/src/idol_sight/analysis/market_share.py:18-23
- Modify: worker/src/idol_sight/analysis/market_share.py:39-45
- Modify: worker/src/idol_sight/analysis/market_share.py:49-73
- Modify: worker/src/idol_sight/analysis/market_share.py:76-78
- Modify: worker/src/idol_sight/analysis/market_share.py:101-105
- Modify: worker/src/idol_sight/analysis/market_share.py:125-131
- Modify: worker/src/idol_sight/analysis/market_share.py:134-143
- Test: `worker/tests/unit/test_market_share.py`

**Implementation notes / interfaces (read before editing):**

검증 완료(실제 적용→pytest→복원). 핵심 설계: _percentile_rank가 all-equal(전부 0 포함) 신호에 대해 [None]*n 반환(반환 타입 list[float|None]) → _compose_score가 None 신호를 분모/분자 모두에서 제외하고 가용 신호로 재정규화(denom==0이면 0.0). 이 일반 해법이 (a)twitter 제거 후 미수집 신호 all-zero, (b)mom의 subscribers [0.0]*n 모두를 자동 처리.\n인터페이스 주의 — _compute_sov의 루프 `for sig in SOV_WEIGHTS`가 cum_ranks[sig]/mom_ranks[sig]를 인덱싱하므로 cum_signal·mom_signal dict의 키 집합이 SOV_WEIGHTS 키와 정확히 일치해야 KeyError가 안 난다. 따라서 twitter 행은 두 dict에서 제거하되, mom의 subscribers 행([0.0]*len)은 키 유지를 위해 남겨둔다(값이 all-zero라 None→자동 드롭됨).\n호출부 영향 없음 — worker/src/idol_sight/cli.py:1255가 여전히 groups dict에 "twitter" 키를 넣지만 _compute_sov가 더 이상 읽지 않아 무해(설계 §3.5: DB 컬럼/수집기 물리 삭제는 P4). cli SQL의 twitter_posts SELECT도 그대로 둬도 됨.\nn==1(단일 그룹)은 의도적으로 [1.0] 유지(코호트 유일점 → 100% 정상). all-equal 분기(`if all(v==values[0] ...)`)는 n>=2에서만 도달하므로 기존 `avg_rank/(n-1) if n>1 else 1.0`의 else 가지는 죽은 코드가 되어 `/(n-1)`로 단순화함.\n기존 테스트 정합 — test_sov_signals_no_longer_dominated_by_yt_views(plave>isedol>owis, plave<70, 합≈100)는 새 코드에서도 통과(plave 66.67/isedol 33.33/owis 0.0). test_sov_zero_signals_yields_zero_share도 `< 30.0` 단언이라 통과하나, 교정으로 miiwan.final이 20.0(pre-fix)→0.0(post-fix)으로 바뀐다. 권장(선택): 이 기존 테스트의 단언을 `assert miiwan.final == 0.0`로 조여 교정 후 값을 핀하고, 낡은 주석 'Still gets a tiny share via tied percentile rank'를 'all-zero signals now contribute nothing → exactly 0'로 갱신(설계 §3.5 수용기준 '기존 SOV 테스트가 새 가중치로 갱신' 충족). 이 변경은 점수가 아니라 테스트 단언만 조이는 것.\n상호작용 결론 — twitter 제거만으로는 다른 미수집 신호의 all-zero 0.5 버그가 남으므로 (1)이 일반 해법이고, 둘은 같은 _compose_score 재정규화 경로에서 동시에 해결됨.

- [ ] **Step 1 — Write the failing test(s)**

Append to `worker/tests/unit/test_market_share.py`:

```
# ─── P1 §3.1 SOV normalization bug + §3.5 Twitter removal ───────────────

def test_percentile_rank_all_equal_signal_injects_no_constant():
    """A cohort-wide tie (every group identical, incl. all-zero) carries no
    ranking information, so every element is None — NOT the old 0.5 constant
    that flattened the SOV distribution toward uniform.

    Pre-fix:  _percentile_rank([0, 0, 0])  == [0.5, 0.5, 0.5]
    Post-fix: _percentile_rank([0, 0, 0])  == [None, None, None]
    """
    from idol_sight.analysis.market_share import _percentile_rank
    assert _percentile_rank([0.0, 0.0, 0.0]) == [None, None, None]
    assert _percentile_rank([7.0, 7.0]) == [None, None]
    # Non-degenerate signals still rank normally (unchanged behavior).
    assert _percentile_rank([0.0, 1.0]) == [0.0, 1.0]


def test_compose_score_renormalizes_over_available_signals():
    """Unavailable signals (None rank) are dropped and the remaining weights
    re-normalized — they are NOT scored as a 0 contribution that would shrink
    every group's score by the dead signal's weight.
    """
    from idol_sight.analysis.market_share import _compose_score, SOV_WEIGHTS
    # Only yt_views present, ranked 1.0 → full 1.0 (weight renormalized to 1).
    only_yt = {"yt_views": 1.0, "community": None,
               "news": None, "subscribers": None}
    assert abs(_compose_score(only_yt) - 1.0) < 1e-9
    # yt_views 1.0 + community 0.0, rest dead → 0.33/(0.33+0.28) ≈ 0.541.
    two_live = {"yt_views": 1.0, "community": 0.0,
                "news": None, "subscribers": None}
    assert abs(_compose_score(two_live) - (0.33 / (0.33 + 0.28))) < 1e-9
    # No signal available → 0.0 (no constant injected).
    assert _compose_score({k: None for k in SOV_WEIGHTS}) == 0.0


def test_sov_weights_sum_to_one_and_exclude_twitter():
    """§3.5: twitter dropped, its 0.10 redistributed → 4 signals, sum 1.0."""
    from idol_sight.analysis.market_share import SOV_WEIGHTS
    assert "twitter" not in SOV_WEIGHTS
    assert set(SOV_WEIGHTS) == {"yt_views", "community", "news", "subscribers"}
    assert SOV_WEIGHTS == {
        "yt_views": 0.33, "community": 0.28, "news": 0.22, "subscribers": 0.17,
    }
    assert abs(sum(SOV_WEIGHTS.values()) - 1.0) < 1e-9


def test_sov_dead_signal_no_longer_flattens_distribution():
    """§3.1: when ONE signal is cohort-wide dead (news all-zero) and momentum
    is dead (all deltas 0), the remaining live signals' spread must be
    preserved, not compressed toward uniform by a 0.5 floor.

    Live cum signals rank A:B:C as 1.0:0.5:0.0 (values 1000:100:10), so the
    intended SOV is the clean 66.67 / 33.33 / 0 split (×0.6 cum weight, mom
    dead → 0).

    Pre-fix (news→0.5, twitter→0.5, mom all→0.5):
        A.final ≈ 47.33, B.final ≈ 33.33, C.final ≈ 19.33   (C floored up!)
    Post-fix (dead signals dropped):
        A.final == 40.0,  B.final == 20.0,  C.final == 0.0
    """
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "a", "yt_views": 1000, "comm_total": 1000, "news": 0,
             "subscribers": 1000,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
            {"key": "b", "yt_views": 100, "comm_total": 100, "news": 0,
             "subscribers": 100,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
            {"key": "c", "yt_views": 10, "comm_total": 10, "news": 0,
             "subscribers": 10,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
        ],
    )
    a = next(r for r in rows if r.group_key == "a")
    b = next(r for r in rows if r.group_key == "b")
    c = next(r for r in rows if r.group_key == "c")
    # Live-signal spread preserved (2 : 1 : 0), not flattened.
    assert abs(a.final - 40.0) < 0.01
    assert abs(b.final - 20.0) < 0.01
    assert c.final == 0.0
    # Dead news signal injects no floor: the bottom group stays at 0.
    assert abs(sum(r.final for r in rows) - 60.0) < 0.05  # mom dead → cum*0.6


def test_sov_all_dead_momentum_injects_no_share():
    """§3.1: subscribers/twitter-style all-zero momentum rows must contribute
    no constant. With every delta 0, momentum carries no information → final
    is driven purely by the cumulative signals (final == cum * 0.6).

    Pre-fix: the all-zero mom signals scored 0.5 → mom_pct split the cohort
    50/50 (live 77.0 / dormant 23.0), lifting the dormant group's final.
    Post-fix: mom contributes 0 (live 60.0 / dormant 0.0).
    """
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "live",     "yt_views": 100, "comm_total": 100, "news": 100,
             "subscribers": 100,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
            {"key": "dormant",  "yt_views": 1,   "comm_total": 1,   "news": 1,
             "subscribers": 1,
             "delta_yt_views": 0, "delta_comm": 0, "delta_news": 0},
        ],
    )
    live = next(r for r in rows if r.group_key == "live")
    dormant = next(r for r in rows if r.group_key == "dormant")
    # cum: live 1.0 → 100%, dormant 0.0 → 0%. mom dead → 0 for both.
    assert live.mom == 0.0 and dormant.mom == 0.0
    assert abs(live.final - 60.0) < 0.01    # 100% cum * 0.6
    assert dormant.final == 0.0


def test_sov_normal_cohort_relative_rank_preserved():
    """§3.1 acceptance (3): an ordinary cohort with every signal live keeps
    its relative ranking after the fix. Distinct, monotonic signals → the
    same A > B > C order, now with twitter removed and re-weighted.

    Pre-fix (5 signals incl twitter, mom subscribers/twitter→0.5):
        A.final ≈ 61.33, B.final ≈ 33.33, C.final ≈ 5.33   (C floored up)
    Post-fix (4 signals, dead mom subscribers dropped):
        A.final == 66.67, B.final == 33.33, C.final == 0.0
    Ordering A > B > C is preserved across the change (intended).
    """
    rows = compute_market_share(
        week_start="2026-04-22", week_end="2026-04-28",
        groups=[
            {"key": "a", "yt_views": 1000, "comm_total": 1000, "news": 1000,
             "subscribers": 1000,
             "delta_yt_views": 100, "delta_comm": 100, "delta_news": 100},
            {"key": "b", "yt_views": 100, "comm_total": 100, "news": 100,
             "subscribers": 100,
             "delta_yt_views": 10, "delta_comm": 10, "delta_news": 10},
            {"key": "c", "yt_views": 10, "comm_total": 10, "news": 10,
             "subscribers": 10,
             "delta_yt_views": 1, "delta_comm": 1, "delta_news": 1},
        ],
    )
    a = next(r for r in rows if r.group_key == "a")
    b = next(r for r in rows if r.group_key == "b")
    c = next(r for r in rows if r.group_key == "c")
    assert a.final > b.final > c.final          # relative rank preserved
    assert abs(a.final - 66.67) < 0.01
    assert abs(b.final - 33.33) < 0.01
    assert c.final == 0.0
    assert abs(sum(r.final for r in rows) - 100.0) < 0.05
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
worker 디렉터리에서 실행: `uv run python -m pytest tests/unit/test_market_share.py -q` (검증 완료: 기존 6 + 신규 6 = 12 passed). 단일 케이스: `uv run python -m pytest tests/unit/test_market_share.py -k dead_signal -q`. 주의: `python -m pytest` 단독은 venv 밖이라 `ModuleNotFoundError: idol_sight` 발생 → 반드시 `uv run` 경유.
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `worker/src/idol_sight/analysis/market_share.py:18-23` (and the other Files above) to:

```
"""Share of Voice computation (spec §7.2 — V2 reformulation).

What used to be called "Market Share" was really *Share of Voice* (SOV)
— the share of the cohort's measured cross-platform attention, not the
share of the actual K-pop market (which has a defined denominator like
Circle Chart). The previous formula summed raw counts across signals
(yt_views + dc_posts + naver*100 …) which let a single 99%-weighted
signal (yt_views) dominate everything; PLAVE's reported 51% was largely
an artifact of that, not a reflection of real attention split.

V2 normalizes each signal independently before mixing them so that no
one source can dominate. Each component is converted to a unit-less
[0, 1] cohort rank (linear-interpolated percentile across the active
groups), then weighted, then re-normalized to a 0–100 share. A signal
whose cohort-wide values are all identical (including the all-zero case)
carries no ranking information, so it contributes nothing and the
remaining weights are re-normalized over the signals that are actually
available — it does NOT inject a uniform 0.5 constant that would flatten
the distribution toward uniform. Cumulative and momentum components stay
separate so the BI can show both "long-term standing" and "this-week
motion".

Input shape (per group):
  - yt_views, comm_total, news, subscribers (cumulative window)
  - delta_yt_views, delta_comm, delta_news (this-week motion)

Weights (sum = 1.0):
  yt_views 33%, comm 28%, news 22%, subscribers 17%

Output dataclass field names stay ``cum``/``mom``/``final`` so
downstream code (agg_market_share table, frontend) keeps working —
``ShareRow`` is now interpreted as SOV rather than market share.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

ALPHA_CUM = 0.6
BETA_MOM = 0.4

# Cohort-relative weights for the SOV mix. They must sum to 1.0.
# Twitter was dropped from the formula (collection is permanently dead);
# its old 0.10 weight is redistributed proportionally across the four
# surviving signals.
SOV_WEIGHTS = {
    "yt_views":    0.33,
    "community":   0.28,
    "news":        0.22,
    "subscribers": 0.17,
}
assert abs(sum(SOV_WEIGHTS.values()) - 1.0) < 1e-9


def _percentile_rank(values: list[float]) -> list[float | None]:
    """Linear percentile rank in [0, 1] preserving input order.

    Tied values get the average of their ranks. Returns a list aligned to
    ``values``. Empty list → empty list. Single value → [1.0] (it's the
    cohort's only point).

    If every value is identical (this includes the all-zero case — e.g. a
    signal nobody collected this week), the signal carries no ranking
    information: every element is ``None`` so callers can drop it instead
    of injecting a uniform 0.5 constant that would flatten the SOV
    distribution toward uniform.
    """
    n = len(values)
    if n == 0:
        return []
    if n == 1:
        return [1.0]
    if all(v == values[0] for v in values):
        return [None] * n
    indexed = sorted(range(n), key=lambda i: values[i])
    ranks: list[float | None] = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and values[indexed[j + 1]] == values[indexed[i]]:
            j += 1
        # Average rank for the tie group, normalized so max → 1.0.
        avg_rank = (i + j) / 2.0
        for k in range(i, j + 1):
            ranks[indexed[k]] = avg_rank / (n - 1)
        i = j + 1
    return ranks


def _compose_score(group_ranks: dict[str, float | None]) -> float:
    """Weighted average of the *available* normalized cohort ranks → SOV [0,1].

    A signal whose cohort-wide values are all identical (or all zero)
    yields a ``None`` rank (see ``_percentile_rank``) and is dropped here;
    the remaining weights are re-normalized over the signals that are
    actually present. If no signal is available the score is 0 (no
    constant is injected).
    """
    num = 0.0
    denom = 0.0
    for k, w in SOV_WEIGHTS.items():
        r = group_ranks.get(k)
        if r is None:
            continue
        num += w * r
        denom += w
    return num / denom if denom > 0 else 0.0


@dataclass
class ShareRow:
    week_start: str
    week_end: str
    group_key: str
    cum: float          # cumulative SOV share % (0-100)
    mom: float          # momentum SOV share % (0-100)
    final: float        # weighted final SOV share %


def compute_market_share(
    *,
    week_start: str,
    week_end: str,
    groups: list[dict[str, Any]],
) -> list[ShareRow]:
    """Compute SOV per group from cohort-relative percentile ranks.

    ``groups`` accepts two shapes for backwards compatibility:

    1. New (preferred): each item carries the raw cohort signals
       (yt_views, comm_total, news, subscribers,
       delta_yt_views, delta_comm, delta_news). The function computes
       per-signal percentile ranks across the cohort and mixes them per
       SOV_WEIGHTS.

    2. Legacy: items only carry ``cum_score``/``mom_score`` (single
       numbers). In that case we fall back to the v1 raw-sum
       normalization so existing tests keep passing.
    """
    if not groups:
        return []

    has_signals = any("yt_views" in g for g in groups)
    if has_signals:
        return _compute_sov(week_start, week_end, groups)
    return _compute_legacy(week_start, week_end, groups)


def _compute_sov(
    week_start: str, week_end: str, groups: list[dict[str, Any]],
) -> list[ShareRow]:
    keys = [g["key"] for g in groups]
    # Cumulative ranks
    cum_signal = {
        "yt_views":   [float(g.get("yt_views", 0) or 0) for g in groups],
        "community":  [float(g.get("comm_total", 0) or 0) for g in groups],
        "news":       [float(g.get("news", 0) or 0) for g in groups],
        "subscribers": [float(g.get("subscribers", 0) or 0) for g in groups],
    }
    cum_ranks = {sig: _percentile_rank(vals) for sig, vals in cum_signal.items()}

    # Momentum: delta of the high-volume signals only (yt/community/news).
    # Subscribers don't deliver useful weekly deltas yet — we'd be comparing
    # two snapshots that may both be empty — so it stays all-zero and is
    # dropped automatically by the all-equal → no-contribution rule.
    mom_signal = {
        "yt_views":   [max(float(g.get("delta_yt_views", 0) or 0), 0.0) for g in groups],
        "community":  [max(float(g.get("delta_comm", 0) or 0), 0.0) for g in groups],
        "news":       [max(float(g.get("delta_news", 0) or 0), 0.0) for g in groups],
        "subscribers": [0.0] * len(groups),
    }
    mom_ranks = {sig: _percentile_rank(vals) for sig, vals in mom_signal.items()}

    # Per-group cohort score, then re-normalize to a 0-100 share so the
    # cohort sums to 100% (zero-sum SOV).
    cum_scores = []
    mom_scores = []
    for i, _ in enumerate(keys):
        cum_scores.append(_compose_score({sig: cum_ranks[sig][i] for sig in SOV_WEIGHTS}))
        mom_scores.append(_compose_score({sig: mom_ranks[sig][i] for sig in SOV_WEIGHTS}))

    cum_total = sum(cum_scores) or 0.0
    mom_total = sum(mom_scores) or 0.0

    rows: list[ShareRow] = []
    for i, k in enumerate(keys):
        cum_pct = (cum_scores[i] / cum_total * 100.0) if cum_total > 0 else 0.0
        mom_pct = (mom_scores[i] / mom_total * 100.0) if mom_total > 0 else 0.0
        final = cum_pct * ALPHA_CUM + mom_pct * BETA_MOM
        rows.append(ShareRow(
            week_start=week_start, week_end=week_end, group_key=k,
            cum=round(cum_pct, 2), mom=round(mom_pct, 2),
            final=round(final, 2),
        ))
    return rows


def _compute_legacy(
    week_start: str, week_end: str, groups: list[dict[str, Any]],
) -> list[ShareRow]:
    cum_total = sum(g.get("cum_score", 0) for g in groups) or 0
    mom_total = sum(g.get("mom_score", 0) for g in groups) or 0

    rows: list[ShareRow] = []
    for g in groups:
        cum_pct = (g.get("cum_score", 0) / cum_total * 100.0) if cum_total > 0 else 0.0
        mom_pct = (g.get("mom_score", 0) / mom_total * 100.0) if mom_total > 0 else 0.0
        final = cum_pct * ALPHA_CUM + mom_pct * BETA_MOM
        rows.append(ShareRow(
            week_start=week_start, week_end=week_end,
            group_key=g["key"],
            cum=round(cum_pct, 2), mom=round(mom_pct, 2),
            final=round(final, 2),
        ))
    return rows


def to_statements(rows: list[ShareRow], *, market_total: int) -> list[tuple[str, list]]:
    """Convert rows to D1 INSERT statements for agg_market_share."""
    out: list[tuple[str, list]] = []
    for r in rows:
        out.append((
            """
            INSERT INTO agg_market_share
              (week_start, week_end, group_key, cum, mom, final, market_total)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(week_start, group_key) DO UPDATE SET
              week_end=excluded.week_end,
              cum=excluded.cum, mom=excluded.mom, final=excluded.final,
              market_total=excluded.market_total
            """.strip(),
            [r.week_start, r.week_end, r.group_key,
             r.cum, r.mom, r.final, market_total],
        ))
    return out
```

- [ ] **Step 4 — Run the test, expect PASS**

```
worker 디렉터리에서 실행: `uv run python -m pytest tests/unit/test_market_share.py -q` (검증 완료: 기존 6 + 신규 6 = 12 passed). 단일 케이스: `uv run python -m pytest tests/unit/test_market_share.py -k dead_signal -q`. 주의: `python -m pytest` 단독은 venv 밖이라 `ModuleNotFoundError: idol_sight` 발생 → 반드시 `uv run` 경유.
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): market_share.py: SOV all-equal/all-zero 신호 기여 0 + 가중치 재정규화(§3.1) & Twitter 산식 제거·가중치 재분배(§3.5) — 단일 최종본" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: controversy_count를 community_posts(sentiment='controversy') 최근 윈도우 카운트로 재소싱

**score_impact:** `changes_scores`

**Files:**
- Modify: worker/src/idol_sight/analysis/agg_summary.py:87-95
- Modify: worker/src/idol_sight/analysis/agg_summary.py:18
- Modify: worker/src/idol_sight/analysis/agg_summary.py:11
- Test: `worker/tests/unit/test_agg_summary.py`

**Implementation notes / interfaces (read before editing):**

추가 편집 2건(코어 블록 외, 정확한 anchor):
(A) 모듈 상수 추가 — line 18 `from idol_sight.collectors.base import CollectionResult` 바로 다음(빈 줄 유지)에 삽입:
```python
# Controversy is re-sourced from community_posts (sentiment='controversy')
# over a TRAILING window — not a cumulative all-time count. The downstream
# health_score._controversy_factor = max(0, 1 - count/10) is raw-count
# based, so a cumulative community tally would grow without bound and pin
# Health (and the crisis alert) to 0 forever. 14d sits at the top of the
# design's 7-14d range: enough signal for a stable cohort-z on the
# deliberately rare 'controversy' label, still bounded.
CONTROVERSY_WINDOW_DAYS = 14
```
(B) 모듈 docstring line 11 교체:
  current: `- twitter_posts, controversy_count (from twitter_posts; controversy = type)`
  target:
```
- twitter_posts (legacy Twitter volume column; count only)
- controversy_count (from community_posts WHERE sentiment='controversy'
  over the last CONTROVERSY_WINDOW_DAYS by posted_at — NOT cumulative;
  Twitter no longer contributes)
```

스키마/컬럼 확인 완료: community_posts(migrations/0001_init.sql:72)에 posted_at TEXT(nullable)·collected_at TEXT NOT NULL, sentiment TEXT(migrations/0006_community_sentiment.sql:24, 인덱스 idx_comm_sentiment(group_key,sentiment)). posted_at은 0082 백필로 UTC 'YYYY-MM-DDTHH:MM:SSZ'. 윈도우는 설계 지시대로 posted_at 기준(collected_at 아님 — 논란 발생시점 기준). 윈도우 idiom은 alerts/__init__.py:334-341 rule_model_theft가 community_posts.posted_at에 쓰는 `posted_at >= datetime('now','-N days')` 사전(lexicographic 비교; ISO Z가 datetime('now') 결과보다 항상 ≥ 이므로 동일초 경계만 영향 — 무해). sentiment.py:168-173의 negative_ratio 집계는 의도적으로 윈도우 없음(비율이라 안전); controversy는 raw count라 반드시 윈도우 필요 — 둘을 혼동하지 말 것.

실측 검증(in-memory sqlite, sqlite 3.45): 14d 윈도우가 30d 과거 controversy·NULL posted_at·비-controversy를 정확히 배제(plave 2건만 카운트). 누적 붕괴 방지 동작 확인.

점수 영향(score_impact=changes_scores): 단일 교체 지점에서 3 소비자가 자동 전환 — health_score.py:665 `_controversy_factor(agg['controversy_count'])`(Health 위험배수), weekly_diagnosis.py:874-876 `controversy_count_z`(controversy_spike 진단), alerts/__init__.py:186-218 위기 알림. 재소싱 후 controversy_count가 0(twitter 사망)→실데이터로 살아나 위 점수/알림이 이동. 이는 설계 §3.6의 의도된 교정.

임계 sanity(관찰 포인트, 이 plan에서 변경 금지): `_controversy_factor`의 `/10` floor와 위기 알림의 `≥5건 & ≥2x`는 twitter 볼륨 기준 — community 'controversy' 14d 볼륨이 크게 다르면 어긋날 수 있음. 재소싱 직후 D1 실측(MEMORY: D1 agg_summary, 사용자 `!` 직접조회)으로 14d community-controversy 분포 1회 점검만 수행, 임계 재튜닝은 B/별도 단계. 변경 시 governance-runbook 근거 기록.

NULL posted_at 동작: 윈도우 비교가 NULL을 false로 떨궈 자동 제외 — 정상(시점 없는 post는 recency 윈도우에 배치 불가). model_theft 쿼리와 동일.

기존 테스트 영향: test_agg_summary.py의 3개 기존 테스트는 모두 그린 유지 — 새 twitter 쿼리는 count만 읽고(fixture의 controversy_count 필드는 미사용·무해), community controversy needle 미공급 시 controversy=0이라 기존 params[12]==0 핀이 그대로 성립. 기존 테스트 수정 불필요(twitter 미유출·baseline 0 핀 역할 유지).

라우팅 주의: 새 community controversy SQL에는 'platform' 부분문자열이 없어 기존 platform-count 쿼리('...GROUP BY group_key, platform')와 needle 충돌 없음. controversy needle은 `sentiment='controversy'`(고유). 새 twitter SQL은 여전히 'twitter_posts' 포함. 세 needle 상호 disjoint.

범위 경계: 본 작업은 §3.6 controversy 재소싱만. §3.5 Twitter 산식 제거(SOV 가중치·twitter_z 진단 축 제거, twitter 카운트 컬럼 물리삭제)는 별도 작업 — 여기서는 twitter_posts COUNT 컬럼(index 11)을 보존하고 controversy SUM만 제거. UPSERT/_UPSERT의 twitter_posts 컬럼·바인딩은 손대지 않음.

- [ ] **Step 1 — Write the failing test(s)**

Append to `worker/tests/unit/test_agg_summary.py`:

```
def test_controversy_count_sourced_from_community_sentiment():
    """교정 후 의도된 차이: controversy_count는 community_posts
    (sentiment='controversy')의 최근 윈도우 카운트에서 나온다. 과거
    twitter type='controversy'는 더 이상 기여하지 않는다 — 이 fixture의
    twitter controversy_count=99 는 무시돼야 한다.
    """
    client = _client_returning({
        "platform": [
            {"group_key": "plave", "platform": "dc", "n": 1000},
        ],
        "naver_articles": [],
        "youtube_channel_stats": [],
        "youtube_video_stats": [],
        # community controversy windowed query (distinct needle).
        "sentiment='controversy'": [
            {"group_key": "plave", "n": 3},
        ],
        # legacy twitter source — its controversy_count must NOT leak.
        "twitter_posts": [
            {"group_key": "plave", "n": 30, "controversy_count": 99},
        ],
    })
    result = build_agg_summary(client, snapshot_at="2026-06-27T00:00:00Z")
    by_group = {params[0]: params for _sql, params in result.statements}
    # controversy (index 12) == community window count, NOT twitter's 99.
    assert by_group["plave"][12] == 3
    # twitter column (index 11) still carries the twitter post count.
    assert by_group["plave"][11] == 30


def test_twitter_posts_no_longer_contributes_controversy():
    """교정 전 값 고정 회귀: twitter type='controversy'만 있고 community
    controversy가 윈도우에 없으면 controversy_count는 0 — twitter 기여가
    완전히 끊겼음을 핀한다(과거 소스가 다시 살아나면 이 테스트가 깨진다).
    """
    client = _client_returning({
        "platform": [
            {"group_key": "plave", "platform": "dc", "n": 500},
        ],
        "naver_articles": [],
        "youtube_channel_stats": [],
        "youtube_video_stats": [],
        # no community controversy rows in the recency window.
        "sentiment='controversy'": [],
        "twitter_posts": [
            {"group_key": "plave", "n": 42, "controversy_count": 17},
        ],
    })
    result = build_agg_summary(client, snapshot_at="2026-06-27T00:00:00Z")
    by_group = {params[0]: params for _sql, params in result.statements}
    assert by_group["plave"][12] == 0      # twitter controversy ignored
    assert by_group["plave"][11] == 42     # twitter count preserved


def test_controversy_query_is_windowed_to_recent_posted_at():
    """누적 붕괴 방지: controversy 카운트는 전체 누적이 아니라 최근
    CONTROVERSY_WINDOW_DAYS(posted_at 기준) 윈도우로 산출돼야 한다. 윈도우
    밖 과거 controversy는 DB단 datetime('now', ?) 컷오프로 제외된다 — 그
    컷오프 계약을 SQL/param 수준에서 고정한다(mock은 SQL을 실행하지 않으므로
    윈도우 자체는 계약으로 핀; 실제 배제는 community_posts.posted_at 비교가
    수행).
    """
    from idol_sight.analysis.agg_summary import CONTROVERSY_WINDOW_DAYS
    client = _client_returning({
        "sentiment='controversy'": [{"group_key": "plave", "n": 2}],
        "twitter_posts": [],
    })
    build_agg_summary(client, snapshot_at="2026-06-27T00:00:00Z")

    controversy_calls = [
        c for c in client.execute.call_args_list
        if "sentiment='controversy'" in c.args[0]
    ]
    assert len(controversy_calls) == 1
    sql = controversy_calls[0].args[0]
    params = controversy_calls[0].args[1]
    # sourced from community_posts, filtered to controversy, windowed.
    assert "community_posts" in sql
    assert "posted_at >= datetime('now'" in sql
    # the window is the configured trailing window, not all-time.
    assert params == [f"-{CONTROVERSY_WINDOW_DAYS} days"]
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_agg_summary.py -v
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `worker/src/idol_sight/analysis/agg_summary.py:87-95` (and the other Files above) to:

```
    # Twitter posts (count only). Controversy is NO LONGER sourced from
    # here: Twitter collection is dead, so type='controversy' is
    # permanently empty. The COUNT is kept for the legacy `twitter`
    # column (physical Twitter removal is a separate P4 item); controversy
    # is re-sourced from community sentiment just below.
    rows = client.execute(
        "SELECT group_key, COUNT(*) AS n "
        "FROM twitter_posts GROUP BY group_key"
    )
    for r in rows:
        counts[r["group_key"]]["twitter"] = r["n"]

    # Controversy count — re-sourced from community_posts sentiment
    # (LLM-classified 'controversy'). WINDOWED to the last
    # CONTROVERSY_WINDOW_DAYS by posted_at so the count measures *current*
    # controversy pressure, not lifetime volume (a cumulative count would
    # grow unbounded and pin _controversy_factor — and Health — to 0).
    # posted_at is UTC (migration 0082); the lexicographic compare against
    # datetime('now', ?) is the same idiom the community alerts use
    # (alerts.rule_model_theft). Rows with NULL posted_at fall outside the
    # window and are excluded — correct: an un-timestamped post can't be
    # placed in the recency window.
    rows = client.execute(
        "SELECT group_key, COUNT(*) AS n "
        "FROM community_posts "
        "WHERE sentiment='controversy' "
        "  AND posted_at >= datetime('now', ?) "
        "GROUP BY group_key",
        [f"-{CONTROVERSY_WINDOW_DAYS} days"],
    )
    for r in rows:
        counts[r["group_key"]]["controversy"] = r["n"]
```

- [ ] **Step 4 — Run the test, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_agg_summary.py -v
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): controversy_count를 community_posts(sentiment='controversy') 최근 윈도우 카운트로 재소싱" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: P1 §3.5 — Twitter 축 산식·진단 제거 (controversy_spike는 재소싱 신호로 유지)

**score_impact:** `changes_scores`

**Files:**
- Modify: worker/src/idol_sight/analysis/weekly_diagnosis_signals.py:370-375
- Modify: worker/src/idol_sight/analysis/weekly_diagnosis.py:381-385
- Modify: worker/src/idol_sight/analysis/weekly_diagnosis.py:570-578
- Modify: worker/src/idol_sight/analysis/weekly_diagnosis.py:742-747
- Modify: worker/src/idol_sight/analysis/weekly_diagnosis.py:870-873
- Modify: worker/tests/unit/test_weekly_diagnosis_signals.py:21
- Modify: worker/tests/unit/test_weekly_diagnosis_signals.py:329-333
- Modify: worker/tests/unit/test_weekly_diagnosis.py:37-39
- Modify: worker/tests/unit/test_weekly_diagnosis.py:208
- Modify: worker/tests/unit/test_weekly_diagnosis.py:221
- Modify: worker/tests/unit/test_weekly_diagnosis.py:350-437
- Modify: worker/tests/unit/test_weekly_diagnosis.py:546-563
- Modify: worker/tests/unit/test_weekly_diagnosis.py:698-727
- Test: `worker/tests/unit/test_weekly_diagnosis.py`

**Implementation notes / interfaces (read before editing):**

검증 완료: 5개 프로덕션 hunk 적용 후 전체 그린(110 passed). 인터페이스: twitter_controversy_z 는 weekly_diagnosis 외 소비자 0건(grep 확인)이라 시그널 모듈에서 안전 삭제 가능. \n\n[필수 동반 수정 — 기존 테스트 미수정 시 ImportError/순서밀림으로 깨짐]\n(a) test_weekly_diagnosis_signals.py:21 import 목록에서 `twitter_controversy_z,` 줄 삭제 + :329-333 `test_twitter_controversy_z` 함수 통째 삭제(삭제 안 하면 모듈 ImportError 로 전 테스트 collect 실패).\n(b) test_weekly_diagnosis.py: `_base_signal_bundle()` controversy dict(:37-39)·`test_controversy_one_signal_high`(:208)·`test_controversy_keyword_z_lit`(:221) 에서 `\"twitter_z\": ...,` 키 제거(코드가 더 이상 읽지 않으므로 잔존해도 무해하지만 컨벤션 정합 위해 제거).\n(c) [중요] E2E 3개 테스트의 db.execute.side_effect 에서 8번째 항목(twitter 쿼리 응답 `[]`)을 반드시 제거. twitter_rows 쿼리 삭제로 execute 호출이 16→15개가 되어, 미제거 시 9번째 이후 stub 이 한 칸씩 당겨져 groups_meta 가 엉뚱한 데이터를 받아 category 로직이 깨짐(실측: subculture/dedup 테스트 어설션 실패). 대상: organic_growth_e2e(:415 `# 8) twitter...` + 그 `[]` 삭제, 주석 9~13→8~12 재번호), deduplicates_multi_row(:546 `# 3-10) ...8개` 8 empty→7 empty `# 3-9)`), subculture_falls_back(:698 `# 3-10) ...` 8 empty→7 empty). \nscore_impact=changes_scores: controversy_spike 진단 evidence 에서 twitter 축이 사라지고, twitter 단독 점등 케이스가 비점등으로 바뀜(설계 §3.5 ⚠️). 단 controversy_count_z(§3.6 재소싱)·negative_ratio_z·keyword_z 경로는 불변.

- [ ] **Step 1 — Write the failing test(s)**

Append to `worker/tests/unit/test_weekly_diagnosis.py`:

```
# ── test_weekly_diagnosis_signals.py 파일 하단에 추가 ──
import idol_sight.analysis.weekly_diagnosis_signals as _Smod


def test_twitter_controversy_z_removed_from_module():
    """P1: twitter 수집 불가 확정 → twitter_controversy_z 산식 축 완전 제거.
    교정 전: cohort_z_score 래퍼가 존재했음. 교정 후: 심볼 자체가 없어야 함."""
    assert not hasattr(_Smod, "twitter_controversy_z")


# ── test_weekly_diagnosis.py 파일 하단에 추가 ──
def test_controversy_spike_no_twitter_input():
    """P1: controversy 시그널 dict 에 twitter_z 키가 아예 없어도 동작.
    교정 후: 재소싱된 controversy_count_z + community 부정 키워드로만 점등."""
    sig = _base_signal_bundle()
    sig["controversy"] = {
        "keyword_z": 2.6,
        "controversy_count_z": 2.2,
        "negative_ratio_z": 0.1,
    }
    hyps = classify_hypotheses(sig)
    co = next((h for h in hyps if h.key == "controversy_spike"), None)
    assert co is not None
    assert co.confidence == "high"
    assert not any("twitter" in e.key.lower() for e in co.evidence)


def test_controversy_spike_twitter_axis_gone_no_false_light():
    """교정 전/후 차이 고정: '오직 twitter_z 만 컸던' 상황은 이제 점등 불가.
    교정 전: twitter_z>=2.0 단독으로 controversy_spike 가 high 로 점등했다.
    교정 후: twitter 축 제거 → 나머지 z 가 모두 임계 미만이면 점등 안 함(None)."""
    sig = _base_signal_bundle()
    sig["controversy"] = {
        "keyword_z": 0.0,
        "controversy_count_z": 0.0,
        "negative_ratio_z": 0.0,
    }
    hyps = classify_hypotheses(sig)
    assert not any(h.key == "controversy_spike" for h in hyps)
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && .venv/bin/python -m pytest tests/unit/test_weekly_diagnosis.py tests/unit/test_weekly_diagnosis_signals.py -q
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `worker/src/idol_sight/analysis/weekly_diagnosis_signals.py:370-375` (and the other Files above) to:

```
# === weekly_diagnosis_signals.py:370-379 → (함수 통째 삭제, 상수만 남김) ===
IRRELEVANT_RATIO_THRESHOLD = 0.15

# === weekly_diagnosis.py:376-386 → (twitter_z 분기 삭제) ===
    if co["negative_ratio_z"] >= CONTROVERSY_Z_THRESHOLD:
        evidence.append(Evidence(
            "negative_ratio_z", co["negative_ratio_z"],
            f"부정 감성 비율 z={co['negative_ratio_z']:.1f}",
        ))
    if co["keyword_z"] >= CONTROVERSY_Z_THRESHOLD:

# === weekly_diagnosis.py:570-579 → (twitter_rows 쿼리 삭제, irrelevant_rows 만 남김) ===
    irrelevant_rows = db.execute(

# === weekly_diagnosis.py:741-748 → (twitter_by 빌드 삭제) ===
        comm_kw_past_by.setdefault(gk, []).append(float(r.get("neg_total") or 0))
    irrelevant_by: dict[str, list[dict]] = {}

# === weekly_diagnosis.py:865-874 → (controversy dict 에서 twitter_z 키 삭제) ===
            "controversy": {
                "keyword_z":             _S.negative_keyword_z(
                    comm_kw_now_by.get(gk, []),
                    comm_kw_past_by.get(gk, []),
                ),
                "controversy_count_z":   _S.cohort_z_score(
```

- [ ] **Step 4 — Run the test, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && .venv/bin/python -m pytest tests/unit/test_weekly_diagnosis.py tests/unit/test_weekly_diagnosis_signals.py -q
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): P1 §3.5 — Twitter 축 산식·진단 제거 (controversy_spike는 재소싱 신호로 유지)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: P1 §3.3 — 서브컬처 진단 복원(옵션 b): _is_lit 가 category_z 를 카테고리별로 분기(서브컬처는 temporal_z+wow_pct만으로 점등)

**score_impact:** `changes_scores`

**Files:**
- Modify: worker/src/idol_sight/analysis/weekly_diagnosis.py:80-91
- Modify: worker/src/idol_sight/analysis/weekly_diagnosis.py:827-831
- Test: `worker/tests/unit/test_weekly_diagnosis.py`

**Implementation notes / interfaces (read before editing):**

최소 변경 채택 — category 를 _is_lit 시그니처/13개 호출부에 스레딩하지 않고 axis entry dict 에 'category' 키를 심는 방식(프로덕션 2곳만 수정: _is_lit 본문 + _axis 반환). _is_lit 에 전달되는 entry 는 전부 _axis()(closure, gk 보유)에서 생성되므로 모든 subs/views/news/community 가 동일 category 를 받음. category_by_group(weekly_diagnosis.py:596 정의)는 _axis(810행) 스코프에 이미 존재. \n\n검증: 적용 후 그린, 그리고 _is_lit 분기를 원복하면 test_is_lit_subculture_excludes_category_z 가 실패함을 확인(테스트 비-vacuous). \n\n주의/엣지: (1) 카테고리 판별 경로 = groups.group_model → _S._category_of (corporate→kpop, segmentary/confederation→subculture), category_by_group 에 매핑(596-600행). (2) 현 운영상 서브컬처 코호트 2개<CATEGORY_COHORT_MIN(3) 이라 category_z 는 이미 0 fallback — 따라서 흔한 케이스에선 동작 동일(점수 불변)이고, 코호트가 3+로 커져 cross-sectional z 가 노이즈로 켜질 때 그 노이즈를 무시하는 게 실제 동작 변화점. 그래서 changes_scores 로 표기하되 영향은 제한적. (3) 카테고리 병합 폴백은 채택 안 함(설계 §2.3 카테고리 분리 유지). (4) _evidence_3axis(:107-110)는 category_z 라벨을 여전히 보일 수 있으나 서브컬처는 category_z=0 이라 실무상 출력 안 됨 — 라벨 일관성까지 원하면 동일 분기 추가 가능하나 설계는 _is_lit 만 명시, 최소 변경 위해 미수정. (5) _check_paid_youtube_ads(:161-163)의 subs_views_gap 은 category_z 를 직접 사용 — 서브컬처에선 0 이라 그 1점은 못 얻음(기존 동작, 본 task 범위 밖). deltas['subs_z'] 등은 여전히 category_z 값을 노출하므로 서브컬처는 0 유지(기존 E2E 어설션 불변).

- [ ] **Step 1 — Write the failing test(s)**

Append to `worker/tests/unit/test_weekly_diagnosis.py`:

```
# ── test_weekly_diagnosis.py 파일 하단에 추가 ──
def _sub_axis(*, z: float = 0.0, t: float = 0.0, w: float | None = None) -> dict:
    """서브컴처 그룹 entry — _is_lit 가 category_z 축을 무시해야 함."""
    return {"category_z": z, "temporal_z": t, "wow_pct": w, "category": "subculture"}


def test_is_lit_subculture_excludes_category_z():
    """P1 (2): 서브컴처 entry 는 category_z 축을 점등에서 제외.
    동일 값이라도 K-POP 은 category_z 로 점등, 서브컴처는 점등 안 됨."""
    sub_entry = _sub_axis(z=2.5, t=0.3, w=0.01)
    assert _is_lit(sub_entry, wow_threshold=0.05) is False
    kpop_entry = {**sub_entry, "category": "kpop"}
    assert _is_lit(kpop_entry, wow_threshold=0.05) is True


def test_is_lit_subculture_lights_via_temporal():
    """서브컴처는 temporal_z 로 점등 (category_z 죽어도 무관)."""
    assert _is_lit(_sub_axis(z=0.0, t=1.8, w=None), wow_threshold=0.05) is True


def test_is_lit_subculture_lights_via_wow():
    """서브컴처는 wow_pct 로도 점등."""
    assert _is_lit(_sub_axis(z=0.0, t=0.0, w=0.07), wow_threshold=0.05) is True


def test_is_lit_default_category_is_kpop_unchanged():
    """category 키 부재 entry (기존 호출부/유닛테스트) → kpop 동작 불변."""
    entry = {"category_z": 2.0, "temporal_z": 0.3, "wow_pct": 0.01}
    assert _is_lit(entry, wow_threshold=0.05) is True


def test_subculture_organic_growth_lit_via_temporal_only():
    """서브컴처 그룹이 cross-sectional category_z 없이 temporal_z 만으로 organic 점등.
    교정 후: category 분기로 subs/views/news/community 4축이 temporal 로 살아남 →
    market_share_z(=0) 없이도 4개 점등 → organic_growth high."""
    sig = _base_signal_bundle()
    sig["subs"]      = _sub_axis(t=2.1)
    sig["views"]     = _sub_axis(t=1.8)
    sig["news"]      = _sub_axis(t=1.7)
    sig["community"] = _sub_axis(t=1.6)
    sig["er_wow"] = 0.02
    hyps = classify_hypotheses(sig)
    assert any(h.key == "organic_growth" for h in hyps)


def test_kpop_organic_growth_unchanged_via_category_z():
    """K-POP 동작 불변 회귀: category_z 축으로 4+1 점등 시 organic high."""
    sig = _base_signal_bundle()
    sig["subs"]      = _axis(z=1.8)
    sig["views"]     = _axis(z=2.0)
    sig["news"]      = _axis(z=1.6)
    sig["community"] = _axis(z=1.7)
    sig["market_share_z"] = 1.5
    sig["er_wow"] = 0.02
    hyps = classify_hypotheses(sig)
    organic = next((h for h in hyps if h.key == "organic_growth"), None)
    assert organic is not None
    assert organic.confidence == "high"
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && .venv/bin/python -m pytest tests/unit/test_weekly_diagnosis.py -q -k "is_lit or subculture or organic_growth"
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `worker/src/idol_sight/analysis/weekly_diagnosis.py:80-91` (and the other Files above) to:

```
# === weekly_diagnosis.py:80-91 → (_is_lit: subculture 일 때 category_z 축 제외) ===
    """sig dict 의 한 entry (subs/views/news/community 형식) 가 3-축 OR 판정.

    sig_entry: {"category_z": float, "temporal_z": float, "wow_pct": float | None,
                "category": "kpop" | "subculture"}
    셋 중 *하나만* 점등이면 True. routine 변동은 모든 축 미달, 진짜 spike 는
    어느 한 축에서 잡힘 — cohort 분포 비대칭 (kpop vs subculture) 영향 제거.

    서브컴처 코호트는 표본 2개라 cross-sectional category_z 가 구조적으로
    노이즈(또는 CATEGORY_COHORT_MIN 미달 시 0 fallback) — 점등 필수 축에서
    category_z 를 빼고 temporal_z + wow_pct (그룹 자기 history) 로만 판정한다.
    K-POP 은 3-축 전부 사용 (불변). category 키 부재 시 'kpop' 으로 취급.
    """
    if sig_entry.get("category") != "subculture":
        if sig_entry.get("category_z", 0.0) >= z_threshold:
            return True
    if sig_entry.get("temporal_z", 0.0) >= z_threshold:
        return True
    wow = sig_entry.get("wow_pct")
    return wow is not None and wow >= wow_threshold

# === weekly_diagnosis.py:827-831 → (_axis 반환 dict 에 category 주입) ===
        return {
            "category_z": _S.cohort_z_score(now_val, cohort_vals),
            "temporal_z": _S.temporal_z_score(now_val, history_vals),
            "wow_pct":    _S.wow_pct(now_val, prev_val if prev else None),
            "category":   category_by_group.get(gk, "kpop"),
        }
```

- [ ] **Step 4 — Run the test, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && .venv/bin/python -m pytest tests/unit/test_weekly_diagnosis.py -q -k "is_lit or subculture or organic_growth"
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): P1 §3.3 — 서브컬처 진단 복원(옵션 b): _is_lit 가 category_z 를 카테고리별로 분기(서브컬처는 temporal_z+wow_pct만으로 점등)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: RitualVictory 0.8 천장 해소 — music_show_wins만 코호트-dead일 때 재분배 (hanteo/news/chart는 redistribute=False 유지)

**score_impact:** `changes_scores`

**Files:**
- Modify: worker/src/idol_sight/analysis/health_score.py:581-587 (ritual 블록 — 본 task의 current/target_code)
- Modify: worker/src/idol_sight/analysis/health_score.py:462-465 (_factor_inputs 시그니처 — notes의 [EDIT A])
- Modify: worker/src/idol_sight/analysis/health_score.py:476 (L 직후 CL 정의 추가 — notes의 [EDIT B])
- Modify: worker/src/idol_sight/analysis/health_score.py:666 (compute_health_score 내 _factor_inputs 호출부 — notes의 [EDIT C])
- Modify: worker/src/idol_sight/analysis/health_score.py:156-161 (V2.16 ritual 주석 정합 — notes의 [EDIT D], 선택)
- Test: `worker/tests/unit/test_health_score.py`

**Implementation notes / interfaces (read before editing):**

검증완료(임시패치→테스트→revert): 교정 전 ritual factor = 24.0(케이스A, 0.80천장)·9.0(케이스B), 교정 후 = 30.0·11.25. 전체 31 passed, 기존 29건 무회귀. 두 신규 테스트는 unpatched 소스에서 정확히 red(24.0≠30.0, 9.0≠11.25).

본 task는 4곳(+선택1곳) 비연속 편집. current/target_code는 핵심 ritual 블록(:581-587). 나머지는 아래 그대로 적용:

[EDIT A] _factor_inputs 시그니처(:462-465). cohort_live 파라미터 추가.
  before:
    live_metrics: set[str] | frozenset[str] | None = None,
    ) -> dict[str, float]:
  after:
    live_metrics: set[str] | frozenset[str] | None = None,
    cohort_live: set[str] | frozenset[str] | None = None,
    ) -> dict[str, float]:
(주의: :464의 live_metrics 줄과 :611 compute_health_score의 live_metrics 줄이 동일 텍스트 — 반드시 _factor_inputs 본체(:464)만. Edit old_string에 바로 다음 ') -> dict[str, float]:' 까지 포함해 유일화할 것.)

[EDIT B] :476 'L = ...' 직후 CL 정의 삽입.
  before:
    L = live_metrics if live_metrics is not None else _ALL_METRICS
    sub_n = _normalize(agg.get("yt_subscribers", 0), r["subscribers"])
  after:
    L = live_metrics if live_metrics is not None else _ALL_METRICS
    # Cohort-level liveness (before the per-group intersection). Lets the
    # ritual factor tell "music_show is dead across the WHOLE cohort"
    # (stub collector → redistribute its weight) apart from "this one
    # group has no wins while others do" (a genuine penalty). Defaults to
    # L for direct callers (unit tests) that pass no separate cohort set.
    CL = cohort_live if cohort_live is not None else L
    sub_n = _normalize(agg.get("yt_subscribers", 0), r["subscribers"])

[EDIT C] :666 호출부에 cohort_live 전달.
  before: fi = _factor_inputs(agg, r, live_metrics=L)
  after:  fi = _factor_inputs(agg, r, live_metrics=L, cohort_live=cohort_L)
  (cohort_L은 :621 에서 이미 정의됨: live_metrics if not None else _ALL_METRICS — cohort-level live set. L=:630은 per-group 교집합. 둘을 구분 전달하는 것이 본 수정의 핵심.)

[EDIT D] (선택, 주석 정합) :156-161 V2.16 ritual 주석에 music_show 예외 한 문단 추가:
  추가 문단(끝 'redistribute=True.' 다음에):
    #
    # P1: music_show_wins is the one ritual signal exempt from this. Its
    # collector is a stub (dead across the whole cohort), so leaving its
    # 0.20 weight in the denominator capped ritual at 0.80 for every
    # group. When music_show is cohort-dead the ritual block drops its
    # part so the weight redistributes; when it's cohort-alive but a
    # single group has no wins, the part stays as a genuine penalty.

설계 결정/엣지: (a) _wmean(:336)은 변경 안 함 — 인라인 'parts + ([음방항목] if 'music_show_wins' in CL else [])' 방식으로 per-part 재분배를 표현해 최소 변경. (b) 코호트-dead vs per-group-dead 구분이 핵심: 'music_show_wins' in CL(코호트 살아있음)이면 항목 유지(per-group 0win은 alive=False로 페널티), CL에 없으면(stub 코호트 전멸) 항목 자체를 빼 분모에서 제거→재분배. (c) 직접 호출 _factor_inputs(agg, refs) (intimacy 단위테스트)는 cohort_live=None→CL=L=_ALL_METRICS이라 music_show 포함, 기존 동작 불변. (d) news_n은 _normalize_log이라 1.0 도달엔 naver_total_news>=news ref 필요(테스트는 1000 vs ref 200으로 clamp). (e) 기존 무회귀 확인: test_ritual_does_not_redistribute_when_hanteo_absent / test_music_show_wins_signal_lifts_ritual(둘 다 L에 music_show 포함→CL 포함→항목 유지) 및 chart_peak/chart_depth 테스트(L={'chart_peak'} 등, music_show drop되며 단조성·포화 순서 보존) 모두 통과.

- [ ] **Step 1 — Write the failing test(s)**

Append to `worker/tests/unit/test_health_score.py`:

```
# ─── P1 RitualVictory 0.8 천장 — music_show 코호트-dead 재분배 ───────────


def test_ritual_reaches_full_when_music_show_cohort_dead():
    """P1 — 음방(music_show_wins) 수집기가 코호트 전체에서 죽어 있을 때
    (stub collector), 그 0.20 weight가 분모에만 남아 ritual을 0.80에서
    막던 버그를 교정.

    교정 전(music_show 분모 잔존): hanteo/news/chart 만점이어도 ritual
    factor = 24.0 (0.80 천장).
    교정 후(코호트-dead music_show 재분배): ritual factor = 30.0.
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    agg = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        naver_total_news=1_000,      # log normalize → news_n clamps to 1.0
        hanteo_sales=1_000_000,      # millennium seller → hanteo_n = 1.0
        melon_top100_peak=1,         # chart_peak_n = 1.0
        melon_top100_depth=5,        # chart_depth_n = depth/ref = 1.0
    )
    refs = {
        "subscribers": 1_000_000, "views": 200_000_000,
        "quality": 0.05, "community": 200_000, "news": 200,
        "music_show_wins": 5.0, "chart_depth": 5.0,
    }
    # 코호트에 music_show_wins 없음 (stub) → 재분배 대상.
    L = {"subscribers", "views", "news", "quality",
         "hanteo", "chart_peak", "chart_depth"}
    score = compute_health_score(
        "x", agg, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    # corporate ritual weight 30 × ritual_input 1.0 × risk 1.0 = 30.0.
    assert score.factors["ritual"] == pytest.approx(30.0)


def test_ritual_penalty_preserved_when_hanteo_absent_under_dead_music_show():
    """P1 — music_show 재분배가 켜져도 hanteo 부재는 여전히 페널티.

    hanteo/news/chart_peak/chart_depth는 redistribute=False 유지이므로
    hanteo가 빠진 그룹은 ritual=1.0에 도달하지 못한다. 같은 코호트-dead
    music_show 조건에서 hanteo만 빠지면 ritual factor가 11.25로 막힌다
    (교정 전 9.0 — 둘 다 30.0과 거리가 멀어 hanteo가 재분배되지 않음).
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    agg = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        naver_total_news=1_000,      # news_n = 1.0
        hanteo_sales=0,              # ← hanteo 부재 (per-group dead)
        melon_top100_peak=1,         # chart_peak_n = 1.0
        melon_top100_depth=5,        # chart_depth_n = 1.0
    )
    refs = {
        "subscribers": 1_000_000, "views": 200_000_000,
        "quality": 0.05, "community": 200_000, "news": 200,
        "music_show_wins": 5.0, "chart_depth": 5.0,
    }
    # 코호트엔 hanteo 있음(다른 그룹) but music_show 없음.
    L = {"subscribers", "views", "news", "quality",
         "hanteo", "chart_peak", "chart_depth"}
    score = compute_health_score(
        "x", agg, debut_date=past, refs=refs,
        group_model="corporate", live_metrics=L,
    )
    # hanteo(0.50) dead지만 weight는 분모에 잔존 → ritual_input =
    # (0 + 0.10 + 0.10 + 0.10) / (0.50 + 0.10 + 0.10 + 0.10) = 0.375.
    # factor = 0.375 × 30 = 11.25. 페널티가 유지되어 30.0에 못 미친다.
    assert score.factors["ritual"] == pytest.approx(11.25)
    assert score.factors["ritual"] < 30.0
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && uv run python -m pytest tests/unit/test_health_score.py -q
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `worker/src/idol_sight/analysis/health_score.py:581-587 (ritual 블록 — 본 task의 current/target_code)` (and the other Files above) to:

```
        # RitualVictory — initial-album mobilization (Hanteo) + news
        # spike + music-show wins + 음원 차트 진입(peak) + 음원 차트
        # 깊이(depth). V2.16 redistribute=False 유지.
        # V2.19: chart_peak 0.20 → 0.10, chart_depth 0.10 신설 — 운영
        # 첫날 PLAVE 케이스(realtime 6곡 / day 1곡 진입)에서 best rank
        # 단독으로는 곡 깊이 변별이 안 됨을 발견. 차트 축 0.20을
        # peak/depth 반반 배정.
        # P1: hanteo/news/chart_peak/chart_depth stay redistribute=False
        # (absence = real ritual loss → penalty). music_show_wins is the
        # exception: its collector is a stub, so when it's dead across
        # the WHOLE cohort (not in CL) its 0.20 weight used to sit in the
        # denominator and cap ritual at 0.80 for everyone (corporate
        # groups chronically ~6% low on total). We drop the part in that
        # case so the weight redistributes (penalty 0). When music_show
        # is cohort-alive but THIS group has no wins, the part stays
        # (alive=False) and reads as a genuine penalty.
        "ritual": _wmean(
            [
                (hanteo_n,      0.50, "hanteo"      in L),
                (news_n,        0.10, "news"        in L),
                (chart_peak_n,  0.10, "chart_peak"  in L),
                (chart_depth_n, 0.10, "chart_depth" in L),
            ]
            + (
                [(music_show_n, 0.20, "music_show_wins" in L)]
                if "music_show_wins" in CL
                else []
            ),
            redistribute=False,
        ),
```

- [ ] **Step 4 — Run the test, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && uv run python -m pytest tests/unit/test_health_score.py -q
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): RitualVictory 0.8 천장 해소 — music_show_wins만 코호트-dead일 때 재분배 (hanteo/news/chart는 redistribute=False 유지)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 낡은 주석 정정 — sparse-collector defense에서 'dc/theqoo/instiz scrapers paused since V2.11' 단정 제거

**score_impact:** `none`

**Files:**
- Modify: worker/src/idol_sight/analysis/health_score.py:147-154
- Test: `worker/tests/unit/test_health_score.py`

**Implementation notes / interfaces (read before editing):**

주석 전용 편집 — 점수/동작 불변. '실제론 정상 작동(V2.28 기능 존재)'이라는 설계서 §3.8 근거대로 'paused since V2.11' 거짓 단정만 제거하고 sparse-collector 방어 '목적'은 유지. 함께 stub 예시로 music_show_wins를 명시(현재 실제로 비활성 stub). test_code는 코드 영역 미오염을 보장하는 동작-불변 회귀가드(주석 자체는 단언 불가). Task1과 같은 파일이므로 적용 순서 무관(블록 비인접: :147-154 vs :581-587).

- [ ] **Step 1 — Write the failing test(s)**

Append to `worker/tests/unit/test_health_score.py`:

```
def test_community_metric_dead_cohort_wide_is_dropped_not_zeroed():
    """P1 주석 정정 회귀가드(동작 불변) — sparse-collector defense는
    'paused since V2.11' 단정과 무관하게 코호트 전체에서 죽은 metric을
    재분배로 처리한다. community(dc/theqoo/instiz)가 코호트-dead일 때
    intimacy가 community 0/REF 페널티를 먹지 않고 engagement 단독으로
    재정규화되는지 고정(주석 편집이 코드 영역을 건드리지 않았음을 보증).
    """
    past = (date.today() - timedelta(days=400)).isoformat()
    agg = _agg(
        yt_subscribers=300_000, yt_total_views=30_000_000,
        likes_total=2_000_000, comments_total=200_000,
        dc_total_posts=0, theqoo_posts=0, instiz_posts=0,  # community dead
        naver_total_news=80,
    )
    refs = {"subscribers": 1_000_000, "views": 200_000_000,
            "quality": 0.05, "community": 200_000, "news": 500,
            "music_show_wins": 5.0}
    # community 미포함 = 코호트 전체에서 dead → intimacy에서 재분배되어야.
    L_dead = {"subscribers", "views", "news", "quality"}
    L_live = {"subscribers", "views", "news", "quality", "community"}
    s_dead = compute_health_score("x", agg, debut_date=past, refs=refs,
                                   group_model="segmentary", live_metrics=L_dead)
    s_live = compute_health_score("x", agg, debut_date=past, refs=refs,
                                   group_model="segmentary", live_metrics=L_live)
    # dead(재분배)일 때 community 0 페널티가 없으므로 intimacy가 더 높다.
    assert s_dead.factors["intimacy"] > s_live.factors["intimacy"]
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && uv run python -m pytest tests/unit/test_health_score.py -q
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `worker/src/idol_sight/analysis/health_score.py:147-154` (and the other Files above) to:

```
# Sparse-collector defense: when a metric column has zero signal across
# the entire cohort — e.g. a collector is temporarily offline, or the
# metric is a not-yet-live stub (music_show_wins) — it gets dropped from
# the Health Score formula entirely. Otherwise every group eats a 0/REF
# normalization on that axis and intimacy / community factors collapse —
# the heaviest-weighted bands hit segmentary (40) and confederation (55)
# the worst. Dropping the dead metric and renormalizing the remaining
# weights inside the same factor keeps the score interpretable.
```

- [ ] **Step 4 — Run the test, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && uv run python -m pytest tests/unit/test_health_score.py -q
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): 낡은 주석 정정 — sparse-collector defense에서 'dc/theqoo/instiz scrapers paused since V2.11' 단정 제거" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: docstring을 실제 동작(시간 선형보간)과 일치시킴 (§3.4 docstring)

**score_impact:** `none`

**Files:**
- Modify: worker/src/idol_sight/analysis/video_velocity.py:12-19
- Test: `worker/tests/unit/test_video_velocity.py`

**Implementation notes / interfaces (read before editing):**

순수 문서 수정, 점수/동작 불변. 신규 테스트는 함수-로컬 import 사용(tests/**는 E402 ignore라 ruff OK). 기존 docstring의 'we pick the row closest to (T+24h) and interpolate when needed' 문구가 실제 ±18h 최근접 단일행과 불일치였던 것을 정정.

- [ ] **Step 1 — Write the failing test(s)**

Append to `worker/tests/unit/test_video_velocity.py`:

```
def test_module_docstring_describes_interpolation_not_single_row():
    """Design §3.4: the docstring used to claim we 'pick the row closest to
    (T+24h)' (single nearest row). After the fix it must describe the
    time-weighted interpolation behaviour instead."""
    import idol_sight.analysis.video_velocity as vv
    doc = vv.__doc__ or ""
    assert "pick the row closest" not in doc
    assert "interpolat" in doc.lower()
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_video_velocity.py -q
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `worker/src/idol_sight/analysis/video_velocity.py:12-19` (and the other Files above) to:

```
We compute this locally from ``youtube_video_stats`` snapshots. The
collector samples every 6h, so a video uploaded at T+0 typically has
stat rows around T+6/12/18/24/30h. We take the two snapshots that
*bracket* the +24h mark — the closest one at/before it and the closest
one at/after it, each within ``WINDOW_HOURS`` — and **linearly
interpolate by time** to estimate views at exactly +24h. When only one
side exists (a snapshot was skipped, or the video is too fresh/old to be
bracketed) we fall back to that single raw value and treat the estimate
as low-confidence.

Cached columns on ``youtube_videos``:
  - view_count_24h        — time-interpolated views at ~24h after upload
                            (raw single-snapshot fallback when the +24h
                            mark can't be bracketed; see _interpolate_v24)
  - viral_velocity_ratio  — view_count_24h / channel_mean_24h
```

- [ ] **Step 4 — Run the test, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_video_velocity.py -q
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): docstring을 실제 동작(시간 선형보간)과 일치시킴 (§3.4 docstring)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: _interpolate_v24 헬퍼 추가 + compute_velocity docstring 정정 (§3.4 보간 코어)

**score_impact:** `none`

**Files:**
- Modify: worker/src/idol_sight/analysis/video_velocity.py:40-50
- Test: `worker/tests/unit/test_video_velocity.py`

**Implementation notes / interfaces (read before editing):**

헬퍼 자체는 Task3에서 wiring되기 전엔 dead code라 점수 불변(none). 하지만 §3.4 '플래그로 구분됨' 수용기준을 컬럼 없이 충족하는 핵심: interpolated bool을 반환·단위테스트. 엣지: off==0(스냅샷이 정확히 +24h)이면 before/after 둘 다로 잡혀 span==0 → (v,True)로 고신뢰 처리. span<=0 가드 필수. import 라인을 'from idol_sight.analysis.video_velocity import _interpolate_v24, compute_velocity'로 교체해야 헬퍼 테스트가 import됨(ruff isort 통과 확인). ruff select E,F,I,UP,B,SIM / line-length 100 통과 확인.

- [ ] **Step 1 — Write the failing test(s)**

Append to `worker/tests/unit/test_video_velocity.py`:

```
# 상단 import 라인 교체: 헬퍼를 함께 import (ruff I 정렬상 '_' 가 'c' 보다 앞 → _interpolate_v24, compute_velocity)
# from idol_sight.analysis.video_velocity import _interpolate_v24, compute_velocity

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
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_video_velocity.py -q
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `worker/src/idol_sight/analysis/video_velocity.py:40-50` (and the other Files above) to:

```
class _Executor(Protocol):
    def execute(
        self, sql: str, params: list[Any] | None = ...,
    ) -> list[dict[str, Any]]: ...


def _interpolate_v24(
    rows: list[dict[str, Any]],
) -> tuple[int, bool] | None:
    """Estimate a video's view count at exactly +24h from the snapshots that
    bracket that mark.

    ``rows`` carry ``views`` and ``offset_days`` = julianday(snapshot_at) -
    (julianday(published_at) + 1.0), i.e. the snapshot's signed distance from
    the +24h target in days (negative = before the mark, positive = after).

    Returns ``(v24, interpolated)``:
      - both sides present  → time-weighted linear interpolation to the +24h
        mark, ``interpolated=True``;
      - only one side       → that raw value as a fallback,
        ``interpolated=False`` (low confidence — a snapshot was skipped or the
        video can't be bracketed);
      - no usable snapshot   → ``None`` (caller skips the video).

    NOTE: there is currently no column to persist ``interpolated`` (see design
    §3.4). The flag is computed and unit-tested here so a follow-up migration
    can surface it; for now low-confidence estimates are still written, which
    matches the prior single-row behaviour.
    """
    before: tuple[int, float] | None = None  # closest snapshot at/before +24h
    after: tuple[int, float] | None = None   # closest snapshot at/after  +24h
    for r in rows:
        views = r.get("views")
        off = r.get("offset_days")
        if views is None or off is None:
            continue
        views, off = int(views), float(off)
        if off <= 0.0 and (before is None or off > before[1]):
            before = (views, off)
        if off >= 0.0 and (after is None or off < after[1]):
            after = (views, off)
    if before is not None and after is not None:
        v_b, o_b = before
        v_a, o_a = after
        span = o_a - o_b
        if span <= 0.0:                  # a single snapshot sat on the mark
            return v_b, True
        # Fraction of the way from the before-snapshot to the after-snapshot
        # at which the +24h mark (offset 0) falls.
        w = (0.0 - o_b) / span
        return int(round(v_b + (v_a - v_b) * w)), True
    if before is not None:
        return before[0], False
    if after is not None:
        return after[0], False
    return None


def compute_velocity(client: _Executor) -> CollectionResult:
    """Walk every video published within the last 30 days, estimate its
    +24h view count by interpolating the bracketing stats snapshots, and
    emit one UPDATE per video. Channel-mean ratios are computed in a
    second pass once view_count_24h is populated for the whole channel."""
```

- [ ] **Step 4 — Run the test, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_video_velocity.py -q
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): _interpolate_v24 헬퍼 추가 + compute_velocity docstring 정정 (§3.4 보간 코어)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: per-video 루프: ±18h 최근접 단일행 → +24h 전후 스냅샷 시간 선형보간으로 교체 (§3.4)

**score_impact:** `changes_scores`

**Files:**
- Modify: worker/src/idol_sight/analysis/video_velocity.py:63-79
- Test: `worker/tests/unit/test_video_velocity.py`

**Implementation notes / interfaces (read before editing):**

점수 변동(의도된 교정): v24 → viral_velocity_ratio → reactivity/organicity로 전파. 신규 쿼리는 +24h 전후 각 1행을 UNION ALL로 가져와 최대 2행 반환; params[1]==vid 유지(테스트 by_param 매칭 호환). SQLite는 WHERE에서 SELECT alias(offset_days) 참조 불가 → 식 반복 불가피. 산식: w=(0-o_b)/(o_a-o_b), v24=round(v_b+(v_a-v_b)*w). 검증 완료: 실제 파일에 적용 후 `uv run pytest`로 신규/교체 7케이스 통과, ruff(E,F,I,UP,B,SIM) 통과 확인 후 git checkout으로 원복함. 기존 테스트 중 이 2개(test_pass1, test_pass2_uses_this_cycle_fresh)는 구 픽스처({views,delta})가 offset_days 없어 실패 → 위 동명 함수로 교체해야 함(정확히 이 2개만 실패함을 확인). test_pass2_emits_velocity_ratio_with_leave_one_out_mean / test_pass2_skips_when_only_one_video_in_channel / test_skips_videos_with_no_close_snapshot 3개는 무수정 통과. 신뢰 플래그(_interpolated)는 영속할 컴럼 부재로 P1엔 미저장(=폴백 시에도 v24는 기록). 플래그 영속화는 후속 마이그레이션(예: ALTER TABLE youtube_videos ADD COLUMN view_count_24h_interpolated INTEGER DEFAULT 1)으로 이연 권장.

- [ ] **Step 1 — Write the failing test(s)**

Append to `worker/tests/unit/test_video_velocity.py`:

```
# === 아래 2개는 동명 기존 함수 교체(픽스처에 offset_days 추가) ===

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
    by_vid = {s[1][1]: s[1][0] for s in pass1}
    assert by_vid["v1"] == 500_000
    assert by_vid["v2"] == 1_500_000


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


# === 신규: 보간 교정 전/후 v24·ratio 차이를 픽스처로 고정 ===

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
    v24 = {s[1][1]: s[1][0] for s in result.statements
           if "view_count_24h=" in s[0] and "viral_velocity_ratio" not in s[0]}
    assert v24["vA"] == 600_000     # 700_000 under the old nearest-single code
    assert v24["vB"] == 300_000     # single-side fallback
    ratio = {s[1][1]: s[1][0] for s in result.statements
             if "viral_velocity_ratio=" in s[0]}
    assert abs(ratio["vA"] - 2.0) < 1e-3    # 2.333 under the old code
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_video_velocity.py -q
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `worker/src/idol_sight/analysis/video_velocity.py:63-79` (and the other Files above) to:

```
    for v in videos:
        vid = v["video_id"]
        # Fetch the two snapshots that bracket published_at + 24h: the closest
        # one at/before the mark and the closest one at/after it, each within
        # ±WINDOW_HOURS. _interpolate_v24 time-weights them (or falls back to a
        # single side). offset_days is the snapshot's signed distance from +24h.
        rows = client.execute(
            "SELECT views, offset_days FROM ("
            "  SELECT views, "
            "         julianday(snapshot_at) - julianday(?) - 1.0 AS offset_days "
            "  FROM youtube_video_stats "
            "  WHERE video_id=? "
            "    AND julianday(snapshot_at) - julianday(?) - 1.0 <= 0 "
            "    AND julianday(snapshot_at) - julianday(?) - 1.0 >= -? "
            "  ORDER BY offset_days DESC LIMIT 1"
            ") "
            "UNION ALL "
            "SELECT views, offset_days FROM ("
            "  SELECT views, "
            "         julianday(snapshot_at) - julianday(?) - 1.0 AS offset_days "
            "  FROM youtube_video_stats "
            "  WHERE video_id=? "
            "    AND julianday(snapshot_at) - julianday(?) - 1.0 > 0 "
            "    AND julianday(snapshot_at) - julianday(?) - 1.0 <= ? "
            "  ORDER BY offset_days ASC LIMIT 1"
            ")",
            [
                v["published_at"], vid, v["published_at"], v["published_at"],
                WINDOW_HOURS / 24.0,
                v["published_at"], vid, v["published_at"], v["published_at"],
                WINDOW_HOURS / 24.0,
            ],
        )
        estimate = _interpolate_v24(rows)
        if estimate is None:
            continue
        v24, _interpolated = estimate  # flag not yet persisted (no column)
        statements.append((
```

- [ ] **Step 4 — Run the test, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_video_velocity.py -q
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): per-video 루프: ±18h 최근접 단일행 → +24h 전후 스냅샷 시간 선형보간으로 교체 (§3.4)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: (1) GroupContent.tsx '전략 인사이트'(GroupInsightSection) — humanizeInsightText(title)+InsightBody(body)+TYPE_LABEL 칩 적용 (다른 인사이트 카드와 동일)

**score_impact:** `display_only`

**Files:**
- Modify: frontend/src/views/GroupContent.tsx:14-17 (import 블록 바로 뒤에 import 2줄 추가)
- Modify: frontend/src/views/GroupContent.tsx:1150-1176 (GroupInsightSection: 위에 TYPE_LABEL const 추가 + 함수 본문 수정)
- Test: `frontend/src/lib/insightFormat.test.ts`

**Implementation notes / interfaces (read before editing):**

추가 편집 1건(import) — GroupContent.tsx 14-17행:
현재:
import {
  ALERT_RULE_LABEL as GROUP_ALERT_RULE_LABEL,
  ALERT_SEVERITY_TONE as GROUP_ALERT_TONE,
} from "../lib/alerts";
수정 후(이 블록 바로 아래 2줄 추가):
import { InsightBody } from "../components/InsightBody";
import { humanizeInsightText } from "../lib/insightFormat";

주의: (a) InsightBody 는 props.class 를 `<span class=...>` 에 그대로 부여하므로 span 기본 inline 을 막기 위해 class 에 'block' 포함(다른 뷰 WeeklyUpdate/Insights 와 동일 관용). (b) formatKSTDate 는 GroupContent.tsx:13 에서 이미 import 됨 — 추가 불필요. (c) TYPE_LABEL 은 각 뷰가 로컬 정의하는 기존 패턴(Insights.tsx:11, WeeklyUpdate.tsx:13)을 미러 — Insights.tsx 의 것은 export 되지 않으므로 import 하지 말고 로컬 const 로 추가. GroupContent.tsx 에 기존 TYPE_LABEL 없음(충돌 없음). (d) 값/점수 불변 — 표시 레이어만 변경. (e) diagnosis 등 미정의 type 은 `?? i.type` fallback 으로 안전(기존 뷰들과 동일 동작).

- [ ] **Step 1 — Write the failing test(s)**

Append to `frontend/src/lib/insightFormat.test.ts`:

```
// frontend/src/lib/insightFormat.test.ts 끝에 append.
// 회귀: GroupInsightSection 이 LLM 원문(`**굵게**`·WoW·z=·organic_growth)을
// 그대로 노출하던 표시 버그(값 불변) 수정 후, 이 섹션은 Insights/WeeklyUpdate
// 와 동일하게 humanizeInsightText(title) + InsightBody(=parseInsightBody)(body)
// 를 거친다. 뷰는 node 환경(DOM 없음)이라 렌더 테스트 불가 → 컴포넌트가
// 의존하는 '변환 계약'을 lib 단에서 핀.
describe("GroupContent 전략 인사이트 — humanize/InsightBody 계약 (P1 3.7)", () => {
  const rawTitle = "**플레이브** organic_growth z=2.3 급증";
  const rawBody =
    "**플레이브** 주간 구독자 z=2.3, 조회수 WoW +48% 동반 상승. " +
    "유력 가설은 **organic_growth** 가능성.";

  it("title 은 humanizeInsightText 로 전문 용어/enum 제거", () => {
    const out = humanizeInsightText(rawTitle);
    expect(out).not.toContain("organic_growth");
    expect(out).not.toMatch(/\bz\s*=/);
    expect(out).toContain("자연 유입 성장");
  });

  it("body 토큰(InsightBody 내부 parseInsightBody)에 enum/통계 용어 잔존 없음", () => {
    const tokens = parseInsightBody(rawBody);
    const joined = tokens
      .map((t) => (t.kind === "text" ? t.text : t.kind === "tone" ? t.text : t.label))
      .join("");
    expect(joined).not.toContain("organic_growth");
    expect(joined).not.toContain("WoW");
    expect(joined).not.toMatch(/\bz\s*=/);
    expect(joined).toContain("자연 유입 성장");
    expect(joined).toContain("지난 주 대비 48% 증가");
  });
});

// 수동 검증(JSX 자체 — node env 라 자동화 불가, PR 시 1회 확인):
//  1) npx vite dev → 그룹 상세 탭 진입, '전략 인사이트' 카드 확인.
//  2) type 칩이 'weekly→주간 / insight→인사이트 / ipx_action→IPX 액션'
//     으로 한국어 표기되는지 (미정의 type 은 원문 fallback).
//  3) 제목에 `**...**`·z=·WoW 가 날것으로 안 보이고, 본문이 다른 탭
//     (Insights/WeeklyUpdate)과 동일하게 톤 색/굵기/한국어로 렌더되는지.
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/frontend && npx vitest run src/lib/insightFormat.test.ts
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `frontend/src/views/GroupContent.tsx:14-17 (import 블록 바로 뒤에 import 2줄 추가)` (and the other Files above) to:

```
// scope/type 칩의 의미 라벨 — 다른 인사이트 뷰(Insights/WeeklyUpdate)와 동일.
const TYPE_LABEL: Record<string, string> = {
  weekly: "주간", insight: "인사이트", ipx_action: "IPX 액션",
};

function GroupInsightSection(props: {
  insights: Array<{ id: number; title: string; body: string;
                    scope: string; type: string; generated_at: string }>;
}) {
  return (
    <section>
      <div class="mb-2 flex items-baseline gap-2">
        <h3 class="section-title">전략 인사이트 (LLM weekly · 30일)</h3>
        <span class="text-hint text-zinc-500">
          이 그룹 scope 로 생성된 LLM 분석 — 시장 전체 인사이트는 MarketOverview 에 별도.
        </span>
      </div>
      <ul class="space-y-2">
        {props.insights.map((i) => (
          <li key={i.id}
              class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div class="text-hint text-zinc-500">
              {TYPE_LABEL[i.type] ?? i.type} · {formatKSTDate(i.generated_at)}
            </div>
            <div class="mt-0.5 font-semibold">{humanizeInsightText(i.title)}</div>
            <InsightBody body={i.body} class="mt-1 block text-sm text-zinc-400" />
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4 — Run the test, expect PASS**

```
cd /Users/user/Desktop/idol-sight/frontend && npx vitest run src/lib/insightFormat.test.ts
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): (1) GroupContent.tsx '전략 인사이트'(GroupInsightSection) — humanizeInsightText(title)+InsightBody(body)+TYPE_LABEL 칩 적용 (다른 인사이트 카드와 동일)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: (2) prompts.py 로스터에 wegosix(WE GO-6/위고식스)·uryael(UR:L/유아렐) 추가 — 3곳: 표준 그룹명 표·body formatting 표·scope enum

**score_impact:** `display_only`

**Files:**
- Modify: worker/src/idol_sight/llm/prompts.py:17 (_CANONICAL_NAMES_BLOCK 표 bdawn 행 아래 2줄 추가)
- Modify: worker/src/idol_sight/llm/prompts.py:191 (_BODY_FORMATTING_GUIDELINES GROUP NAME FIDELITY 표 B:DAWN 행 아래 2줄 추가)
- Modify: worker/src/idol_sight/llm/prompts.py:681 (PROMPT_WEEKLY scope enum 괄호 안 enum 확장)
- Test: `worker/tests/unit/test_prompts.py`

**Implementation notes / interfaces (read before editing):**

순수 가산 변경(프롬프트 텍스트만) — 점수/산식 불변. 한/영 표기 출처 검증완료: frontend/src/design/groups.ts:18-19 (wegosix '#f97316 — 23rd Century Kids virtual boy group', uryael '#84cc16 — UR:L (유아렐) Sandbox Network 첫 버추얼'), frontend/src/lib/insightFormat.ts:136-158 (GROUP_LEXICON: wegosix display 'WE GO-6' aliases [WE GO-6/WEGO-6/WEGO6/wegosix/위고식스]; uryael display '유아렐' aliases [유아렐/UR:L/uryael/URL유아렐/URL-유아렐]) — 즉 영문 공식 WE GO-6·UR:L, 한국어 위고식스·유아렐, 둘 다 라벨은 각각 'WE GO-6'·'유아렐' 로 배지 렌더. worker GroupConfig 표기와도 일치(test_relevance.py:181 name='WE GO-6' name_kr='위고식스'). uryael 은 한국어가 primary anchor 라 영문/한국어 모두 '유아렐' 로 badge 되지만, 프롬프트엔 매칭 가능한 두 표기(UR:L, 유아렐) 다 노출해야 LLM 이 어느 쪽을 써도 배지됨. EDIT 표 정렬 공백은 기능 무관(테스트는 substring) — 가독성 위해 기존 열 정렬 흉내만. 기존 test_prompt_weekly_includes_canonical_names_block / test_body_formatting_guidelines_lists_group_lexicon(8그룹) 은 그대로 통과(가산이라 회귀 없음).

- [ ] **Step 1 — Write the failing test(s)**

Append to `worker/tests/unit/test_prompts.py`:

```
# worker/tests/unit/test_prompts.py 에 append (기존 substring-pin 컨벤션 미러).
def test_prompt_weekly_includes_wegosix_uryael_roster():
    # P1 3.7 — WE GO-6 / 유아렐(UR:L) 이 표준 그룹명 표·body formatting
    # 표·scope enum 에서 누락돼 배지 매칭 실패·음차 환각이 났다. 세 위치
    # 모두에 추가됐는지 핀. 한/영 표기는 frontend GROUP_LEXICON
    # (insightFormat.ts) · design/groups.ts 가 단일 출처 — 영문 WE GO-6·UR:L,
    # 한국어 위고식스·유아렐.
    from idol_sight.llm.prompts import (
        PROMPT_WEEKLY,
        PROMPT_WEEKLY_BODY_FORMATTING,
    )
    # (1) 표준 그룹명 표 + (2) body formatting 표 — 한/영 표기 모두
    for token in ("WE GO-6", "위고식스", "UR:L", "유아렐"):
        assert token in PROMPT_WEEKLY, f"canonical roster missing: {token}"
        assert token in PROMPT_WEEKLY_BODY_FORMATTING, (
            f"body formatting roster missing: {token}"
        )
    # (3) scope enum — group_key 소문자 표기
    for key in ("wegosix", "uryael"):
        assert key in PROMPT_WEEKLY, f"scope enum missing group_key: {key}"


def test_body_formatting_guidelines_lists_all_ten_groups():
    # 기존 test_body_formatting_guidelines_lists_group_lexicon(8그룹)의
    # 확장판 — 10그룹 전체 한/영 쌍을 핀(frontend GROUP_KEYS 와 1:1).
    from idol_sight.llm.prompts import PROMPT_WEEKLY_BODY_FORMATTING
    pairs = [
        ("PLAVE", "플레이브"),
        ("ISEDOL", "이세계아이돌"),
        ("STELLIVE", "스텔라이브"),
        ("SKINZ", "스킨즈"),
        ("MY:RAKL", "미라클"),
        ("OWIS", "오위스"),
        ("MiiWAN", "미완소년"),
        ("B:DAWN", "비던"),
        ("WE GO-6", "위고식스"),
        ("UR:L", "유아렐"),
    ]
    for en, ko in pairs:
        assert en in PROMPT_WEEKLY_BODY_FORMATTING, f"missing EN form: {en}"
        assert ko in PROMPT_WEEKLY_BODY_FORMATTING, f"missing KO form: {ko}"
```

- [ ] **Step 2 — Run the test, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && python -m pytest tests/unit/test_prompts.py -q
```
Expected: the new test(s) FAIL (target symbol/behavior not yet present).

- [ ] **Step 3 — Apply the implementation**

Edit `worker/src/idol_sight/llm/prompts.py:17 (_CANONICAL_NAMES_BLOCK 표 bdawn 행 아래 2줄 추가)` (and the other Files above) to:

```
# --- EDIT 1: _CANONICAL_NAMES_BLOCK 표 끝 (prompts.py:17) ---
  miiwan   → 영문 "MiiWAN"    · 한국어 "미완소년"    (NOT 미이완, NOT 미완)
  bdawn    → 영문 "B:DAWN"    · 한국어 "비던"
  wegosix  → 영문 "WE GO-6"   · 한국어 "위고식스"    (NOT 위고6, NOT 위고식스6)
  uryael   → 영문 "UR:L"      · 한국어 "유아렐"      (NOT 유알엘, NOT 유리엘)

# --- EDIT 2: _BODY_FORMATTING_GUIDELINES GROUP NAME FIDELITY 표 (prompts.py:191) ---
     MiiWAN / 미완소년          (NOT 미이완, NOT 미완)
     B:DAWN / 비던
     WE GO-6 / 위고식스
     UR:L / 유아렐
   Korean prose → use the Korean form. English/mixed prose → use the

# --- EDIT 3: PROMPT_WEEKLY scope enum (prompts.py:681) ---
  (plave/isedol/stellive/skinz/myrakl/owis/miiwan/bdawn/wegosix/uryael).
```

- [ ] **Step 4 — Run the test, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && python -m pytest tests/unit/test_prompts.py -q
```
Expected: all tests in the file PASS (new + existing regression).

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "fix(p1): (2) prompts.py 로스터에 wegosix(WE GO-6/위고식스)·uryael(UR:L/유아렐) 추가 — 3곳: 표준 그룹명 표·body formatting 표·scope enum" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

