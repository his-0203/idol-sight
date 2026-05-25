# Causal Diagnosis rev 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** spec rev 3 (§13) 의 cohort 카테고리 분리 + temporal z + WoW% OR 결합을 단일 implementer 사이클로 통합 적용. 운영 cohort 가 bimodal 이라 cross-sectional z 가 무력화되는 문제 해결.

**Architecture:** signals 모듈에 `temporal_z_score` / `wow_pct` / `_category_of` 추가. `compute_group_signals` 가 카테고리별 cohort + per-group history + WoW pct 모두 계산해 sig dict 를 *3-축 구조* 로 빌드 (예: `sig["subs"] = {"category_z": .., "temporal_z": .., "wow_pct": ..}`). `_check_*` 함수들이 새 helper `_is_lit` 로 OR 결합 판정.

**Tech Stack:** Python 3.12, pytest. migration 없음.

**Spec:** `docs/superpowers/specs/2026-05-25-causal-diagnosis-design.md` §13.

---

## File Structure

**Modify:**
- `worker/src/idol_sight/analysis/weekly_diagnosis_signals.py` — `temporal_z_score`, `wow_pct`, `_category_of` 추가. 임계치 상수: `SUBS_WOW_LIT=0.05`, `VIEWS_WOW_LIT=0.08`, `VIEWS_WOW_PAID=0.20`, `SUBS_WOW_SUB_PURCHASE=0.15`, `NEWS_WOW_LIT=0.30`, `COMMUNITY_WOW_LIT=0.30`, `TEMPORAL_HISTORY_WEEKS=8`, `CATEGORY_COHORT_MIN=3`.
- `worker/src/idol_sight/analysis/weekly_diagnosis.py` — `_is_lit` helper 신설. 9개 `_check_*` 함수가 sig dict 의 새 shape 를 읽도록 수정 (helper 사용으로 동일 패턴). `compute_group_signals` 가 (a) category cohort, (b) 그룹별 temporal history, (c) WoW pct 모두 계산해 sig dict 빌드.
- `worker/tests/unit/test_weekly_diagnosis_signals.py` — `temporal_z_score` + `wow_pct` 단위 테스트.
- `worker/tests/unit/test_weekly_diagnosis.py` — `_base_signal_bundle()` 의 sig shape 를 새 3-축 dict 로 업데이트. 새 시나리오 테스트 추가 (rev 3 §13.5).

**No change:**
- migrations, prompts.py, weekly.py, gemini.py, cli.py.

---

## Task A: signals 모듈 함수 추가 (TDD)

**Files:**
- Modify: `worker/src/idol_sight/analysis/weekly_diagnosis_signals.py`
- Modify: `worker/tests/unit/test_weekly_diagnosis_signals.py`

- [ ] **Step 1: failing test 추가**

`test_weekly_diagnosis_signals.py` 끝에:

```python
from idol_sight.analysis.weekly_diagnosis_signals import (
    temporal_z_score, wow_pct, _category_of,
    SUBS_WOW_LIT, VIEWS_WOW_LIT, VIEWS_WOW_PAID,
    SUBS_WOW_SUB_PURCHASE, NEWS_WOW_LIT, COMMUNITY_WOW_LIT,
    TEMPORAL_HISTORY_WEEKS, CATEGORY_COHORT_MIN,
)


def test_temporal_z_score_basic():
    """history 분포 대비 z. cohort_z_score 와 동일 계산, semantically 다름."""
    history = [100, 110, 105, 115, 108, 112, 120, 95]
    z = temporal_z_score(now_value=160, history=history)
    assert z > 4.0    # 강한 spike


def test_temporal_z_score_empty_history():
    """history 부족 → 0."""
    assert temporal_z_score(now_value=100, history=[]) == 0.0


def test_wow_pct_basic():
    assert math.isclose(wow_pct(now_value=110, prev_value=100), 0.10)


def test_wow_pct_prev_zero_returns_none():
    """prev=0/None 이면 dead signal — None."""
    assert wow_pct(now_value=100, prev_value=0) is None
    assert wow_pct(now_value=100, prev_value=None) is None
    assert wow_pct(now_value=None, prev_value=100) is None


def test_category_of_corporate_is_kpop():
    assert _category_of("corporate") == "kpop"


def test_category_of_segmentary_is_subculture():
    assert _category_of("segmentary") == "subculture"


def test_category_of_confederation_is_subculture():
    assert _category_of("confederation") == "subculture"


def test_category_of_unknown_defaults_kpop():
    """알 수 없는 값 → kpop 으로 safe default."""
    assert _category_of(None) == "kpop"
    assert _category_of("") == "kpop"


def test_thresholds_constants_present():
    """rev 3 상수들이 모두 export 됐는지 sanity."""
    assert SUBS_WOW_LIT == 0.05
    assert VIEWS_WOW_LIT == 0.08
    assert VIEWS_WOW_PAID == 0.20
    assert SUBS_WOW_SUB_PURCHASE == 0.15
    assert NEWS_WOW_LIT == 0.30
    assert COMMUNITY_WOW_LIT == 0.30
    assert TEMPORAL_HISTORY_WEEKS == 8
    assert CATEGORY_COHORT_MIN == 3
```

- [ ] **Step 2: fail 확인**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v 2>&1 | tail -5
```
Expected: FAIL with ImportError 류.

- [ ] **Step 3: 구현**

`weekly_diagnosis_signals.py` 끝에 추가:

```python
# rev 3 — temporal z-score (자기 그룹 directly history 대비)
TEMPORAL_HISTORY_WEEKS = 8
CATEGORY_COHORT_MIN = 3   # subculture cohort (2개) fallback 트리거


def temporal_z_score(now_value: float, history: list[float]) -> float:
    """동일 그룹의 historical 분포 대비 z-score.

    내부적으로 cohort_z_score 와 동일 계산 (분포 평균/표준편차). semantically:
    - cohort_z_score: cross-sectional ("이번 주 다른 그룹들 대비")
    - temporal_z_score: temporal ("자기 그룹의 과거 N주 대비")

    cohort 부족 (len < 2) 시 0 반환 — cohort_z_score 동작과 동일.
    """
    return cohort_z_score(value=now_value, cohort=history)


def wow_pct(now_value: float | None, prev_value: float | None) -> float | None:
    """직전 주 대비 % 변화. wow_ratio 와 동일 계산이지만 별도 alias 로
    의도 명확화 (rev 3 시그널 dict 에서 '비율' 임계 비교 전용)."""
    return wow_ratio(now=now_value, prev=prev_value)


# rev 3 — WoW% 임계 (일반 lit vs paid_ads/sub_purchase 더 strict)
SUBS_WOW_LIT = 0.05            # organic_growth 등
VIEWS_WOW_LIT = 0.08           # organic_growth 등
VIEWS_WOW_PAID = 0.20          # paid_youtube_ads (더 strict)
SUBS_WOW_SUB_PURCHASE = 0.15   # subscriber_purchase (검증 어려움)
NEWS_WOW_LIT = 0.30            # 뉴스 변동성 큼
COMMUNITY_WOW_LIT = 0.30       # 커뮤 변동성 큼


def _category_of(group_model: str | None) -> str:
    """spec §13.2: K-POP (corporate) vs 서브컬쳐 (segmentary/confederation)."""
    if group_model == "corporate":
        return "kpop"
    if group_model in ("segmentary", "confederation"):
        return "subculture"
    return "kpop"   # safe default
```

- [ ] **Step 4: 테스트 실행**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis_signals.py -v 2>&1 | tail -3
```
Expected: **56 passed** (기존 47 + 신규 9).

- [ ] **Step 5: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add worker/src/idol_sight/analysis/weekly_diagnosis_signals.py worker/tests/unit/test_weekly_diagnosis_signals.py
git commit -m "feat(worker): weekly_diagnosis_signals — rev 3 temporal_z / wow_pct / category

