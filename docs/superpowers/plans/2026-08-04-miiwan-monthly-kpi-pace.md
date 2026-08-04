# MiiWAN 월간 KPI 페이스 표 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 포지션 탭에 월별(2026-06~12) 목표 밴드 대비 실측 KPI 표를 추가하고, 위버스 가입자·멤버십을 구글 시트에서 자동 수집한다.

**Architecture:** ① Python worker에 시트 CSV 수집기(`weverse_sheet.py`) + D1 `weverse_stats` 테이블 신설 → ② `/api/miiwan`이 월별 실측(`monthly_kpi`)을 집계해 응답 → ③ 프론트 `lib/miiwanKpi.ts`의 목표 밴드 상수·판정 로직과 결합해 `MiiWANPosition.tsx`에 표 렌더.

**Tech Stack:** Python 3.12(httpx·typer·uv·pytest) / Cloudflare D1(SQLite) / Pages Functions(TS) / Preact + vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-miiwan-monthly-kpi-pace-design.md`

## Global Constraints

- 브랜치: `feature/miiwan-monthly-kpi-pace` (이미 체크아웃됨).
- 금액(매출·원가) 수치는 어디에도 넣지 않는다.
- K-POP/서브컬처 분리 제약은 이 표와 무관(MiiWAN 자사 데이터만 다룸).
- 수집기는 D1에 직접 쓰지 않는다 — `CollectionResult.statements`를 반환하면 orchestrator가 쓴다 (`collectors/base.py` 계약).
- 커밋 메시지 말미: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01ExpxHqyK31pVcsZiBceH2n`.
- worker 테스트 실행: `cd worker && uv run pytest tests/unit/<file> -q` / 프론트: `cd frontend && pnpm vitest run <file>`.

---

### Task 1: D1 마이그레이션 `weverse_stats`

**Files:**
- Create: `migrations/0111_weverse_stats.sql`

**Interfaces:**
- Produces: 테이블 `weverse_stats(group_key, day, total_members, digital_membership, countries, collected_at)` — Task 2(수집기)와 Task 5(API)가 이 스키마를 그대로 사용.

- [ ] **Step 1: 마이그레이션 파일 작성**

```sql
-- migrations/0111_weverse_stats.sql
-- 미완소년 위버스 가입자·디지털 멤버십 일별 스탯. 위버스는 공개 API가
-- 없어 운영자가 구글 시트에 일별 기록 → weverse-sheet collector가 시트
-- 공개 CSV를 읽어 전량 upsert한다(멱등). countries는 시트의 국가별
-- 가입자 열을 JSON으로 보존(UI 미노출, 데이터만 적재).
CREATE TABLE IF NOT EXISTS weverse_stats (
  group_key           TEXT NOT NULL REFERENCES groups(key),
  day                 TEXT NOT NULL,   -- YYYY-MM-DD (시트의 KST 날짜)
  total_members       INTEGER,
  digital_membership  INTEGER,
  countries           TEXT,            -- JSON {"한국": n, ...}
  collected_at        TEXT NOT NULL,
  PRIMARY KEY (group_key, day)
);
```

- [ ] **Step 2: 커밋**

```bash
git add migrations/0111_weverse_stats.sql
git commit -m "feat(db): weverse_stats 테이블 — 위버스 일별 가입자·멤버십"
```

---

### Task 2: 수집기 `weverse_sheet.py` (TDD)

**Files:**
- Create: `worker/src/idol_sight/collectors/weverse_sheet.py`
- Test: `worker/tests/unit/test_weverse_sheet.py`

**Interfaces:**
- Consumes: `CollectionResult`, `Collector` 프로토콜 (`idol_sight/collectors/base.py`), `GroupConfig` (`idol_sight/config.py`).
- Produces: `WeverseSheetCollector(sheet_id: str, http_factory=None)` — `source = "weverse-sheet"`, `.collect(group, since=None) -> CollectionResult`. 순수 파서 `parse_sheet_rows(text: str) -> list[dict]` (dict 키: `day`, `total_members`, `digital_membership`, `countries`). Task 3(CLI 등록)이 생성자 시그니처를 사용.

- [ ] **Step 1: 실패하는 파서 테스트 작성**

`worker/tests/unit/test_weverse_sheet.py`:

```python
"""weverse_sheet 파서·수집기 테스트.

시트 실물 구조(2026-08-04 확인): 선행 빈 열 1개 + 빈 행 2개 위에
'날짜,총 가입자수,증가수,디지털 멤버십 가입수,증감수,한국,...' 헤더가 오고
날짜는 연도 없는 M/D, 천단위 쉼표가 섞인다.
"""
from idol_sight.collectors.weverse_sheet import WeverseSheetCollector, parse_sheet_rows

SHEET_CSV = """,,,,,,,,,,
,,,,,,,,,,
,날짜,총 가입자수,증가수,디지털 멤버십 가입수,증감수,한국,인도네시아,USA,중국,일본
,6/16,713,713,14,14,102,112,48,35,18
,6/17,"1,210",735,23,9,117,234,100,74,24
,7/31,"6,895",120,69,2,900,1900,700,650,300
,8/1,"6,930",35,69,0,905,1910,702,652,301
,,,,,,,,,,
"""


def test_parse_basic_rows():
    rows = parse_sheet_rows(SHEET_CSV)
    assert rows[0] == {
        "day": "2026-06-16",
        "total_members": 713,
        "digital_membership": 14,
        "countries": {"한국": 102, "인도네시아": 112, "USA": 48, "중국": 35, "일본": 18},
    }
    # 천단위 쉼표 제거
    assert rows[1]["total_members"] == 1210
    # 빈 꼬리 행은 스킵
    assert len(rows) == 4


def test_parse_year_rollover():
    csv_text = ",날짜,총 가입자수,증가수,디지털 멤버십 가입수,증감수,한국\n,12/31,100,1,5,0,50\n,1/1,101,1,5,0,51\n"
    rows = parse_sheet_rows(csv_text)
    assert rows[0]["day"] == "2026-12-31"
    assert rows[1]["day"] == "2027-01-01"


def test_parse_no_header_returns_empty():
    assert parse_sheet_rows("a,b,c\n1,2,3\n") == []


def test_collect_builds_upsert_statements():
    class FakeResp:
        text = SHEET_CSV
        def raise_for_status(self): pass

    class FakeClient:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url): return FakeResp()

    coll = WeverseSheetCollector(sheet_id="SHEET123", http_factory=lambda: FakeClient())

    class G:  # GroupConfig 대역 — collect는 key만 사용
        key = "miiwan"

    res = coll.collect(G())
    assert res.rows_inserted == 4
    assert not res.errors
    sql, params = res.statements[0]
    assert "INSERT INTO weverse_stats" in sql
    assert "ON CONFLICT(group_key, day)" in sql
    assert params[0] == "miiwan"
    assert params[1] == "2026-06-16"
    assert params[2] == 713          # total_members
    assert params[3] == 14           # digital_membership
    assert "한국" in params[4]        # countries JSON
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_weverse_sheet.py -q`
Expected: FAIL — `ModuleNotFoundError: idol_sight.collectors.weverse_sheet`

- [ ] **Step 3: 수집기 구현**

`worker/src/idol_sight/collectors/weverse_sheet.py`:

```python
"""Weverse stats collector (Google Sheet CSV).

미완소년 위버스 가입자·디지털 멤버십은 공개 API가 없어 운영자가 구글
시트에 일별 기록한다. 이 수집기는 그 시트의 공개 CSV export를 읽어
weverse_stats 전량 upsert 문을 생성한다(멱등 — 시트에서 과거 값을
고치면 다음 수집 때 반영). 시트엔 연도가 없어 START_YEAR에서 시작해
월이 줄어드는 지점마다 +1로 롤오버한다.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime
from time import perf_counter
from typing import Any, Callable

import httpx

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

EXPORT_URL = "https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid=0"
START_YEAR = 2026  # 시트 첫 데이터 행(6/16 = 데뷔일)의 연도
_META_COLS = {"날짜", "총 가입자수", "증가수", "디지털 멤버십 가입수", "증감수"}


def _num(cell: str | None) -> int | None:
    s = (cell or "").strip().replace(",", "")
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_sheet_rows(text: str) -> list[dict]:
    rows = list(csv.reader(io.StringIO(text)))
    header_idx = date_col = None
    for i, row in enumerate(rows):
        for j, cell in enumerate(row):
            if cell.strip() == "날짜":
                header_idx, date_col = i, j
                break
        if header_idx is not None:
            break
    if header_idx is None or date_col is None:
        return []

    col = {name.strip(): idx for idx, name in enumerate(rows[header_idx]) if name.strip()}
    country_cols = [(n, i) for n, i in col.items() if n not in _META_COLS]

    def cell(row: list[str], name: str) -> str | None:
        idx = col.get(name)
        return row[idx] if idx is not None and idx < len(row) else None

    out: list[dict] = []
    year, prev_month = START_YEAR, None
    for row in rows[header_idx + 1:]:
        raw = (row[date_col] if date_col < len(row) else "").strip()
        if "/" not in raw:
            continue
        try:
            m, d = (int(p) for p in raw.split("/", 1))
        except ValueError:
            continue
        if prev_month is not None and m < prev_month:
            year += 1
        prev_month = m
        total = _num(cell(row, "총 가입자수"))
        if total is None:  # 날짜만 미리 깔린 빈 행
            continue
        countries = {}
        for name, idx in country_cols:
            v = _num(row[idx] if idx < len(row) else None)
            if v is not None:
                countries[name] = v
        out.append({
            "day": f"{year:04d}-{m:02d}-{d:02d}",
            "total_members": total,
            "digital_membership": _num(cell(row, "디지털 멤버십 가입수")),
            "countries": countries,
        })
    return out


class WeverseSheetCollector:
    source = "weverse-sheet"

    def __init__(self, sheet_id: str, http_factory: Callable[[], Any] | None = None):
        self._sheet_id = sheet_id
        self._http_factory = http_factory or (
            lambda: httpx.Client(timeout=30.0, follow_redirects=True))

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        started = perf_counter()
        with self._http_factory() as client:
            r = client.get(EXPORT_URL.format(sheet_id=self._sheet_id))
            r.raise_for_status()
            text = r.text

        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []
        for p in parse_sheet_rows(text):
            statements.append((
                """
                INSERT INTO weverse_stats
                  (group_key, day, total_members, digital_membership, countries, collected_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(group_key, day) DO UPDATE SET
                  total_members=excluded.total_members,
                  digital_membership=excluded.digital_membership,
                  countries=excluded.countries,
                  collected_at=excluded.collected_at
                """.strip(),
                [group.key, p["day"], p["total_members"], p["digital_membership"],
                 json.dumps(p["countries"], ensure_ascii=False), now_iso],
            ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(statements), rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_weverse_sheet.py -q`
