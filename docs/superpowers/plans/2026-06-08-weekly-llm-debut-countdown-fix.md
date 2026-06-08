# weekly LLM 데뷔 D-N 환각 근본 해결 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** weekly LLM 이 MiiWAN 데뷔 D-N·데뷔일을 환각하지 않도록 `groups.debut_date` 기반 `debut_countdown` 을 LLM 컨텍스트에 주입하고 프롬프트 가드/예시 중성화를 추가한다. 그리고 이미 쌓인 환각 ipx_action 카드 4건을 정리하고 올바른 카드를 재생성한다.

**Architecture:** 순수 함수 `_debut_countdown(rows, today)` 가 `groups` 의 debut_date 를 D-N label 로 변환 → `build_context` 가 생성 시각(KST)으로 호출해 `debut_countdown` 키를 LLM 컨텍스트에 주입. `PROMPT_WEEKLY` 에 "데뷔 D-N 은 debut_countdown 값만 사용, 추정 금지" 가드 블록 추가 + few-shot/scope 예시의 forward-looking `D-30`/`총 30건` 앵커를 `D-{N}`/`총 N건` 으로 중성화. 데이터 정리는 운영자가 원격 D1 에서 id 단위 DELETE.

**Tech Stack:** Python 3.12 (worker, pytest), Cloudflare D1 (운영자 원격 DELETE), GitHub Actions(재생성 디스패치).

**Spec:** `docs/superpowers/specs/2026-06-08-weekly-llm-debut-countdown-fix-design.md`

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `worker/src/idol_sight/llm/weekly.py` | `_debut_countdown` 순수함수 + `build_context` 컨텍스트 주입 | Modify |
| `worker/src/idol_sight/llm/prompts.py` | 데뷔 D-N 환각 가드 블록 + forward-looking 예시 중성화 | Modify |
| `worker/tests/unit/test_llm_weekly.py` | `_debut_countdown` 경계 + build_context debut_countdown + _stub_db 보강 | Modify |
| `worker/tests/unit/test_prompts.py` | 가드 토큰 포함 + forward-looking 앵커 부재 회귀 | Modify |
| (데이터) 원격 D1 `insights` | 환각 4건(id 105/117/191/201) DELETE — 운영자 실행 | 운영 |

순서: worker 로직(TDD) → 프롬프트 → 검증 → push → 운영자 정리 DELETE → 수동 디스패치 재생성.

---

## Task 1: `_debut_countdown` 순수 함수

`groups` 행 리스트를 `{group_key: {debut_date, days_to_debut, label}}` 로 변환하는 순수 함수. label 은 D-N(데뷔 전) / D-DAY / D+N(데뷔 후).

**Files:**
- Modify: `worker/src/idol_sight/llm/weekly.py`
- Test: `worker/tests/unit/test_llm_weekly.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/unit/test_llm_weekly.py` 끝에 추가 (상단 import 에 `from datetime import date` 가 없으면 추가):

```python
def test_debut_countdown_labels():
    from datetime import date
    from idol_sight.llm.weekly import _debut_countdown
    rows = [
        {"key": "miiwan", "debut_date": "2026-06-16"},  # 미래 → D-8
        {"key": "plave",  "debut_date": "2023-03-12"},  # 과거 → D+...
        {"key": "owis",   "debut_date": "2026-06-08"},  # 당일 → D-DAY
        {"key": "nodate", "debut_date": None},          # 무시
    ]
    out = _debut_countdown(rows, date(2026, 6, 8))
    assert out["miiwan"] == {"debut_date": "2026-06-16", "days_to_debut": 8, "label": "D-8"}
    assert out["owis"]["label"] == "D-DAY"
    assert out["owis"]["days_to_debut"] == 0
    assert out["plave"]["label"].startswith("D+")
    assert out["plave"]["days_to_debut"] < 0
    assert "nodate" not in out  # debut_date None 은 제외


def test_debut_countdown_empty():
    from datetime import date
    from idol_sight.llm.weekly import _debut_countdown
    assert _debut_countdown([], date(2026, 6, 8)) == {}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_llm_weekly.py::test_debut_countdown_labels tests/unit/test_llm_weekly.py::test_debut_countdown_empty -v`