spec rev 3 §13: cohort 카테고리 (kpop/subculture) + 자기 그룹 history 대비
temporal z + WoW% 임계 상수. cross-sectional z 의 bimodal cohort 무력화
문제 해결. 9 신규 unit tests."
```

---

## Task B: classify_hypotheses 의 sig dict shape 변경 + _is_lit helper

**Files:**
- Modify: `worker/src/idol_sight/analysis/weekly_diagnosis.py`
- Modify: `worker/tests/unit/test_weekly_diagnosis.py`

이 task 가 가장 복잡. sig dict shape 변경 — `sig["subs_z"]` (단일 float) → `sig["subs"]` (dict). 9개 `_check_*` 함수 모두 영향.

### Sig dict 새 shape (spec §13.2-D)

```python
{
    "subs":     {"category_z": float, "temporal_z": float, "wow_pct": float | None},
    "views":    {"category_z": float, "temporal_z": float, "wow_pct": float | None},
    "news":     {"category_z": float, "temporal_z": float, "wow_pct": float | None},
    "community":{"category_z": float, "temporal_z": float, "wow_pct": float | None},
    "market_share_z": 0.0,             # V1 stub 그대로
    "er_wow": float | None,             # 기존 그대로
    "vps_wow": float | None,            # 기존 그대로
    "organicity_paid": float | None,    # 기존 그대로
    "reactivity_dominant": (str|None, float),  # 기존 그대로
    "member_centric": dict,             # 기존 그대로
    "comeback": dict,                   # 기존 그대로
    "controversy": dict,                # 기존 그대로
    "news_z_prev_week": 0.0,            # V1 stub
    "community_z_prev_week": 0.0,       # V1 stub
    "community_keywords_topic": str,    # V1 stub
    "video_tags_paid_match": bool,      # V1 stub
}
```

- [ ] **Step 1: `_is_lit` helper 추가 + failing test**

`weekly_diagnosis.py` 의 threshold 상수 섹션 직후 (Z_THRESHOLD_PRIMARY 정의 부근):

```python
def _is_lit(
    sig_entry: dict,
    *,
    z_threshold: float = Z_THRESHOLD_PRIMARY,
    wow_threshold: float,
) -> bool:
    """sig dict 의 한 entry (subs/views/news/community 형식) 가 3-축 OR 판정.

    sig_entry: {"category_z": float, "temporal_z": float, "wow_pct": float | None}
    셋 중 *하나만* 점등이면 True. routine 변동은 모든 축 미달, 진짜 spike 는
    어느 한 축에서 잡힘 — cohort 분포 비대칭 (kpop vs subculture) 영향 제거.
    """
    if sig_entry.get("category_z", 0.0) >= z_threshold:
        return True
    if sig_entry.get("temporal_z", 0.0) >= z_threshold:
        return True
    wow = sig_entry.get("wow_pct")
    if wow is not None and wow >= wow_threshold:
        return True
    return False
```

test_weekly_diagnosis.py 에 추가:

```python
from idol_sight.analysis.weekly_diagnosis import _is_lit


def test_is_lit_category_z_only():
    entry = {"category_z": 2.0, "temporal_z": 0.5, "wow_pct": 0.02}
    assert _is_lit(entry, wow_threshold=0.05) is True


def test_is_lit_temporal_z_only():
    entry = {"category_z": 0.3, "temporal_z": 1.8, "wow_pct": 0.02}
    assert _is_lit(entry, wow_threshold=0.05) is True


def test_is_lit_wow_only():
    entry = {"category_z": 0.3, "temporal_z": 0.5, "wow_pct": 0.08}
    assert _is_lit(entry, wow_threshold=0.05) is True


def test_is_lit_none_lit():
    entry = {"category_z": 0.3, "temporal_z": 0.5, "wow_pct": 0.02}
    assert _is_lit(entry, wow_threshold=0.05) is False


def test_is_lit_wow_none_safe():
    """wow_pct=None (dead signal) 이라도 다른 축으로 lit 가능."""
    entry = {"category_z": 1.8, "temporal_z": 0.5, "wow_pct": None}
    assert _is_lit(entry, wow_threshold=0.05) is True