Expected: 4 passed

- [ ] **Step 5: 커밋**

```bash
git add worker/src/idol_sight/collectors/weverse_sheet.py worker/tests/unit/test_weverse_sheet.py
git commit -m "feat(worker): weverse-sheet collector — 구글 시트 CSV → weverse_stats"
```

---

### Task 3: 설정 + CLI 등록

**Files:**
- Modify: `worker/src/idol_sight/config.py` (Settings에 `miiwan_weverse_sheet_id` 추가)
- Modify: `worker/src/idol_sight/cli.py` (`KNOWN_SOURCES`·`_COLLECTORS`·`_INTERVALS_H`·`_make_collector`)
- Test: `worker/tests/unit/test_weverse_sheet.py` (make_collector 케이스 추가)

**Interfaces:**
- Consumes: Task 2의 `WeverseSheetCollector(sheet_id=...)`.
- Produces: CLI `collect --source weverse-sheet --group miiwan` 동작. env `MIIWAN_WEVERSE_SHEET_ID` (옵셔널, 미설정 시 RuntimeError). Task 4(cron)가 이 커맨드를 호출.

- [ ] **Step 1: 실패하는 테스트 추가** — `test_weverse_sheet.py`에 append:

```python
def test_make_collector_requires_sheet_id(monkeypatch):
    from idol_sight import cli
    for k in ("CF_ACCOUNT_ID", "CF_D1_DB_ID", "CF_API_TOKEN"):
        monkeypatch.setenv(k, "x")
    monkeypatch.delenv("MIIWAN_WEVERSE_SHEET_ID", raising=False)
    import pytest
    with pytest.raises(RuntimeError, match="MIIWAN_WEVERSE_SHEET_ID"):
        cli._make_collector("weverse-sheet")


def test_make_collector_builds_weverse(monkeypatch):
    from idol_sight import cli
    for k in ("CF_ACCOUNT_ID", "CF_D1_DB_ID", "CF_API_TOKEN"):
        monkeypatch.setenv(k, "x")
    monkeypatch.setenv("MIIWAN_WEVERSE_SHEET_ID", "SHEET123")
    coll = cli._make_collector("weverse-sheet")
    assert isinstance(coll, WeverseSheetCollector)
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_weverse_sheet.py -q`
Expected: 새 테스트 2개 FAIL (`unknown source 'weverse-sheet'`)

- [ ] **Step 3: config.py 수정** — `Settings`에 필드 추가(기존 `miiwan_yt_oauth_*` 블록 바로 아래):

```python
    # 미완소년 위버스 시트 (weverse-sheet collector). 공개 CSV export가
    # 가능한 구글 시트 ID — 미설정이면 해당 collector 미동작.
    miiwan_weverse_sheet_id: str | None
```

`load_settings()`에 추가:

```python
        miiwan_weverse_sheet_id=_optional("MIIWAN_WEVERSE_SHEET_ID"),
```

- [ ] **Step 4: cli.py 수정** — 네 곳:

```python
# KNOWN_SOURCES에 추가
    "hanteo", "channel-stats", "weverse-sheet",

# import (다른 collector import 옆)
from idol_sight.collectors.weverse_sheet import WeverseSheetCollector

# _COLLECTORS에 추가
    "weverse-sheet": WeverseSheetCollector,

# _INTERVALS_H에 추가 (collect-daily 1회/일과 정렬 — health-check threshold = 24h*4)
    "weverse-sheet": 24,

# _make_collector 내 (NaverCollector 분기 앞에) 추가
    if cls is WeverseSheetCollector:
        if not settings.miiwan_weverse_sheet_id:
            raise RuntimeError("weverse-sheet requires MIIWAN_WEVERSE_SHEET_ID env")
        return cls(sheet_id=settings.miiwan_weverse_sheet_id)
```

- [ ] **Step 5: 전체 worker 테스트 통과 확인**

Run: `cd worker && uv run pytest tests/unit -q`
Expected: 전부 passed (기존 `test_cli_intervals.py`가 KNOWN_SOURCES↔_INTERVALS_H 정합을 검사할 수 있음 — 깨지면 그 테스트의 기대 목록에도 `weverse-sheet` 추가)

- [ ] **Step 6: 커밋**

```bash
git add worker/src/idol_sight/config.py worker/src/idol_sight/cli.py worker/tests/unit/test_weverse_sheet.py
git commit -m "feat(worker): weverse-sheet CLI 등록 + MIIWAN_WEVERSE_SHEET_ID 설정"
```

---