Expected: FAIL — `ImportError: cannot import name '_debut_countdown'`.

- [ ] **Step 3: 함수 구현**

`worker/src/idol_sight/llm/weekly.py` 의 `_shift_iso_date` 함수 (현재 파일에 있음) 바로 아래에 추가. 파일 상단 import 가 `from datetime import UTC, datetime` 이면 `from datetime import UTC, date, datetime, timedelta` 로 변경:

```python
def _debut_countdown(rows: list[dict], today: "date") -> dict[str, dict]:
    """groups 행 [{key, debut_date}] → {key: {debut_date, days_to_debut, label}}.

    label: 데뷔 전(days>0)=D-{n}, 당일(0)=D-DAY, 데뷔 후(days<0)=D+{n}.
    debut_date 가 비어있는 행은 제외한다. LLM 이 데뷔 D-N·데뷔일을
    추정하지 않도록 ground-truth 를 컨텍스트로 넘기기 위한 변환.
    """
    out: dict[str, dict] = {}
    for r in rows:
        ds = r.get("debut_date")
        if not ds:
            continue
        days = (date.fromisoformat(ds) - today).days
        if days > 0:
            label = f"D-{days}"
        elif days == 0:
            label = "D-DAY"
        else:
            label = f"D+{abs(days)}"
        out[r["key"]] = {"debut_date": ds, "days_to_debut": days, "label": label}
    return out
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_llm_weekly.py::test_debut_countdown_labels tests/unit/test_llm_weekly.py::test_debut_countdown_empty -v`
Expected: PASS (2개).

- [ ] **Step 5: 커밋**