def test_is_lit_custom_z_threshold():
    """paid_ads 의 Z_THRESHOLD_STRONG=2.0 케이스."""
    entry = {"category_z": 1.8, "temporal_z": 0.5, "wow_pct": 0.05}
    assert _is_lit(entry, z_threshold=2.0, wow_threshold=0.20) is False
    assert _is_lit(entry, z_threshold=1.5, wow_threshold=0.20) is True
```

Run + verify 6 new pass.

- [ ] **Step 2: _base_signal_bundle() rev 3 shape 로 업데이트**

기존 test 의 `_base_signal_bundle()` 헬퍼를 rev 3 shape 로 변경:

```python
def _base_signal_bundle() -> dict:
    """rev 3 shape. 각 시그널마다 category_z / temporal_z / wow_pct 3-축."""
    base_axis = {"category_z": 0.0, "temporal_z": 0.0, "wow_pct": None}
    return {
        "subs":             dict(base_axis),
        "views":            dict(base_axis),
        "news":             dict(base_axis),
        "community":        dict(base_axis),
        "market_share_z":   0.0,
        "er_wow":           0.0,
        "vps_wow":          None,
        "organicity_paid":  None,
        "reactivity_dominant": (None, 0.0),
        "member_centric":   {"lit": False, "dead": True, "top1_share_high": False,
                             "top1_share_now": None, "top1_share_wow": None,
                             "hhi_norm_wow": None},
        "comeback":         {"event_match": None, "music_streak": 0,
                             "hanteo_sales": 0, "chart_peak": None,
                             "video_upload_z": 0.0},
        "controversy":      {"keyword_z": 0.0, "twitter_z": 0.0,
                             "controversy_count_z": 0.0,
                             "negative_ratio_z": 0.0},
        "news_z_prev_week":           0.0,
        "community_z_prev_week":      0.0,
        "community_keywords_topic":   "neutral",
        "video_tags_paid_match":      False,
    }
```

기존 test 들이 `"subs_z": 1.8` 같이 직접 키 access 하던 부분도 rev 3 shape 로 변경. 예:

```python
# 기존:
sig = _base_signal_bundle() | {"subs_z": 1.8, "views_z": 2.0, ...}

# rev 3:
sig = _base_signal_bundle()
sig["subs"] = {"category_z": 1.8, "temporal_z": 0.0, "wow_pct": None}
sig["views"] = {"category_z": 2.0, "temporal_z": 0.0, "wow_pct": None}
```

(또는 helper 함수 `_lit_axis(z=, t=0.0, w=None)` 추가해서 가독성).

- [ ] **Step 3: 9 _check_ 함수들의 sig 접근 패턴 변경**

각 함수에서 `sig["subs_z"]` 직접 비교 → `_is_lit(sig["subs"], wow_threshold=SUBS_WOW_LIT)` 호출.

예: `_check_organic_growth`:

```python
def _check_organic_growth(sig: dict) -> Hypothesis | None:
    er_wow = sig.get("er_wow")
    if er_wow is None:
        return None
    if abs(er_wow) >= 0.15:
        return None
    lit_signals: list[Evidence] = []
    if _is_lit(sig["subs"], wow_threshold=_S.SUBS_WOW_LIT):
        lit_signals.append(_evidence_3axis("subs", sig["subs"]))
    if _is_lit(sig["views"], wow_threshold=_S.VIEWS_WOW_LIT):
        lit_signals.append(_evidence_3axis("views", sig["views"]))
    if _is_lit(sig["news"], wow_threshold=_S.NEWS_WOW_LIT):
        lit_signals.append(_evidence_3axis("news", sig["news"]))
    if _is_lit(sig["community"], wow_threshold=_S.COMMUNITY_WOW_LIT):
        lit_signals.append(_evidence_3axis("community", sig["community"]))
    if sig["market_share_z"] >= Z_THRESHOLD_PRIMARY:
        lit_signals.append(Evidence("market_share_z", sig["market_share_z"], f"share z={sig['market_share_z']:.1f}"))
    if len(lit_signals) < 4:
        return None
    return Hypothesis(key="organic_growth", confidence="high", evidence=lit_signals)