### Task 4: collect-daily cron 편입

**Files:**
- Modify: `.github/workflows/collect-daily.yml`

**Interfaces:**
- Consumes: Task 3의 `collect --source weverse-sheet --group miiwan`.
- Produces: 매일 1회 자동 수집. GitHub secret `MIIWAN_WEVERSE_SHEET_ID` 필요(수동 등록 — Task 7에서 처리).

- [ ] **Step 1: matrix에 include 추가** — `matrix:` 블록(group/source 아래)에:

```yaml
        # weverse-sheet은 미완소년 전용 (시트가 자사 운영 데이터라 타 그룹 없음)
        include:
          - source: weverse-sheet
            group: miiwan
```

collect 스텝의 `env:` 블록에 한 줄 추가:

```yaml
          MIIWAN_WEVERSE_SHEET_ID: ${{ secrets.MIIWAN_WEVERSE_SHEET_ID }}
```

- [ ] **Step 2: YAML 문법 확인**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/collect-daily.yml'))" && echo OK`
Expected: OK

- [ ] **Step 3: 커밋**

```bash
git add .github/workflows/collect-daily.yml
git commit -m "ci: collect-daily에 weverse-sheet:miiwan 편입"
```

---

### Task 5: `/api/miiwan`에 `monthly_kpi` 집계 추가

**Files:**
- Modify: `frontend/functions/api/miiwan.ts` (Promise.all에 쿼리 3개 + 응답 필드)

**Interfaces:**
- Consumes: `agg_summary`·`live_ccv_samples`·`weverse_stats`(Task 1).
- Produces: 응답 필드 `monthly_kpi: Array<{month, yt_subscribers, avg_ccv, weverse_members, weverse_membership, in_progress}>` — Task 6(프론트)이 이 형태를 그대로 소비.

- [ ] **Step 1: Promise.all 배열 끝(ccvTrend 쿼리 뒤)에 쿼리 3개 추가**, 구조분해에 `subsMonthly, ccvMonthly, weverseMonthly` 추가:

```ts
    // 월간 KPI 페이스 — 월별 실측 3원천. 월 경계는 UTC 스냅샷 기준
    // (KST 대비 최대 9시간 오차 — 월말 스냅샷 값에는 무시 가능 수준).
    // ① 구독자: 각 월 마지막 agg_summary 스냅샷.
    d1Query<{ month: string; yt_subscribers: number | null }>(
      env.DB,
      `SELECT month, yt_subscribers FROM (
         SELECT strftime('%Y-%m', snapshot_at) AS month, yt_subscribers,
                ROW_NUMBER() OVER (
                  PARTITION BY strftime('%Y-%m', snapshot_at)
                  ORDER BY snapshot_at DESC) AS rn
           FROM agg_summary WHERE group_key=?)
        WHERE rn=1 ORDER BY month ASC`,
      [TARGET],
    ).catch(() => [] as Array<{ month: string; yt_subscribers: number | null }>),
    // ② 평균 동접: 방송(video_id)별 평균 CCV → 월별 평균. 먼슬리 보고의
    // "평균 시청자"와 같은 정의(방송당 평균의 평균 — 샘플 수 가중 아님).
    d1Query<{ month: string; avg_ccv: number | null }>(
      env.DB,
      `SELECT month, ROUND(AVG(vid_avg)) AS avg_ccv FROM (
         SELECT strftime('%Y-%m', MIN(sampled_at)) AS month,
                AVG(concurrent_viewers) AS vid_avg
           FROM live_ccv_samples WHERE group_key=?
          GROUP BY video_id)
        GROUP BY month ORDER BY month ASC`,
      [TARGET],
    ).catch(() => [] as Array<{ month: string; avg_ccv: number | null }>),
    // ③ 위버스: 각 월 마지막 일자 값 (weverse-sheet collector 적재분).
    d1Query<{ month: string; weverse_members: number | null; weverse_membership: number | null }>(
      env.DB,
      `SELECT month, total_members AS weverse_members,
              digital_membership AS weverse_membership FROM (
         SELECT strftime('%Y-%m', day) AS month, total_members, digital_membership,
                ROW_NUMBER() OVER (
                  PARTITION BY strftime('%Y-%m', day) ORDER BY day DESC) AS rn
           FROM weverse_stats WHERE group_key=?)
        WHERE rn=1 ORDER BY month ASC`,
      [TARGET],
    ).catch(() => [] as Array<{ month: string; weverse_members: number | null; weverse_membership: number | null }>),
```

- [ ] **Step 2: 응답 조립** — `jsonResponse({...})`의 `industry` 필드 앞에 추가:

```ts
    // 월간 KPI 페이스 (포지션 뷰) — 데뷔 월부터 당월까지 월별 실측.
    // 당월은 월말 확정 전이라 in_progress로 표시.
    monthly_kpi: (() => {
      const byMonth = new Map<string, any>();
      for (const r of subsMonthly ?? []) {
        byMonth.set(r.month, { month: r.month, yt_subscribers: r.yt_subscribers ?? null });
      }
      for (const r of ccvMonthly ?? []) {
        byMonth.set(r.month, { ...(byMonth.get(r.month) ?? { month: r.month }), avg_ccv: r.avg_ccv ?? null });
      }
      for (const r of weverseMonthly ?? []) {
        byMonth.set(r.month, {
          ...(byMonth.get(r.month) ?? { month: r.month }),
          weverse_members: r.weverse_members ?? null,
          weverse_membership: r.weverse_membership ?? null,
        });
      }
      const thisMonth = todayIso.slice(0, 7);
      return [...byMonth.values()]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((r) => ({
          yt_subscribers: null, avg_ccv: null,
          weverse_members: null, weverse_membership: null,
          ...r,
          in_progress: r.month === thisMonth,
        }));
    })(),
```

- [ ] **Step 3: 타입 체크**

Run: `cd frontend && pnpm exec tsc --noEmit`
Expected: 에러 없음 (기존 에러가 있다면 이 변경으로 늘어난 게 없어야 함)

- [ ] **Step 4: 커밋**

```bash
git add frontend/functions/api/miiwan.ts
git commit -m "feat(api): /api/miiwan monthly_kpi — 월별 구독·동접·위버스 집계"
```

---

### Task 6: 프론트 `lib/miiwanKpi.ts` (TDD)

**Files:**
- Create: `frontend/src/lib/miiwanKpi.ts`
- Test: `frontend/src/lib/miiwanKpi.test.ts`

**Interfaces:**
- Consumes: Task 5의 `monthly_kpi` 행 형태(`MonthlyKpiRow`).
- Produces: `PACE_BANDS`, `OFFICIAL_KPI`, `MONTH_NOTES`, `KPI_LABEL`, `KPI_METRICS`, `bandVerdict(actual, band) -> "below"|"within"|"above"`, `buildKpiTable(monthly) -> KpiTableRow[]`, `officialProgress(monthly) -> Array<{label, items}>` — Task 7(UI)이 전부 소비.

- [ ] **Step 1: 실패하는 테스트 작성** — `frontend/src/lib/miiwanKpi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  bandVerdict, buildKpiTable, officialProgress,
  KPI_METRICS, PACE_BANDS, type MonthlyKpiRow,
} from "./miiwanKpi";

const row = (month: string, over: Partial<MonthlyKpiRow> = {}): MonthlyKpiRow => ({
  month, yt_subscribers: null, avg_ccv: null,
  weverse_members: null, weverse_membership: null, in_progress: false, ...over,
});

describe("bandVerdict", () => {
  it("경계 포함 판정", () => {
    expect(bandVerdict(31999, [32000, 35000])).toBe("below");
    expect(bandVerdict(32000, [32000, 35000])).toBe("within");
    expect(bandVerdict(35000, [32000, 35000])).toBe("within");
    expect(bandVerdict(35001, [32000, 35000])).toBe("above");
  });
});

describe("buildKpiTable", () => {
  it("과거 월엔 판정, 당월엔 in_progress, 미래 월엔 밴드만", () => {
    const table = buildKpiTable([
      row("2026-06", { yt_subscribers: 27900 }),
      row("2026-07", { yt_subscribers: 28600 }),
      row("2026-08", { yt_subscribers: 29000, in_progress: true }),
    ]);
    const subs = table.find((r) => r.metric === "subscribers")!;
    const jun = subs.cells.find((c) => c.month === "2026-06")!;
    expect(jun.actual).toBe(27900);
    expect(jun.band).toBeNull();      // 6월 = 실측 기점, 밴드 없음
    expect(jun.verdict).toBeNull();
    const jul = subs.cells.find((c) => c.month === "2026-07")!;
    expect(jul.verdict).toBe("below"); // 28.6K < 32K
    const aug = subs.cells.find((c) => c.month === "2026-08")!;
    expect(aug.inProgress).toBe(true);
    expect(aug.verdict).toBeNull();    // 진행 중엔 판정 유보
    const dec = subs.cells.find((c) => c.month === "2026-12")!;
    expect(dec.actual).toBeNull();
    expect(dec.band).toEqual(PACE_BANDS["2026-12"].subscribers);
  });

  it("지표 4개 × 6~12월 셀을 항상 생성", () => {
    const table = buildKpiTable([]);
    expect(table.map((r) => r.metric)).toEqual([...KPI_METRICS]);
    for (const r of table) expect(r.cells).toHaveLength(7);
  });
});

describe("officialProgress", () => {
  it("최신 실측 대비 달성률", () => {
    const prog = officialProgress([
      row("2026-07", { yt_subscribers: 28600, avg_ccv: 369 }),
    ]);
    const aug = prog[0];
    expect(aug.label).toContain("8월");
    const subs = aug.items.find((i) => i.metric === "subscribers")!;
    expect(subs.actual).toBe(28600);
    expect(subs.target).toBe(30000);
    expect(subs.pct).toBe(95);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm vitest run src/lib/miiwanKpi.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현** — `frontend/src/lib/miiwanKpi.ts`:

```ts
// 미완소년 월간 KPI 페이스 — 목표 밴드(내부 계획 가정치, 2026-06-30 확정)
// 대비 실측으로 "계획 페이스 안에 있는가"를 판정한다. 밴드·공식 KPI는
// 볼트 'KPI·매출 가정치 레퍼런스' §5와 먼슬리 보고에서 옮긴 고정 계획
// 수치라 상수로 둔다. 금액 지표는 다루지 않는다.

