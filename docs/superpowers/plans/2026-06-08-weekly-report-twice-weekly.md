# Weekly 분석 보고 주 2회 (수=중간점검 / 일=결산) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `analyze-weekly` 를 주 2회(수=이번 주 일~수 중간점검 / 일=직전 완결주 결산) 실행하고, 두 보고를 `report_kind` 로 구분 보존하며 중간점검은 3주 후 피드에서 숨긴다.

**Architecture:** GitHub Actions cron 을 일·수 23:00 KST 로 바꾸고 `bounds` 스텝이 요일로 모드(interim/final)를 결정해 윈도와 `--kind` 를 산출한다. `kind` 는 CLI → `generate_weekly` → 프롬프트 컨텍스트 + `insights.report_kind` INSERT 로 흐른다. DELETE 를 kind 스코프로 바꿔 같은 week_start 의 두 보고가 공존한다. 프런트는 interim 배지 + 3주 숨김 필터, SOV 트렌드는 토요일 완결주만 표시.

**Tech Stack:** Python 3.12 (typer CLI, pytest), Cloudflare D1 (SQLite migrations), TypeScript Pages Functions, Preact/Vite frontend.

**Spec:** `docs/superpowers/specs/2026-06-08-weekly-report-twice-weekly-design.md`

---

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `migrations/0083_insights_report_kind.sql` | `insights.report_kind` 컬럼 | Create |
| `worker/tests/unit/test_migrations_groups_json.py` | 마이그레이션 컬럼 가드 | Modify (test 추가) |
| `worker/src/idol_sight/llm/weekly.py` | kind 스레딩 + INSERT 컬럼 + DELETE 스코프 | Modify |
| `worker/tests/unit/test_llm_weekly.py` | weekly 단위 회귀 | Modify |
| `worker/src/idol_sight/llm/prompts.py` | interim 프레이밍 블록 | Modify |
| `worker/tests/unit/test_prompts.py` | 프롬프트 회귀 | Modify |
| `worker/src/idol_sight/cli.py` | `--kind` 옵션 + 전달 | Modify |
| `.github/workflows/analyze-weekly.yml` | cron + bounds 분기 + `--kind` | Modify |
| `frontend/functions/api/market-share.ts` | 토요일 완결주 가드 | Modify |
| `frontend/functions/api/insights.ts` | report_kind SELECT + interim 3주 숨김 | Modify |
| `frontend/src/views/Insights.tsx` | 중간점검 배지 | Modify |

작업 순서는 데이터 계층(migration) → worker 로직 → CLI/워크플로 → 프런트. worker 변경은 각각 TDD.

---

## Task 1: Migration 0083 — insights.report_kind 컬럼

**Files:**
- Create: `migrations/0083_insights_report_kind.sql`
- Test: `worker/tests/unit/test_migrations_groups_json.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/unit/test_migrations_groups_json.py` 끝에 추가 (기존 `_apply_all_migrations()` 헬퍼 재사용):

```python
def test_insights_has_report_kind_column():
    """0083: insights.report_kind 컬럼이 전 마이그레이션 적용 후 존재하고
    기존 행 기본값이 'final' 이어야 한다 (주 2회 보고 interim/final 구분)."""
    conn = _apply_all_migrations()
    cols = [r[1] for r in conn.execute("PRAGMA table_info(insights)").fetchall()]
    assert "report_kind" in cols, f"report_kind 누락: {cols}"
    # DEFAULT 'final' 검증 — 컬럼 추가 후 INSERT 시 명시 안 하면 final.
    conn.execute(
        "INSERT INTO insights (generated_at, week_start, scope, type, title, body) "
        "VALUES ('2026-06-08T00:00:00Z', '2026-06-01', 'market', 'weekly', 'T', 'B')"
    )
    kind = conn.execute(
        "SELECT report_kind FROM insights WHERE week_start='2026-06-01'"
    ).fetchone()[0]
    assert kind == "final"
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_migrations_groups_json.py::test_insights_has_report_kind_column -v`
Expected: FAIL — `report_kind 누락` (컬럼 미존재).

- [ ] **Step 3: 마이그레이션 작성**

`migrations/0083_insights_report_kind.sql`:

```sql
-- 0083_insights_report_kind.sql — 주 2회 weekly 보고(수=중간점검 / 일=결산).
--
-- 동기:
--   analyze-weekly 를 주 2회로 늘리면서 수요일 중간점검(이번 주 일~수, 미완결)과
--   일요일 결산(직전 완결 일~토)이 같은 week_start 를 공유한다. report_kind 로
--   둘을 구분 보존한다. generate_weekly 의 per-week DELETE 도 kind 스코프로
--   바뀌어(WHERE week_start=? AND report_kind=?) 두 보고가 공존한다.
--
-- 기존 행: DEFAULT 'final' 로 자동 백필 (과거 보고는 전부 완결주 결산이었다).
ALTER TABLE insights ADD COLUMN report_kind TEXT NOT NULL DEFAULT 'final';
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_migrations_groups_json.py -v`
Expected: PASS (신규 + 기존 마이그레이션 가드 모두).

- [ ] **Step 5: 커밋**

```bash
git add migrations/0083_insights_report_kind.sql worker/tests/unit/test_migrations_groups_json.py
git commit -m "feat(weekly): insights.report_kind 컬럼 (migration 0083)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: weekly.py — report_kind 스레딩 + DELETE 스코프화

`generate_weekly`/`build_context` 에 `report_kind` 파라미터를 추가하고, DELETE 를 `WHERE week_start=? AND report_kind=?` 로 바꾸고, INSERT 에 `report_kind` 컬럼을 추가하고, 컨텍스트에 `report_kind` 필드를 주입한다.

**Files:**
- Modify: `worker/src/idol_sight/llm/weekly.py`
- Test: `worker/tests/unit/test_llm_weekly.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/unit/test_llm_weekly.py` 끝에 추가 (`_stub_db`, `_insert_stmts` 기존 헬퍼 재사용):

```python
def test_generate_weekly_interim_kind_threads_to_delete_and_insert():
    """report_kind='interim' 이면 DELETE 가 kind 스코프이고 INSERT 의
    report_kind 컬럼 값이 'interim' 이어야 한다 (수=중간점검 / 일=결산 공존)."""
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "miiwan", "type": "weekly",
            "title": "T", "body": "B",
            "source_refs": [{"table": "agg_summary", "pk": "miiwan|w", "label": "L"}],
        }],
    }
    result = generate_weekly(
        db=_stub_db(), gemini=gemini,
        week_start="2026-06-07", week_end="2026-06-10",
        report_kind="interim",
    )
    # 1) DELETE 는 kind 스코프 — 같은 week_start 의 final 카드를 안 지운다.
    del_sql, del_params = result.statements[0]
    assert del_sql.startswith("DELETE FROM insights")
    assert "report_kind" in del_sql
    assert del_params == ["2026-06-07", "interim"]
    # 2) INSERT 의 report_kind 값 = 'interim' (마지막 바인드 파라미터).
    sql, params = _insert_stmts(result)[0]
    assert "report_kind" in sql
    assert params[-1] == "interim"
    # 3) 컨텍스트에 report_kind 가 주입돼 LLM 이 프레이밍할 수 있다.
    ctx = gemini.generate.call_args.kwargs["context"]
    assert ctx["report_kind"] == "interim"


def test_generate_weekly_defaults_to_final_kind():
    """report_kind 미지정(수동 dispatch / 일요일 결산 기본) → 'final'."""
    gemini = MagicMock()
    gemini.generate.return_value = {
        "items": [{
            "scope": "market", "type": "weekly", "title": "T", "body": "B",
            "source_refs": [{"table": "agg_summary", "pk": "plave|w", "label": "L"}],
        }],
    }
    result = generate_weekly(
        db=_stub_db(), gemini=gemini,
        week_start="2026-04-22", week_end="2026-04-28",
    )
    del_sql, del_params = result.statements[0]
    assert del_params == ["2026-04-22", "final"]
    sql, params = _insert_stmts(result)[0]
    assert params[-1] == "final"
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_llm_weekly.py::test_generate_weekly_interim_kind_threads_to_delete_and_insert tests/unit/test_llm_weekly.py::test_generate_weekly_defaults_to_final_kind -v`
Expected: FAIL — `generate_weekly() got an unexpected keyword argument 'report_kind'`.

- [ ] **Step 3: build_context 시그니처에 report_kind 추가 + 컨텍스트 주입**

`worker/src/idol_sight/llm/weekly.py` 의 `build_context` 시그니처 (현재 `signals_by_group` 까지) 에 `report_kind` 추가:

```python
def build_context(
    db: _Executor,
    *,
    week_start: str,
    week_end: str,
    signals_by_group: dict[str, GroupSignals] | None = None,
    report_kind: str = "final",
) -> dict[str, Any]:
```

그리고 `build_context` 의 `return { ... }` dict 에 `report_kind` 필드 추가 (`"week": {...}` 줄 바로 다음):

```python
    return {
        "week": {"start": week_start, "end": week_end},
        "report_kind": report_kind,
        "agg_summary_last_7d": last_7d,
        "agg_summary_prev_7d": prev_7d,
        "hanteo": hanteo,
        "market_share": market,
        "top_news_by_group": top_news,
        "signals_by_group": _serialize_signals_for_llm(signals_by_group),
    }