def _evidence_3axis(name: str, entry: dict) -> Evidence:
    """3-축 lit 시그널을 evidence label 로 풀어쓰기."""
    parts = []
    if entry.get("category_z", 0.0) >= Z_THRESHOLD_PRIMARY:
        parts.append(f"category z={entry['category_z']:.1f}")
    if entry.get("temporal_z", 0.0) >= Z_THRESHOLD_PRIMARY:
        parts.append(f"temporal z={entry['temporal_z']:.1f}")
    wow = entry.get("wow_pct")
    if wow is not None and wow > 0:
        parts.append(f"WoW {wow:+.0%}")
    return Evidence(name, entry, label=f"{name} spike — {', '.join(parts)}")
```

같은 패턴을 paid_youtube_ads (`VIEWS_WOW_PAID` 사용), subscriber_purchase (`SUBS_WOW_SUB_PURCHASE` 사용), broadcast_appearance/community_word_of_mouth (rev 2 V1 stub 그대로), controversy_spike (category_z 만 — sig["controversy"] dict 는 변경 없음), platform_concentrated_promo (보조 z 가 sig["news"]/sig["community"] 의 category z 또는 temporal z 점등이면 OK), member_centric_spike (그룹 spike 부분만 _is_lit 사용) 모두 적용.

- [ ] **Step 4: 기존 test 전체 회귀 + 새 시나리오 7개 추가**

rev 3 §13.5 의 새 test 시나리오:

```python
def test_organic_growth_lit_via_wow_only():
    """category z + temporal z 모두 0 + WoW% 모두 임계치 통과 → organic lit."""
    sig = _base_signal_bundle()
    sig["subs"]      = {"category_z": 0.3, "temporal_z": 0.4, "wow_pct": 0.06}
    sig["views"]     = {"category_z": 0.2, "temporal_z": 0.5, "wow_pct": 0.09}
    sig["news"]      = {"category_z": 0.3, "temporal_z": 0.2, "wow_pct": 0.35}
    sig["community"] = {"category_z": 0.1, "temporal_z": 0.4, "wow_pct": 0.40}
    sig["er_wow"] = 0.02
    hyps = classify_hypotheses(sig)
    assert any(h.key == "organic_growth" for h in hyps)


def test_organic_growth_lit_via_temporal_only():
    """category cohort 비대칭이라 모두 0 + 자기 history 대비 큰 spike."""
    sig = _base_signal_bundle()
    sig["subs"]      = {"category_z": 0.0, "temporal_z": 2.1, "wow_pct": 0.02}
    sig["views"]     = {"category_z": 0.0, "temporal_z": 1.8, "wow_pct": 0.03}
    sig["news"]      = {"category_z": 0.0, "temporal_z": 1.7, "wow_pct": 0.10}
    sig["community"] = {"category_z": 0.0, "temporal_z": 1.6, "wow_pct": 0.05}
    sig["er_wow"] = 0.02
    hyps = classify_hypotheses(sig)
    assert any(h.key == "organic_growth" for h in hyps)


def test_paid_ads_stricter_wow_threshold():
    """views WoW 8% (organic 임계) 만으로는 paid 안 점등; WoW 25% 면 점등."""
    sig_organic = _base_signal_bundle()
    sig_organic["views"] = {"category_z": 0.5, "temporal_z": 0.5, "wow_pct": 0.10}
    sig_organic["subs"]  = {"category_z": 0.2, "temporal_z": 0.2, "wow_pct": 0.01}
    sig_organic["er_wow"] = -0.25
    sig_organic["organicity_paid"] = 0.40
    # 10% WoW 만으로는 paid 점등 안 됨 (임계 0.20)
    assert not any(h.key == "paid_youtube_ads"
                   for h in classify_hypotheses(sig_organic))

    sig_paid = _base_signal_bundle()
    sig_paid["views"] = {"category_z": 0.5, "temporal_z": 0.5, "wow_pct": 0.25}
    sig_paid["subs"]  = {"category_z": 0.2, "temporal_z": 0.2, "wow_pct": 0.01}
    sig_paid["er_wow"] = -0.25
    sig_paid["organicity_paid"] = 0.40
    # 25% WoW 면 점등
    assert any(h.key == "paid_youtube_ads" for h in classify_hypotheses(sig_paid))