export type KpiMetric =
  | "subscribers" | "avg_ccv" | "weverse_members" | "weverse_membership";

export interface MonthlyKpiRow {
  month: string;                       // "2026-06"
  yt_subscribers: number | null;       // 월말 스냅샷
  avg_ccv: number | null;              // 방송별 평균 CCV의 월평균
  weverse_members: number | null;      // 월말
  weverse_membership: number | null;   // 월말
  in_progress: boolean;                // 당월(월말 확정 전)
}

export const KPI_METRICS = [
  "subscribers", "avg_ccv", "weverse_members", "weverse_membership",
] as const satisfies readonly KpiMetric[];

export const KPI_LABEL: Record<KpiMetric, string> = {
  subscribers: "YouTube 구독자",
  avg_ccv: "평균 라이브 동접",
  weverse_members: "위버스 가입자",
  weverse_membership: "유료 멤버십",
};

export const KPI_MONTHS = [
  "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
] as const;

/** [보수, 낙관]. 2026-06은 실측 기점이라 밴드 없음. */
export const PACE_BANDS: Record<string, Partial<Record<KpiMetric, [number, number]>>> = {
  "2026-07": { subscribers: [32000, 35000], avg_ccv: [700, 760], weverse_members: [4200, 4600], weverse_membership: [70, 80] },
  "2026-08": { subscribers: [37000, 45000], avg_ccv: [850, 1050], weverse_members: [4800, 5900], weverse_membership: [130, 170] },
  "2026-09": { subscribers: [43000, 55000], avg_ccv: [1000, 1300], weverse_members: [5600, 7200], weverse_membership: [300, 400] },
  "2026-10": { subscribers: [50000, 68000], avg_ccv: [1200, 1600], weverse_members: [6500, 8800], weverse_membership: [450, 600] },
  "2026-11": { subscribers: [62000, 80000], avg_ccv: [1500, 1900], weverse_members: [8000, 10400], weverse_membership: [580, 770] },
  "2026-12": { subscribers: [72000, 90000], avg_ccv: [1600, 2000], weverse_members: [9500, 11700], weverse_membership: [700, 900] },
};

/** ◆ 의사결정 시점 · ★ 컴백 — 표 열 헤더에 병기. */
export const MONTH_NOTES: Record<string, string> = {
  "2026-08": "◆ 굿즈 참여 결정",
  "2026-09": "★ 디지털 싱글 컴백",
  "2026-10": "◆ 제작 스케일·팬미팅 결정",
};

/** 먼슬리 보고의 공식 KPI 목표 (금액 아님 — 구독·동접만 공식 목표가 있다). */
export const OFFICIAL_KPI = [
  { month: "2026-08", label: "8월 말 공식 KPI", targets: { subscribers: 30000, avg_ccv: 1000 } },
  { month: "2026-11", label: "11월 말 공식 KPI", targets: { subscribers: 72000, avg_ccv: 1600 } },
] as const;

export type BandVerdict = "below" | "within" | "above";

export function bandVerdict(actual: number, band: [number, number]): BandVerdict {
  if (actual < band[0]) return "below";
  if (actual > band[1]) return "above";
  return "within";
}

export interface KpiCell {
  month: string;
  band: [number, number] | null;
  actual: number | null;
  verdict: BandVerdict | null;   // 실측+밴드 있고 확정 월일 때만
  inProgress: boolean;
}

export interface KpiTableRow { metric: KpiMetric; cells: KpiCell[] }

const METRIC_FIELD: Record<KpiMetric, keyof MonthlyKpiRow> = {
  subscribers: "yt_subscribers",
  avg_ccv: "avg_ccv",
  weverse_members: "weverse_members",
  weverse_membership: "weverse_membership",
};

export function buildKpiTable(monthly: MonthlyKpiRow[]): KpiTableRow[] {
  const byMonth = new Map(monthly.map((r) => [r.month, r]));
  return KPI_METRICS.map((metric) => ({
    metric,
    cells: KPI_MONTHS.map((month) => {
      const row = byMonth.get(month) ?? null;
      const actual = (row?.[METRIC_FIELD[metric]] as number | null) ?? null;
      const band = PACE_BANDS[month]?.[metric] ?? null;
      const inProgress = row?.in_progress ?? false;
      return {
        month, band, actual, inProgress,
        verdict: actual != null && band != null && !inProgress
          ? bandVerdict(actual, band) : null,
      };
    }),
  }));
}

export interface OfficialProgressItem {
  metric: KpiMetric; actual: number | null; target: number; pct: number | null;
}