```

- [ ] **Step 4: generate_weekly 시그니처 + build_context 호출 + DELETE/INSERT 변경**

`generate_weekly` 시그니처에 `report_kind` 추가:

```python
def generate_weekly(
    *,
    db: _Executor,
    gemini: _Gemini,
    week_start: str,
    week_end: str,
    signals_by_group: dict[str, GroupSignals] | None = None,
    report_kind: str = "final",
) -> CollectionResult:
```

`build_context(...)` 호출에 `report_kind=report_kind` 전달:

```python
    ctx = build_context(
        db,
        week_start=week_start,
        week_end=week_end,
        signals_by_group=signals_by_group,
        report_kind=report_kind,
    )
```

DELETE 문을 kind 스코프로 (현재 `("DELETE FROM insights WHERE week_start = ?", [week_start])`):

```python
    statements: list[tuple[str, list]] = []
    if items:
        statements.append(
            ("DELETE FROM insights WHERE week_start = ? AND report_kind = ?",
             [week_start, report_kind]),
        )
```

INSERT 문에 `report_kind` 컬럼 + 바인드 추가 (현재 9컬럼 → 10컬럼, `signals_json` 뒤에 추가):

```python
        statements.append((
            """
            INSERT INTO insights
              (generated_at, week_start, scope, type, title, body,
               source_refs_json, ai_comment, signals_json, report_kind)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                report_kind,
            ],
        ))
```

- [ ] **Step 5: 테스트 통과 확인 (신규 + 기존 회귀)**

Run: `cd worker && uv run pytest tests/unit/test_llm_weekly.py -v`
Expected: PASS — 신규 2개 + 기존 ai_comment/ipx_action 테스트 전부. (기존 `_insert_stmts` 테스트의 `params[7]`(ai_comment), `params[6]`(source_refs) 인덱스는 불변 — report_kind 는 끝에 append 했으므로.)

- [ ] **Step 6: 커밋**

```bash
git add worker/src/idol_sight/llm/weekly.py worker/tests/unit/test_llm_weekly.py
git commit -m "feat(weekly): report_kind 스레딩 + DELETE kind 스코프화

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: prompts.py — interim 프레이밍 블록

`report_kind=='interim'` 일 때 LLM 이 4일치 미완결 주를 확정 총량으로 단정하지 않도록 프레이밍 블록을 추가한다. 블록은 정적이며 컨텍스트의 `report_kind` 필드를 참조하도록 지시한다.

**Files:**
- Modify: `worker/src/idol_sight/llm/prompts.py`
- Test: `worker/tests/unit/test_prompts.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`worker/tests/unit/test_prompts.py` 끝에 추가 (상단 import 에 `PROMPT_WEEKLY_INTERIM_FRAMING` 추가 필요 — Step 3 에서 export):

```python
def test_prompt_weekly_includes_interim_framing_block():
    """수요일 중간점검(interim)을 미완결 주로 프레이밍하는 블록이
    PROMPT_WEEKLY 에 포함돼야 한다 (V2.31 환각 가드 연장)."""
    from idol_sight.llm.prompts import (
        PROMPT_WEEKLY,
        PROMPT_WEEKLY_INTERIM_FRAMING,
    )
    assert PROMPT_WEEKLY_INTERIM_FRAMING in PROMPT_WEEKLY
    assert "report_kind" in PROMPT_WEEKLY_INTERIM_FRAMING
    assert "interim" in PROMPT_WEEKLY_INTERIM_FRAMING
    # 핵심 가드 토큰: 미완결 / 중간 / 단정 금지 취지.
    for token in ["미완결", "중간", "일~수"]:
        assert token in PROMPT_WEEKLY_INTERIM_FRAMING, f"missing token: {token}"
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_prompts.py::test_prompt_weekly_includes_interim_framing_block -v`
Expected: FAIL — `ImportError: cannot import name 'PROMPT_WEEKLY_INTERIM_FRAMING'`.

- [ ] **Step 3: 프레이밍 블록 정의 + export + PROMPT_WEEKLY 삽입**

`worker/src/idol_sight/llm/prompts.py` 의 `_ANALYSIS_DEPTH_GUIDELINES = """\` 정의 (라인 408 근처) **바로 위** 에 새 블록 정의:

```python
_INTERIM_FRAMING_GUIDELINES = """\
INTERIM FRAMING — 주중 중간점검 보고 규칙:

컨텍스트의 report_kind 필드를 먼저 확인한다.
  - report_kind == 'final'  → 직전 완결 일~토 주의 결산. 평소대로 작성.
  - report_kind == 'interim' → 이번 주 일~수(4일, 미완결) 중간 스냅샷.

report_kind == 'interim' 일 때 추가 규칙:
  ① 모든 카드 body 는 "주중 중간(일~수)" 임을 한 번은 명시. 주간 총량을
     확정 결산으로 단정하지 말 것 ("이번 주 X 달성" ❌ →
     "수요일까지 X, 주 후반 변동 가능" ✅).
  ② 비교는 전주의 같은 4일(일~수)과 한다. 컨텍스트의 prev_7d 는 이미
     같은 span(−7일)으로 잡혀 있으니 그대로 활용 — 완결 주와 4일을
     섞어 비교하지 말 것.
  ③ 한터/음원 등 주간 차트는 mid-week 에 미확정일 수 있다(hanteo 배열이
     비어있을 수 있음). 없으면 "주중이라 차트 미집계" 로 처리하고 환각
     금지.
  ④ ipx_action 은 interim 에서도 가능하나, 주말 결산 전 잠정 신호임을
     반영해 과잉 단정 금지.
"""

```

같은 파일에서 다른 `PROMPT_WEEKLY_*` export 들(라인 510-513 근처) 옆에 export 추가:

```python
PROMPT_WEEKLY_INTERIM_FRAMING = _INTERIM_FRAMING_GUIDELINES
```

그리고 `PROMPT_WEEKLY = f"""\ ...` 본문에서 `{_ANALYSIS_DEPTH_GUIDELINES}` 줄 (라인 553 근처) **바로 다음** 에 삽입:

```python
{_ANALYSIS_DEPTH_GUIDELINES}

{_INTERIM_FRAMING_GUIDELINES}
```

- [ ] **Step 4: 테스트 통과 확인 (신규 + 기존 프롬프트 회귀)**

Run: `cd worker && uv run pytest tests/unit/test_prompts.py -v`
Expected: PASS — 신규 + 기존 analysis_depth/body_formatting/ipx_action 회귀 전부.

- [ ] **Step 5: 커밋**

```bash
git add worker/src/idol_sight/llm/prompts.py worker/tests/unit/test_prompts.py
git commit -m "feat(weekly): interim 중간점검 프레이밍 프롬프트 블록

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: cli.py — analyze-weekly 에 --kind 옵션

CLI 에 `--kind` 옵션을 추가하고 `generate_weekly` 호출에 전달한다.

**Files:**
- Modify: `worker/src/idol_sight/cli.py` (라인 945-949 시그니처, 라인 1132 근처 generate_weekly 호출)

- [ ] **Step 1: --kind 옵션 추가**

`analyze_weekly` 시그니처 (라인 946-949) 변경:

```python
@app.command("analyze-weekly", help="Run weekly analysis: hanteo, market_share, member_pop, llm.")
def analyze_weekly(
    week_start: str = typer.Option(..., "--week-start", help="YYYY-MM-DD (Sunday)"),
    week_end: str   = typer.Option(..., "--week-end",   help="YYYY-MM-DD (Saturday for final, Wed for interim)"),
    kind: str       = typer.Option("final", "--kind", help="final (일=완결주 결산) | interim (수=중간점검)"),
) -> None:
```

- [ ] **Step 2: generate_weekly 호출에 report_kind 전달**

라인 1132 근처 `generate_weekly(...)` 호출 (phase 5b) 에 `report_kind=kind` 추가:

```python
        weekly = generate_weekly(
            db=client, gemini=gemini,
            week_start=week_start, week_end=week_end,
            signals_by_group=signals_by_group,
            report_kind=kind,
        )
```

- [ ] **Step 3: CLI 동작 확인 (--help 에 --kind 노출)**

Run: `cd worker && uv run python -m idol_sight analyze-weekly --help`
Expected: 출력에 `--kind` 옵션과 `final ... | interim ...` 설명이 보인다.

- [ ] **Step 4: worker 전체 테스트**

Run: `cd worker && uv run pytest`
Expected: PASS (전체 — Task 1-3 회귀 포함, 신규 실패 없음).

- [ ] **Step 5: 커밋**

```bash
git add worker/src/idol_sight/cli.py
git commit -m "feat(weekly): analyze-weekly --kind interim|final 옵션

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 워크플로 — cron 주 2회 + bounds 요일 분기

cron 을 일·수 23:00 KST 로 바꾸고, `bounds` 스텝이 요일로 모드를 결정해 윈도와 `kind` 를 산출하고, `--kind` 를 CLI 에 전달한다.

**Files:**
- Modify: `.github/workflows/analyze-weekly.yml`

- [ ] **Step 1: cron 변경**

라인 3-4 의 schedule 변경:

```yaml
on:
  schedule:
    - cron: '0 14 * * 0,3'     # Sun & Wed 14:00 UTC = Sun & Wed 23:00 KST
  workflow_dispatch:
    inputs:
      week_start: {description: 'YYYY-MM-DD (Sunday)', required: false}
      week_end:   {description: 'YYYY-MM-DD (Saturday=final / Wed=interim)', required: false}
      kind:       {description: 'final | interim (auto by weekday if blank)', required: false}
```

- [ ] **Step 2: bounds 스텝을 요일 분기로 교체**

`Compute week bounds (if not provided)` 스텝 (라인 21-42) 의 `run: |` 블록 전체를 아래로 교체. 수동 dispatch 입력이 있으면 그대로, 없으면 UTC 요일로 모드 결정:

```yaml
      - name: Compute week bounds + kind (if not provided)
        id: bounds
        run: |
          if [[ -n "${{ inputs.week_start }}" && -n "${{ inputs.week_end }}" ]]; then
            echo "ws=${{ inputs.week_start }}" >> "$GITHUB_OUTPUT"
            echo "we=${{ inputs.week_end }}"   >> "$GITHUB_OUTPUT"
            kind="${{ inputs.kind }}"
            echo "kind=${kind:-final}" >> "$GITHUB_OUTPUT"
          else
            # 요일로 모드 결정 (cron 은 일=0, 수=3 에만 발사):
            #   일요일(weekday 6) → final: 직전 완결 일~토.
            #   그 외(수요일)     → interim: 이번 주 일 ~ 오늘(수).
            # out=$(...) 는 set -eo pipefail 하에서 python 실패 시 step 을
            # 중단시킨다(process substitution 은 안 그래서 here-string 사용).
            out=$(python3 -c "
          import datetime as d
          t = d.date.today()                      # runner 는 UTC
          wd = t.weekday()                         # Mon=0 .. Sun=6
          if wd == 6:                              # 일요일 → final
              end = t - d.timedelta(days=1)        # 직전 토요일
              start = end - d.timedelta(days=6)    # 그 주 일요일
              kind = 'final'
          else:                                    # 수요일 → interim
              start = t - d.timedelta(days=(wd + 1) % 7)  # 이번 주 일요일
              end = t                              # 오늘(수)
              kind = 'interim'
          print(start.isoformat(), end.isoformat(), kind)
          ")
            read -r ws we kind <<< "$out"
            echo "ws=$ws"     >> "$GITHUB_OUTPUT"
            echo "we=$we"     >> "$GITHUB_OUTPUT"
            echo "kind=$kind" >> "$GITHUB_OUTPUT"
          fi
```

- [ ] **Step 3: analyze-weekly 실행에 --kind 전달**

`run: |` 의 CLI 호출 (라인 43-47) 변경:

```yaml
      - run: |
          uv run python -m idol_sight analyze-weekly \
            --week-start ${{ steps.bounds.outputs.ws }} \
            --week-end   ${{ steps.bounds.outputs.we }} \
            --kind       ${{ steps.bounds.outputs.kind }}
        working-directory: worker
```

(env 블록은 불변.)

- [ ] **Step 4: YAML 문법 검증 + bounds 로직 수동 검산**

Run (YAML 파싱):
```bash
cd /Users/user/Desktop/idol-sight && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/analyze-weekly.yml')); print('YAML OK')"
```
Expected: `YAML OK`

Run (bounds 로직 — 일요일/수요일 두 케이스 직접 검산):
```bash
python3 -c "
import datetime as d
for t in [d.date(2026,6,14), d.date(2026,6,10)]:  # 일, 수
    wd = t.weekday()
    if wd == 6:
        end = t - d.timedelta(days=1); start = end - d.timedelta(days=6); kind='final'
    else:
        start = t - d.timedelta(days=(wd+1)%7); end = t; kind='interim'
    print(t, '->', start, end, kind)
"
```
Expected:
```
2026-06-14 -> 2026-06-07 2026-06-13 final
2026-06-10 -> 2026-06-07 2026-06-10 interim
```
(두 보고가 week_start=2026-06-07 공유 확인 — report_kind 로 공존.)

- [ ] **Step 5: 커밋**

```bash
git add .github/workflows/analyze-weekly.yml
git commit -m "feat(weekly): cron 주 2회(일·수 23:00 KST) + bounds 요일 분기

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 프런트 market-share.ts — 토요일 완결주 가드

수요일 interim 전체 파이프라인이 `agg_market_share` 에 쓰는 부분 주(week_end=수) 행이 트렌드 차트에 끼지 않게 토요일만 표시한다.

**Files:**
- Modify: `frontend/functions/api/market-share.ts`

- [ ] **Step 1: 트렌드 쿼리에 토요일 가드 추가**

`frontend/functions/api/market-share.ts` 의 SQL 변경 (`WHERE week_end >= ...` 절에 `AND strftime` 추가):

```typescript
  const rows = await d1Query<ShareRow>(env.DB,
    `SELECT * FROM agg_market_share
      WHERE week_end >= date('now', ?)
        AND strftime('%w', week_end) = '6'
      ORDER BY week_start ASC, group_key ASC`,
    [`-${weeks * 7} days`]);
```

> `strftime('%w', ...)`: 일=0 .. 토=6. 토요일(완결주)만 트렌드에 표시. 기존 데이터의 week_end 는 전부 토요일이라 무영향, 신규 수요일 interim 행만 제외된다. LLM 컨텍스트(`build_context` 의 `WHERE week_end=?`)는 이 가드와 무관하게 interim 행을 정상 참조한다.

- [ ] **Step 2: 타입 체크**

Run: `cd frontend && pnpm typecheck`
Expected: 에러 없음 (clean).

- [ ] **Step 3: 커밋**

```bash
git add frontend/functions/api/market-share.ts
git commit -m "fix(weekly): SOV 트렌드를 토요일 완결주만 표시 (interim 부분주 제외)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: 프런트 insights.ts — report_kind SELECT + interim 3주 숨김

기본 피드에서 final 은 영구 노출, interim 은 최근 3주만 노출한다. `?week=` 명시 조회 시엔 둘 다 노출. SELECT 컬럼에 `report_kind` 추가.

**Files:**
- Modify: `frontend/functions/api/insights.ts`

- [ ] **Step 1: cols 에 report_kind 추가 + 기본 피드 필터**

`frontend/functions/api/insights.ts` 전체를 아래로 교체:

```typescript
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const week = url.searchParams.get("week");
  // report_kind (migration 0083): 'final'(일=결산) | 'interim'(수=중간점검).
  const cols = "id, generated_at, week_start, scope, type, title, body, "
             + "source_refs_json, ai_comment, report_kind";
  // 기본 피드: final 은 영구 노출, interim 은 최근 3주(week_start >= 오늘-21일)만.
  // ?week= 명시 조회 시엔 그 주의 interim/final 둘 다 노출(필터 미적용).
  const sql = week
    ? `SELECT ${cols} FROM insights WHERE week_start = ? ORDER BY id DESC`
    : `SELECT ${cols} FROM insights
        WHERE report_kind = 'final'
           OR week_start >= date('now', '-21 days')
        ORDER BY generated_at DESC LIMIT 50`;
  const rows = await d1Query<any>(env.DB, sql, week ? [week] : []);
  return jsonResponse({
    insights: rows.map((r) => ({
      ...r,
      source_refs: (() => { try { return JSON.parse(r.source_refs_json ?? "[]"); }
                            catch { return []; } })(),
    })),
  });
};
```

- [ ] **Step 2: 타입 체크**

Run: `cd frontend && pnpm typecheck`
Expected: 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add frontend/functions/api/insights.ts
git commit -m "feat(weekly): insights 피드 — final 영구 + interim 3주 숨김

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 프런트 Insights.tsx — 중간점검 배지

interim 카드에 "중간점검" 배지를 단다 (final 은 기본이라 배지 없음 — 시각 노이즈 최소화).

**Files:**
- Modify: `frontend/src/views/Insights.tsx` (라인 100-104 상단 라인 칩 영역)

- [ ] **Step 1: type 칩 옆에 interim 배지 추가**

`frontend/src/views/Insights.tsx` 의 type 칩 `<span>` (라인 100-102) **바로 다음** 에 interim 배지 추가:

```tsx
                <span class="rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] uppercase tracking-wider text-zinc-400">
                  {TYPE_LABEL[i.type] ?? i.type}
                </span>
                {i.report_kind === "interim" && (
                  <span class="rounded bg-amber-500/15 px-1.5 py-[1px] text-[10px] tracking-wider text-amber-300">
                    중간점검
                  </span>
                )}
                <span class="text-zinc-600">·</span>
```

- [ ] **Step 2: 타입 체크**

Run: `cd frontend && pnpm typecheck`
Expected: 에러 없음.

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/views/Insights.tsx
git commit -m "feat(weekly): 인사이트 카드 중간점검 배지

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 최종 검증 + 마이그레이션 적용 안내

**Files:** 없음 (검증 + 운영자 안내).

- [ ] **Step 1: worker 전체 테스트**

Run: `cd worker && uv run pytest`
Expected: PASS (전체).

- [ ] **Step 2: frontend 전체 테스트 + 타입 체크**

Run: `cd frontend && pnpm test && pnpm typecheck`
Expected: PASS + 타입 에러 없음.

- [ ] **Step 3: 운영자에게 마이그레이션 적용 안내**

CLAUDE.md 의 배포↔마이그레이션 순서 규칙: `insights.report_kind` 를 읽는 코드(Task 7)가 배포되기 전에 migration 0083 이 원격 적용돼야 한다. `insights.ts` 가 `report_kind` 를 SELECT 하므로 컬럼 부재 시 500 위험.

운영자에게 안내 (D1 원격 apply 는 human-only — 메모리 `feedback_d1_remote_apply_human_only`):

> migration 0083 적용을 위해 다음을 직접 실행하세요 (적용 대기 중인 0082 와 함께 순서대로 적용됨):
> ```
> ! gh workflow run migrate.yml
> ```
> 또는 `cd frontend && wrangler d1 migrations apply idol-sight --remote`.
> 적용 완료 후 다음 일·수 23:00 KST cron(또는 수동 `gh workflow run analyze-weekly.yml`)이 interim/final 보고를 생성한다.

- [ ] **Step 4: 작업 로그 (SecondBrain)**

전역 규칙(`~/.claude/SecondBrainLog.md`): `~/SecondBrain/00_Inbox/작업로그 YYYY-MM-DD.md` 에 한 줄 append:
```
- (HH:MM · idol-sight) weekly 분석 보고 주 2회(수=중간점검/일=결산) 전환 — report_kind 보존 + interim 3주 숨김
```

---

## 완료 기준

- `cd worker && uv run pytest` PASS, `cd frontend && pnpm test && pnpm typecheck` PASS.
- analyze-weekly.yml cron `0 14 * * 0,3`, bounds 가 일=final/수=interim 산출.
- migration 0083 원격 적용(운영자) 후 insights 에 report_kind 채워짐.
- 대시보드 인사이트 피드: 결산 영구 + 중간점검 3주 노출 + 중간점검 배지, SOV 트렌드는 토요일만.