def test_subscriber_purchase_uses_strict_wow_15pct():
    sig = _base_signal_bundle()
    sig["subs"] = {"category_z": 0.5, "temporal_z": 0.5, "wow_pct": 0.16}
    sig["vps_wow"] = -0.32
    sig["er_wow"] = -0.30
    hyps = classify_hypotheses(sig)
    sp = next((h for h in hyps if h.key == "subscriber_purchase"), None)
    assert sp is not None
    assert sp.confidence == "medium"   # 캡 유지
```

- [ ] **Step 5: 전체 회귀**

```bash
cd worker && uv run pytest 2>&1 | tail -3
```
Expected: **500+ passed** (495 기존 + 약 13 신규 task A 9 + task B 6 + 4).

- [ ] **Step 6: Commit (Task B)**

```bash
cd /Users/user/Desktop/idol-sight && git add worker/src/idol_sight/analysis/weekly_diagnosis.py worker/tests/unit/test_weekly_diagnosis.py
git commit -m "feat(worker): weekly_diagnosis — rev 3 sig dict 3-축 shape + _is_lit OR helper

9 _check_* 함수 모두 새 헬퍼 _is_lit 사용 — sig['subs'] 등이 dict
{category_z, temporal_z, wow_pct} 로 변경. 셋 중 OR 점등 = lit.
evidence label 도 어느 축에서 점등됐는지 명시 (운영자가 카드에서
'WoW +6%, temporal z=1.8' 같은 구체 신호 확인 가능). 기존 28 test 모두
rev 3 shape 로 업데이트 + 4 신규 시나리오 (wow-only / temporal-only /
paid 임계 strict / sub_purchase WoW 15%)."
```

---

## Task C: compute_group_signals 의 cohort 빌드 변경

**Files:**
- Modify: `worker/src/idol_sight/analysis/weekly_diagnosis.py` (compute_group_signals 만)
- Modify: `worker/tests/unit/test_weekly_diagnosis.py` (e2e mock 업데이트)

- [ ] **Step 1: compute_group_signals 의 cohort 빌드 + sig dict 3-축 변환**

다음을 수정:

```python
def compute_group_signals(
    *, db: _Executor, week_start: str, week_end: str,
) -> dict[str, GroupSignals]:
    # ... 기존 SQL 쿼리들 (이번 주 + 직전 주 + 9개 보조) 유지 ...
    
    # rev 3: 카테고리 정보 + temporal history 쿼리 추가
    groups_meta_rows = db.execute(
        "SELECT key AS group_key, group_model FROM groups WHERE is_active=1",
        [],
    )
    category_by_group: dict[str, str] = {
        r["group_key"]: _S._category_of(r.get("group_model"))
        for r in groups_meta_rows
    }
    
    # 그룹별 weekly snapshot history (직전 8주 last-snap-of-week)
    history_rows = db.execute(
        "SELECT group_key, snapshot_at, yt_subscribers, yt_total_views, "
        "       naver_total_news, "
        "       (COALESCE(dc_total_posts,0)+COALESCE(theqoo_posts,0)+COALESCE(instiz_posts,0)) AS comm "
        "FROM agg_summary "
        "WHERE substr(snapshot_at,1,10) < ? "
        "ORDER BY snapshot_at DESC LIMIT ?",
        [week_start, len(category_by_group) * _S.TEMPORAL_HISTORY_WEEKS * 7],
    )
    
    # 그룹별로 마지막 8개 weekly snapshots 추출
    history_by_group: dict[str, list[dict]] = {}
    for r in history_rows:
        history_by_group.setdefault(r["group_key"], []).append(r)
    # 각 그룹의 history 를 최근 8개로 truncate (LIMIT 가 cohort-wise 라 그룹별 보장 필요)
    for gk in list(history_by_group.keys()):
        history_by_group[gk] = history_by_group[gk][:_S.TEMPORAL_HISTORY_WEEKS]
    
    # 이미 빌드된 now_by / prev_by (rev 2 fix 후 sorted last-wins) 그대로 활용.
    # ... (기존 코드 유지) ...
    
    # 카테고리별 cohort lists
    kpop_groups       = [gk for gk in now_by if category_by_group.get(gk) == "kpop"]
    subculture_groups = [gk for gk in now_by if category_by_group.get(gk) == "subculture"]
    
    def _cohort_for_category(cat: str, key: str) -> list[float]:
        members = kpop_groups if cat == "kpop" else subculture_groups
        if len(members) < _S.CATEGORY_COHORT_MIN:
            return []   # cohort 너무 작음 — temporal/WoW 만 lit 판정
        return [float(now_by[g].get(key) or 0) for g in members]
    
    out: dict[str, GroupSignals] = {}
    for gk, now in now_by.items():
        prev = prev_by.get(gk, {})
        cat = category_by_group.get(gk, "kpop")
        history = history_by_group.get(gk, [])
        
        def _make_axis(key: str, *, comm_keys: tuple | None = None) -> dict:
            now_val = (
                float(sum((now.get(k) or 0) for k in comm_keys))
                if comm_keys
                else float(now.get(key) or 0)
            )
            prev_val = (
                float(sum((prev.get(k) or 0) for k in comm_keys))
                if comm_keys
                else float(prev.get(key) or 0)
            )
            history_vals = [
                (float(sum((h.get(k) or 0) for k in comm_keys)) if comm_keys
                 else float(h.get(key) or 0))
                for h in history
            ]
            return {
                "category_z": _S.cohort_z_score(now_val, _cohort_for_category(cat, key)) if comm_keys is None else _S.cohort_z_score(now_val, [_cohort_sum(g) for g in (kpop_groups if cat=='kpop' else subculture_groups)] if len((kpop_groups if cat=='kpop' else subculture_groups)) >= _S.CATEGORY_COHORT_MIN else []),
                "temporal_z": _S.temporal_z_score(now_val, history_vals),
                "wow_pct":    _S.wow_pct(now_val, prev_val),
            }
        
        # community 는 dc+theqoo+instiz 합산. 위 _make_axis 의 community 처리는 복잡하므로
        # 별도 헬퍼 함수로 빼는 게 깔끔. (구현 시 정리)
        # ... 시그널 dict 빌드 ...