```bash
git add worker/src/idol_sight/llm/weekly.py worker/tests/unit/test_llm_weekly.py
git commit -m "feat(weekly): _debut_countdown 순수함수 (D-N/D-DAY/D+N label)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `build_context` 가 debut_countdown 주입

`build_context` 가 활성 그룹의 debut_date 를 조회해 생성 시각(KST) 기준 `debut_countdown` 을 컨텍스트에 넣는다.

**Files:**
- Modify: `worker/src/idol_sight/llm/weekly.py`
- Test: `worker/tests/unit/test_llm_weekly.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/unit/test_llm_weekly.py` 끝에 추가. (이 테스트는 `_stub_db` 를 쓰지 않고 자체 stub 으로 build_context 를 직접 호출 — debut 쿼리가 마지막 execute 호출임을 검증.)

```python
def test_build_context_includes_debut_countdown():
    """build_context 가 groups.debut_date 를 조회해 debut_countdown 을
    컨텍스트에 주입한다 (LLM 이 데뷔 D-N 을 환각하지 않게 ground-truth 제공)."""
    from idol_sight.llm.weekly import build_context
    from unittest.mock import MagicMock
    db = MagicMock()
    # build_context 의 execute 순서: last_7d, prev_7d, hanteo, market,
    # top_news, (signals 13개), debut(마지막). signals_by_group 를 주입해
    # compute_group_signals 내부 호출을 건너뛰면 execute 는 5 + 1(debut).
    db.execute.side_effect = [
        [],  # last_7d
        [],  # prev_7d
        [],  # hanteo
        [],  # market
        [],  # top_news
        [{"key": "miiwan", "debut_date": "2026-06-16"}],  # debut rows
    ]
    ctx = build_context(
        db, week_start="2026-06-07", week_end="2026-06-13",
        signals_by_group={},  # 주입 → compute_group_signals 미호출
    )
    assert "debut_countdown" in ctx
    assert "miiwan" in ctx["debut_countdown"]
    cd = ctx["debut_countdown"]["miiwan"]
    assert cd["debut_date"] == "2026-06-16"
    assert cd["label"].startswith("D")  # 실제 today 에 따라 D-n/D-DAY/D+n
    assert isinstance(cd["days_to_debut"], int)
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_llm_weekly.py::test_build_context_includes_debut_countdown -v`
Expected: FAIL — `KeyError: 'debut_countdown'` (또는 side_effect 소진 관련). debut_countdown 미주입.

- [ ] **Step 3: build_context 에 debut 조회 + 주입**

`worker/src/idol_sight/llm/weekly.py` 의 `build_context` 에서, `signals_by_group` 블록(현재 `if signals_by_group is None: ... compute_group_signals(...)` 과 그 뒤 log.info 블록)이 끝난 직후 — `return {` 바로 **위** — 에 추가:

```python
    # 데뷔 D-N ground-truth: LLM 이 데뷔일/카운트다운을 환각하지 않도록
    # groups.debut_date 를 생성 시각(KST) 기준 D-N label 로 변환해 주입한다.
    # (debut_countdown 가드는 prompts.py PROMPT_WEEKLY 참조.) "오늘"은
    # forward-looking ipx_action("오늘부터 D-N")에 맞춰 분석 주가 아닌
    # 생성 시각 기준.
    debut_rows = db.execute(
        "SELECT key, debut_date FROM groups "
        "WHERE debut_date IS NOT NULL AND is_active=1"
    )
    today_kst = (datetime.now(UTC) + timedelta(hours=9)).date()
    debut_countdown = _debut_countdown(debut_rows, today_kst)
```

그리고 `return {` dict 에 `report_kind` 줄 다음에 `debut_countdown` 추가:

```python
    return {
        "week": {"start": week_start, "end": week_end},
        "report_kind": report_kind,
        "debut_countdown": debut_countdown,
        "agg_summary_last_7d": last_7d,
        "agg_summary_prev_7d": prev_7d,
        "hanteo": hanteo,
        "market_share": market,
        "top_news_by_group": top_news,
        "signals_by_group": _serialize_signals_for_llm(signals_by_group),
    }
```

- [ ] **Step 4: 신규 테스트 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_llm_weekly.py::test_build_context_includes_debut_countdown -v`
Expected: PASS.

- [ ] **Step 5: `_stub_db` 보강 (debut 쿼리는 마지막 execute 호출)**

`build_context` 가 새 execute(debut) 를 추가했으므로, `_stub_db()` 를 쓰는 기존 테스트들은 `signals_by_group=None` 경로라 execute 순서가 `5(context) + 13(signals) + 1(debut)` = 19 가 된다. `worker/tests/unit/test_llm_weekly.py` 의 `_stub_db` 함수 `side_effect` 리스트 **맨 끝**(현재 마지막 항목 `[],   # community_posts titles (community_keywords_topic)` 다음)에 debut stub 한 줄 추가:

```python
        [],   # community_posts titles (community_keywords_topic)
        [{"key": "miiwan", "debut_date": "2026-06-16"}],  # debut rows (build_context 끝)
    ]
    return db
```

> 주의: debut 조회는 build_context 코드상 compute_group_signals(13쿼리) **뒤**에 위치하므로 stub 도 **맨 끝 append**. 중간 삽입 금지.

- [ ] **Step 6: 전체 weekly 테스트 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_llm_weekly.py -v`
Expected: PASS (기존 + 신규 전부). 기존 `_stub_db` 사용 테스트가 19번째 execute(debut)까지 정상 소비.

- [ ] **Step 7: 커밋**

```bash
git add worker/src/idol_sight/llm/weekly.py worker/tests/unit/test_llm_weekly.py
git commit -m "feat(weekly): build_context 에 debut_countdown ground-truth 주입

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 프롬프트 데뷔 D-N 환각 가드 + forward-looking 예시 중성화

`PROMPT_WEEKLY` 에 가드 블록을 추가하고, MiiWAN 데뷔 카운트다운을 모델링하는 forward-looking 하드코딩 `D-30`/`총 30건` 앵커를 중성화한다. (코호트 비교 베이스라인 `D-30` 예시는 합법적 분석 개념이라 유지.)

**Files:**
- Modify: `worker/src/idol_sight/llm/prompts.py`
- Test: `worker/tests/unit/test_prompts.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/unit/test_prompts.py` 끝에 추가:

```python
def test_prompt_weekly_includes_debut_countdown_guard():
    """데뷔 D-N·데뷔일은 컨텍스트 debut_countdown 값만 쓰도록 강제하는
    가드 블록이 PROMPT_WEEKLY 에 포함돼야 한다 (환각 차단, V2.31 연장)."""
    from idol_sight.llm.prompts import (
        PROMPT_WEEKLY,
        PROMPT_WEEKLY_DEBUT_COUNTDOWN_GUARD,
    )
    assert PROMPT_WEEKLY_DEBUT_COUNTDOWN_GUARD in PROMPT_WEEKLY
    assert "debut_countdown" in PROMPT_WEEKLY_DEBUT_COUNTDOWN_GUARD
    for token in ["데뷔", "추정", "발명"]:
        assert token in PROMPT_WEEKLY_DEBUT_COUNTDOWN_GUARD, f"missing: {token}"


def test_prompt_weekly_no_forward_looking_debut_anchor():
    """forward-looking 카운트다운 하드코딩 앵커(오늘부터 D-30까지 / 총 30건)는
    제거돼야 한다 — LLM 이 30 에 앵커링해 환각하던 원인."""
    from idol_sight.llm.prompts import PROMPT_WEEKLY
    assert "오늘부터 D-30" not in PROMPT_WEEKLY
    assert "총 30건" not in PROMPT_WEEKLY
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_prompts.py::test_prompt_weekly_includes_debut_countdown_guard tests/unit/test_prompts.py::test_prompt_weekly_no_forward_looking_debut_anchor -v`
Expected: FAIL — 첫 테스트 ImportError(`PROMPT_WEEKLY_DEBUT_COUNTDOWN_GUARD` 없음), 둘째 테스트 AssertionError(`오늘부터 D-30` 존재).

- [ ] **Step 3: 가드 블록 정의 + export + 삽입**

`worker/src/idol_sight/llm/prompts.py` 에서 `_INTERIM_FRAMING_GUIDELINES = """\` 정의 (현재 라인 401 근처) **바로 위** 에 새 블록 정의:

```python
_DEBUT_COUNTDOWN_GUARD = """\
DEBUT COUNTDOWN — 데뷔 D-N / 데뷔일 환각 차단 (필수):

컨텍스트에 debut_countdown 이 주어진다:
  { "miiwan": {"debut_date":"YYYY-MM-DD","days_to_debut":N,"label":"D-N"}, ... }

규칙:
  ① 데뷔 D-N, "D-Day", 데뷔일(예: 6/30), 데뷔까지 남은 일수는 **반드시
     debut_countdown 의 값만** 사용한다. 직접 계산·추정·발명 절대 금지.
  ② 그룹이 debut_countdown 에 없으면 그 그룹의 데뷔 D-N·데뷔일을 언급
     하지 않는다 (이미 데뷔한 그룹은 label 이 D+N — "데뷔 후속" 류 표현은
     label 이 D+N 일 때만).
  ③ 카운트다운 콘텐츠 건수("총 N건")는 debut_countdown 의 days_to_debut
     에서 도출한다 (예: label="D-8" 이면 데뷔까지 8건). 임의 숫자(30 등)
     하드코딩 금지.
  ④ 아래 EXEMPLAR 의 "D-{N}" / "총 N건" 은 placeholder 다 — 실제 카드에는
     debut_countdown 의 구체 값을 채운다.
  (코호트 비교 — "PLAVE 가 자사 D-30 시점에 28K" 같은 *과거 벤치마크* 비교는
   별개로 허용. 위 규칙은 *대상 그룹의 현재 데뷔까지 카운트다운* 에 적용.)
"""

```

같은 파일에서 다른 `PROMPT_WEEKLY_*` export (현재 라인 530 근처, `PROMPT_WEEKLY_INTERIM_FRAMING = ...` 등) 옆에 export 추가:

```python
PROMPT_WEEKLY_DEBUT_COUNTDOWN_GUARD = _DEBUT_COUNTDOWN_GUARD
```

그리고 `PROMPT_WEEKLY = f"""\` 본문에서 `{_IPX_ACTION_GUIDELINES}` 줄 (현재 라인 601 근처) **바로 다음** 에 삽입:

```python
{_IPX_ACTION_GUIDELINES}

{_DEBUT_COUNTDOWN_GUARD}
```

- [ ] **Step 4: forward-looking 앵커 중성화**

`worker/src/idol_sight/llm/prompts.py` 에서 아래 4곳을 정확히 수정 (실제 파일을 Read 해 정확한 문자열 확인 후 Edit). 코호트 비교 베이스라인(`_AI_COMMENT_GUIDELINES` 의 "구독자 D-30 시점 12.6K. PLAVE D-30 (28K)" 및 `_ANALYSIS_DEPTH_GUIDELINES` 의 "PLAVE D-30 시 28K vs MiiWAN 12.6K")은 **건드리지 않는다**.

수정 1 — `_IPX_ACTION_GUIDELINES` 의 EXEMPLAR ① title (현재 라인 72):
- old: `    title: "@miiwan_official 카운트다운 콘텐츠 D-30 구간 즉시 발동"`
- new: `    title: "@miiwan_official 카운트다운 콘텐츠 D-{N} 구간 즉시 발동"`

수정 2 — 같은 EXEMPLAR ① body (현재 라인 73-76). old 블록:
```
    body:  "[@miiwan_official 운영자] 오늘부터 D-30까지 매일 KST 18시
            카운트다운 1컷을 업로드한다 (총 30건, 솔로곡 티저 1개씩
            포함). 24시간 조회수 5K 미달인 컷이 3일 연속 나오면
            콘셉트를 ''서사 맥락 영상''으로 즉시 전환한다."
```
new 블록 (D-30→D-{N}, 총 30건→총 N건):
```
    body:  "[@miiwan_official 운영자] 오늘부터 D-{N}까지 매일 KST 18시
            카운트다운 1컷을 업로드한다 (총 N건, 솔로곡 티저 1개씩
            포함). 24시간 조회수 5K 미달인 컷이 3일 연속 나오면
            콘셉트를 ''서사 맥락 영상''으로 즉시 전환한다."
```

수정 3 — `_AI_COMMENT_GUIDELINES` 의 카운트다운 body 예시 (현재 라인 149-150). old:
```
  body:        "[@miiwan_official 운영자] 오늘부터 D-30 까지 매일 KST
                18시 카운트다운 1컷을 업로드한다 (총 30건)."
```
new:
```
  body:        "[@miiwan_official 운영자] 오늘부터 D-{N} 까지 매일 KST
                18시 카운트다운 1컷을 업로드한다 (총 N건)."
```

수정 4 — `_DIAGNOSIS_GUIDELINES` 의 MiiWAN scope 액션 (현재 라인 341) 과 ai_comment (현재 라인 359):
- 라인 341 old: `    경쟁사 유튜브 광고 의심 점등 → "Abyss 마케팅팀 D-30 광고 검토 회의`
  new: `    경쟁사 유튜브 광고 의심 점등 → "Abyss 마케팅팀 데뷔 전 광고 검토 회의`
- 라인 359 old: `    ai_comment: "광고 캠페인 가능성 우세 — MiiWAN D-30 광고 검토 트리거."`
  new: `    ai_comment: "광고 캠페인 가능성 우세 — MiiWAN 데뷔 전 광고 검토 트리거."`

- [ ] **Step 5: 테스트 통과 확인 (신규 + 기존 프롬프트 회귀)**

Run: `cd worker && uv run pytest tests/unit/test_prompts.py -v`
Expected: PASS — 신규 2개 + 기존 회귀 전부. (기존 회귀 중 `_AI_COMMENT_GUIDELINES`/`_ANALYSIS_DEPTH` 의 코호트 D-30 예시는 보존했으므로 영향 없음.)

- [ ] **Step 6: 커밋**

```bash
git add worker/src/idol_sight/llm/prompts.py worker/tests/unit/test_prompts.py
git commit -m "feat(weekly): 데뷔 D-N 환각 가드 + forward-looking 예시 중성화

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: 전체 검증

**Files:** 없음 (검증).

- [ ] **Step 1: worker 전체 테스트**

Run: `cd worker && uv run pytest -q`
Expected: PASS (전체). 신규 테스트 4개(_debut_countdown ×2, build_context, prompt guard ×2 중 일부) 포함, 회귀 없음.

- [ ] **Step 2: 컨텍스트 직렬화 sanity (debut_countdown 이 JSON 으로 LLM 에 도달하는지 수동 확인)**

Run:
```bash
cd worker && uv run python -c "
import json
from datetime import date
from idol_sight.llm.weekly import _debut_countdown
cd = _debut_countdown([{'key':'miiwan','debut_date':'2026-06-16'}], date(2026,6,8))
print(json.dumps(cd, ensure_ascii=False))
"
```
Expected: `{"miiwan": {"debut_date": "2026-06-16", "days_to_debut": 8, "label": "D-8"}}`

- [ ] **Step 3: 커밋 없음 (검증만)**

---

## Task 5: 운영자 핸드오프 — 오염 카드 정리 + 재생성

코드(Task 1-3)를 push 한 뒤, 운영자가 원격 D1 에서 환각 카드를 정리하고 analyze-weekly 를 수동 디스패치한다. 코드 작업이 아니므로 정확한 명령을 제시한다.

**Files:** 없음 (운영 가이드).

- [ ] **Step 1: push (운영자 또는 컨트롤러)**

```bash
git push origin main
```
(GitHub Actions analyze-weekly 가 새 worker 코드를 체크아웃해 사용한다. frontend 무관 변경.)

- [ ] **Step 2: 정리 대상 id 재확인 (운영자, 원격 read)**

> 프로덕션 데이터라 DELETE 전 id 재확인. (이전 조사에서 id 105/117/191/201 = 데뷔 환각 4건.)

```bash
cd frontend && wrangler d1 execute idol-sight --remote --command "SELECT id, week_start, substr(title,1,50) AS title FROM insights WHERE id IN (105,117,191,201)"
```
Expected: 4행 — 105(05-03 데뷔 후속 보도자료) / 117(05-10 D-30) / 191(05-24 D-20) / 201(05-31 D-24). title 이 일치하면 진행. **불일치 시 중단** (id 가 바뀐 것 — `SELECT id,title FROM insights WHERE scope='miiwan' AND type='ipx_action'` 로 재조회 후 데뷔 환각 4건 id 재특정).

- [ ] **Step 3: 환각 4건 DELETE (운영자, 원격 — human-gated)**

```bash
cd frontend && wrangler d1 execute idol-sight --remote --command "DELETE FROM insights WHERE id IN (105,117,191,201)"
```
Expected: `4 rows written` (또는 changes=4). 정상 마케팅 카드(마하진 서사 ×2, 멤버 티저)는 보존됨.

- [ ] **Step 4: 올바른 카드 재생성 (수동 디스패치)**

```bash
gh workflow run analyze-weekly.yml
```
> 오늘(월)이면 bounds 가 interim(week_start=이번 일요일, kind=interim) 산출. 생성 시각(6/8) 기준 MiiWAN label=D-8 이 컨텍스트로 들어가, 새 ipx_action 카드가 올바른 데뷔 D-8 을 쓴다.
> 워크플로 완료(약 수 분) 후 대시보드 MiiWAN 브리핑에서 새 카드의 데뷔 D-N 이 **D-8 (6/16)** 인지 확인. (LLM 이 카운트다운 ipx_action 을 항상 emit 하진 않으므로, 데뷔 관련 카드가 나오면 그 D-N 이 정확한지 검증.)

- [ ] **Step 5: 작업 로그 (SecondBrain)**

`~/SecondBrain/00_Inbox/작업로그 2026-06-08.md` 에 한 줄 append:
```
- (HH:MM · idol-sight) weekly LLM 데뷔 D-N 환각 근본해결 — build_context 에 debut_countdown 주입 + 프롬프트 가드/예시 중성화, 오염 ipx_action 4건 정리 + 재생성
```

---

## 완료 기준

- `cd worker && uv run pytest` PASS (신규 테스트 포함).
- `PROMPT_WEEKLY` 에 debut_countdown 가드 포함 + `오늘부터 D-30`/`총 30건` 앵커 부재.
- push 후 운영자가 환각 4건 DELETE + 수동 디스패치로 올바른 D-8 카드 재생성.
- 대시보드 MiiWAN 브리핑의 IPX 권고에 데뷔 D-N 이 정확(D-8/6-16)하거나, 데뷔 D-N 을 환각하지 않음.