/** 공식 KPI 2시점 대비 최신 실측 달성률 (0~100+, 반올림). */
export function officialProgress(monthly: MonthlyKpiRow[]) {
  const latest = (metric: KpiMetric): number | null => {
    for (let i = monthly.length - 1; i >= 0; i--) {
      const v = monthly[i][METRIC_FIELD[metric]] as number | null;
      if (v != null) return v;
    }
    return null;
  };
  return OFFICIAL_KPI.map((k) => ({
    month: k.month,
    label: k.label,
    items: (Object.entries(k.targets) as Array<[KpiMetric, number]>).map(
      ([metric, target]): OfficialProgressItem => {
        const actual = latest(metric);
        return {
          metric, actual, target,
          pct: actual != null ? Math.round((actual / target) * 100) : null,
        };
      }),
  }));
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && pnpm vitest run src/lib/miiwanKpi.test.ts`
Expected: 전부 passed

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/miiwanKpi.ts frontend/src/lib/miiwanKpi.test.ts
git commit -m "feat(front): miiwanKpi — 월간 KPI 페이스 밴드·판정·달성률 로직"
```

---

### Task 7: 포지션 탭 표 섹션 + prop 배선

**Files:**
- Modify: `frontend/src/views/MiiWANPosition.tsx` ("③ 방향과 속도" 섹션 뒤에 새 섹션, props에 `monthlyKpi` 추가)
- Modify: `frontend/src/views/MiiWANBriefing.tsx` (`<MiiWANPosition ... monthlyKpi={...}>` 전달 + 응답 타입에 `monthly_kpi?` 추가)

**Interfaces:**
- Consumes: Task 6의 전부, Task 5의 `data.monthly_kpi`.
- Produces: 사용자 노출 UI (신규 export 없음).

- [ ] **Step 1: MiiWANPosition props 확장** — import 추가:

```ts
import {
  buildKpiTable, officialProgress, bandVerdict, KPI_LABEL, KPI_MONTHS,
  MONTH_NOTES, type MonthlyKpiRow,
} from "../lib/miiwanKpi";
```

props 인터페이스에 (cohortRaw 아래):

```ts
  /** /api/miiwan monthly_kpi — 월간 KPI 페이스 표. */
  monthlyKpi: MonthlyKpiRow[];
```

- [ ] **Step 2: 섹션 렌더 추가** — "③ 방향과 속도" `</section>`과 "④ 팬덤 프로필" 사이에:

```tsx
      {/* ③b 월간 KPI 페이스 — 계획(보수~낙관 밴드) 위에 실측을 얹어
          "페이스 안인가"를 답한다. 밴드=내부 계획 가정치(고정 상수),
          실측=agg_summary·live_ccv·weverse_stats. 당월은 판정 유보. */}
      <section>
        <div class="mb-2 flex flex-wrap items-baseline gap-2">
          <h2 class="section-title">월간 KPI 페이스</h2>
          <span class="text-hint text-zinc-500">
            목표 밴드 = 내부 계획 가정치(보수~낙관) · 위버스 = 자사 시트 집계
          </span>
        </div>
        <div class="card overflow-x-auto">
          <table class="w-full min-w-[640px] text-sm">
            <thead>
              <tr class="text-left text-xs text-zinc-500">
                <th class="py-1.5 pr-3 font-normal">지표</th>
                {KPI_MONTHS.map((m) => (
                  <th key={m} class="py-1.5 pr-3 font-normal">
                    {Number(m.slice(5))}월
                    {MONTH_NOTES[m] && (
                      <span class="ml-1 text-[10px] text-amber-300/80"
                            title={MONTH_NOTES[m]}>
                        {MONTH_NOTES[m].slice(0, 1)}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buildKpiTable(props.monthlyKpi).map((row) => (
                <tr key={row.metric} class="border-t border-zinc-800/60">
                  <td class="py-2 pr-3 text-xs text-zinc-400">{KPI_LABEL[row.metric]}</td>
                  {row.cells.map((c) => (
                    <td key={c.month} class="py-2 pr-3 align-top">
                      {c.actual != null && (
                        <div class={"tabular-nums font-semibold "
                          + (c.verdict === "below" ? "text-amber-300"
                            : c.verdict === "above" ? "text-sky-300"
                            : "text-zinc-100")}>
                          {fmt(c.actual)}
                          {c.verdict === "within" && " ✅"}
                          {c.verdict === "below" && " ⚠️"}
                          {c.verdict === "above" && " 🔵"}
                          {c.inProgress && (
                            <span class="ml-1 text-[10px] font-normal text-zinc-500">진행 중</span>
                          )}
                        </div>
                      )}
                      {c.band && (
                        <div class="text-[11px] tabular-nums text-zinc-500">
                          {fmt(c.band[0])}~{fmt(c.band[1])}
                        </div>
                      )}
                      {c.actual == null && !c.band && <span class="text-zinc-600">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* 공식 KPI 2시점 달성률 — 표의 요약 결론. */}
        <div class="mt-2 grid gap-2 md:grid-cols-2">
          {officialProgress(props.monthlyKpi).map((k) => (
            <div key={k.month} class="card">
              <div class="mb-1.5 text-xs font-semibold text-zinc-300">{k.label}</div>
              <div class="space-y-1.5">
                {k.items.map((it) => (
                  <div key={it.metric} class="flex items-center gap-2 text-xs">
                    <span class="w-28 shrink-0 text-zinc-500">{KPI_LABEL[it.metric]}</span>
                    <div class="h-2 flex-1 overflow-hidden rounded-sm bg-zinc-800/60">
                      <div class="h-full bg-[#75d7d1]/70"
                           style={{ width: `${Math.min(it.pct ?? 0, 100)}%` }} />
                    </div>
                    <span class="w-24 shrink-0 text-right tabular-nums text-zinc-400">
                      {it.actual != null ? fmt(it.actual) : "—"} / {fmt(it.target)}
                    </span>
                    <span class="w-10 shrink-0 text-right tabular-nums font-semibold text-zinc-200">
                      {it.pct != null ? `${it.pct}%` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p class="mt-2 text-hint text-zinc-500">
          ◆ = 의사결정 시점(8월 말 굿즈 참여 · 10월 말 제작 스케일) · ★ = 9월 컴백 ·
          ⚠️ 보수선 미달 · ✅ 밴드 내 · 🔵 낙관선 초과 · 당월은 월말 확정 전까지 판정 유보
        </p>
      </section>
```

주의: `bandVerdict` import는 위 JSX에서 직접 안 쓰면 제거(빌드 unused 에러 방지).

- [ ] **Step 3: MiiWANBriefing 배선** — 응답 타입(`monthly_kpi` 관련 interface 근처, `ccv_trend?` 옆)에:

```ts
  monthly_kpi?: MonthlyKpiRow[];
```

(파일 상단에 `import type { MonthlyKpiRow } from "../lib/miiwanKpi";` 추가.)
`<MiiWANPosition>` 호출에 prop 추가:

```tsx
          monthlyKpi={data.monthly_kpi ?? []}
```

- [ ] **Step 4: 빌드·전체 프론트 테스트**

Run: `cd frontend && pnpm exec tsc --noEmit && pnpm vitest run && pnpm build`
Expected: 전부 통과·빌드 성공

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/views/MiiWANPosition.tsx frontend/src/views/MiiWANBriefing.tsx
git commit -m "feat(front): 포지션 탭 '월간 KPI 페이스' 표 + 공식 KPI 달성률"
```

---

### Task 8: 검증 + 시크릿 + PR

**Files:** (코드 변경 없음)

- [ ] **Step 1: 스펙 검증 기준 ② — 7월 값 대조 (시트 실물 파싱)**

```bash
cd /private/tmp/claude-501/-Users-user-SecondBrain/88e7fd89-d2cd-4565-b102-f581c9cb9d94/scratchpad
curl -sL -o wv.csv "https://docs.google.com/spreadsheets/d/1WcA5rCsM38CsnEg_vJpSK2K-wSDKRcx5tDx73C2rMQc/export?format=csv&gid=0"
cd ~/Desktop/idol-sight/worker && uv run python -c "
from idol_sight.collectors.weverse_sheet import parse_sheet_rows
rows = parse_sheet_rows(open('/private/tmp/claude-501/-Users-user-SecondBrain/88e7fd89-d2cd-4565-b102-f581c9cb9d94/scratchpad/wv.csv').read())
jul = [r for r in rows if r['day'].startswith('2026-07')][-1]
print(jul)  # 기대: total_members=6895, digital_membership=69"
```

Expected: 7월 마지막 행 `total_members=6895 · digital_membership=69` (먼슬리 보고와 일치). 구독 28.6K는 agg_summary 기존 데이터라 API 배포 후 화면에서 확인.

- [ ] **Step 2: GitHub secret 등록**

```bash
cd ~/Desktop/idol-sight && gh secret set MIIWAN_WEVERSE_SHEET_ID --body "1WcA5rCsM38CsnEg_vJpSK2K-wSDKRcx5tDx73C2rMQc"
```

- [ ] **Step 3: 전체 테스트 최종 확인**

Run: `cd worker && uv run pytest tests/unit -q && cd ../frontend && pnpm vitest run`
Expected: 전부 passed

- [ ] **Step 4: push + PR 생성**

```bash
git push -u origin feature/miiwan-monthly-kpi-pace
gh pr create --title "포지션 탭 월간 KPI 페이스 표 + weverse-sheet 수집기" --body "..."
```

PR 본문에 명시: **머지 후 수순** ① `migrate` 워크플로 수동 실행(remote) ② `collect-daily` 수동 트리거 또는 `MIIWAN_WEVERSE_SHEET_ID=... uv run python -m idol_sight collect --source weverse-sheet --group miiwan` 1회 실행 ③ 포지션 탭에서 표 렌더·7월 판정 육안 확인.

---

## Self-Review 체크 결과

- **Spec coverage**: 수집(Task 1~4) · API(Task 5) · 프론트(Task 6~7) · 검증 기준 4개(Task 7 Step 4, Task 8) 전부 매핑됨. 국가별 UI 미노출·밴드 상수화·스크래핑 안 함(YAGNI)도 준수.
- **Type consistency**: `MonthlyKpiRow` 필드명(`yt_subscribers`/`avg_ccv`/`weverse_members`/`weverse_membership`)이 API 응답(Task 5 Step 2)·lib(Task 6)·UI(Task 7)에서 동일. `WeverseSheetCollector(sheet_id=...)` 시그니처가 Task 2·3에서 동일.
- **Placeholder scan**: 코드 블록 전부 실 코드. PR 본문 "..."만 실행 시 작성.