```

**중요**: 이 step 의 코드 sketch 는 *의도 전달* 용. implementer 는 깔끔하게 리팩토링 (예: `_compute_axis(now_val, prev_val, history_vals, cohort_vals)` 같은 helper 함수). 핵심은:
- sig["subs"]/sig["views"]/sig["news"]/sig["community"] 4개 시그널이 *각각 {category_z, temporal_z, wow_pct}* 3-키 dict 로 빌드.
- category_z 는 *같은 카테고리* cohort 만 사용.
- subculture 가 2개라 cohort_min 미달 → category_z=0 fallback (temporal/WoW 로 lit 가능).
- temporal_z 는 그룹별 8주 history.

- [ ] **Step 2: e2e mock test 업데이트**

`test_compute_group_signals_deduplicates_multi_row` 와 `test_compute_group_signals_organic_growth_e2e` 의 stub:
- groups 테이블 query (`SELECT key, group_model FROM groups WHERE is_active=1`) 결과 추가
- agg_summary history 쿼리 결과 추가
- side_effect 길이가 10 → 12 가 됨 (groups + history 2개 추가)

새 e2e test:

```python
def test_compute_group_signals_subculture_falls_back_to_temporal():
    """subculture cohort 가 2개라 cohort_min 미달 → category_z=0,
    temporal/WoW 로만 lit 가능."""
    db = MagicMock()
    # ... stub: ISEDOL/STELLIVE (subculture) 만 있는 last_7d + 자기 history 큰 변동 ...
    # ISEDOL 이 history 대비 spike 라면 temporal_z 점등으로 organic_growth lit
```

- [ ] **Step 3: 회귀 + 신규 통합 테스트**

```bash
cd worker && uv run pytest tests/unit/test_weekly_diagnosis.py -v 2>&1 | tail -5
cd worker && uv run pytest 2>&1 | tail -3
```
Expected: 모두 PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add worker/src/idol_sight/analysis/weekly_diagnosis.py worker/tests/unit/test_weekly_diagnosis.py
git commit -m "feat(worker): compute_group_signals — rev 3 카테고리 cohort + temporal history

spec rev 3 §13.2: 
- groups 메타 쿼리 추가 (group_model → category 매핑)
- agg_summary 직전 8주 history 쿼리 추가 (temporal z 분모)
- subs/views/news/community 시그널을 (category_z, temporal_z, wow_pct)
  3-축 dict 로 빌드
- subculture cohort N=2 < CATEGORY_COHORT_MIN(3) → category_z=0 fallback
  (temporal+WoW 로만 lit 가능). 운영 cohort bimodal 문제 해결.
SQL 쿼리 10 → 12개."
```

---

## Task D: e2e 검증 + push + workflow 트리거

- [ ] **Step 1: 전체 worker test 통과 확인**

```bash
cd worker && uv run pytest 2>&1 | tail -3
```
Expected: 500+ passed.

- [ ] **Step 2: push**

```bash
git push origin main
```

- [ ] **Step 3: 기존 week 카드 삭제 + workflow 트리거**

```bash
cd /Users/user/Desktop/idol-sight/frontend && wrangler d1 execute idol-sight --remote --command "DELETE FROM insights WHERE week_start='2026-05-17';"
gh workflow run analyze-weekly.yml -f week_start=2026-05-17 -f week_end=2026-05-23
```

- [ ] **Step 4: workflow watch**

```bash
gh run watch <run_id> --exit-status
```

- [ ] **Step 5: signals 점등 검증**

```bash
gh run view <run_id> --log 2>&1 | grep -E "causal_diagnosis|llm: wrote"
```

Expected: `hypotheses_lit > 0` 인 그룹이 1개 이상 나옴 — rev 3 의 3-축 OR 결합으로 routine 변동이 아닌 진짜 spike (subs WoW 5%+ 또는 history 대비 z 1.5+) 가 잡힘.

- [ ] **Step 6: D1 diagnosis 카드 검증**

```bash
wrangler d1 execute idol-sight --remote --command "SELECT type, COUNT(*) AS n, SUM(CASE WHEN signals_json IS NOT NULL THEN 1 ELSE 0 END) AS with_signals FROM insights WHERE week_start='2026-05-17' GROUP BY type;"
```

Expected: type=diagnosis 카드가 1개 이상, signals_json 컬럼 채워짐.

만약 여전히 diagnosis 0개 → 운영 데이터에서 자연 spike 가 진짜 없는 것 (routine 주). spec 의도된 동작이며 다음 주 자연 데이터 대기.

---

## Self-Review

- spec rev 3 §13.2 의 변경 사항 (A/B/C/D/E) 모두 task A/B/C 에 매핑?
- 임계치 상수 8개 모두 signals 모듈 export?
- 9개 _check_* 함수 모두 새 _is_lit helper 사용?
- subculture cohort N<3 fallback 동작?
- evidence label 이 어느 축 (category/temporal/WoW) 에서 점등됐는지 명시?
- 기존 28 weekly_diagnosis test 모두 rev 3 shape 로 업데이트 후 통과?
- 신규 13+ 테스트 모두 통과?

---

## Execution

Task A → B → C 순차 진행 (B 와 C 는 같은 파일이라 분리는 commit 단위로). 한 implementer 사이클로 처리 — 큰 변경이지만 logical 연결성 강함. 사이클 끝나면 spec rev + quality reviewer 검토.
