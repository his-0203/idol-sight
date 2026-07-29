# MiiWAN 동시기 성과 증명 섹션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 브리핑 탭의 절대값 코호트 비교를 삭제하고, 데뷔일 정렬(D+N) 기준 "동시기 대비 성과"를 증명하는 보고서형 섹션(`/api/miiwan-cohort` + `MiiWANCohortReport` 컴포넌트)으로 교체한다.

**Architecture:** 데뷔일 정렬 로직을 공유 모듈로 추출해 기존 `/api/debut-curve`와 신규 `/api/miiwan-cohort`가 재사용. 인덱스 정규화·성장배수·순위는 순수 함수 모듈(`cohortReport.ts`)로 분리해 D1 목 없이 단위 테스트. 프론트는 자체 fetch하는 단일 섹션 컴포넌트.

**Tech Stack:** Cloudflare Pages Functions + D1(읽기 전용), Preact 10 + TypeScript, Chart.js 4 (`chart.js/auto`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-29-miiwan-cohort-report-design.md`

## Global Constraints

- 모든 명령은 `frontend/`에서 실행: 테스트 `npm test` (= `vitest run`), 타입 `npm run typecheck`, 빌드 `npm run build`.
- Preact — JSX 속성은 `class=` (className 아님). hooks는 `preact/hooks`에서 import.
- 새 npm 의존성 추가 금지. DB 마이그레이션 금지 (기존 테이블 읽기만).
- **가짜 수치 금지**: D0 기준값이 없거나 0인 (그룹, 지표)는 곡선·순위에서 제외하고 응답 `excluded`에 사유 기록. 프론트는 "—" / "데이터 없음" 표기.
- 순위 산정 코호트 = `myrakl, owis, bdawn, bthd, skinz` (+기준 `miiwan`). `plave`는 reference 전용(순위 불포함, 점선). 서브컬처 그룹(uryael 등) 포함 금지.
- 지표 4종 고정: `yt_subscribers`, `yt_total_views`, `naver_total_news`, `dc_total_posts`.
- 기존 `/api/debut-curve` 응답·동작 불변 (리팩터만).
- 각 태스크 끝에 커밋. 커밋 메시지 끝에:
  `Co-Authored-By: Claude <noreply@anthropic.com>`

---

### Task 1: 데뷔일 정렬 공유 모듈 추출

**Files:**
- Create: `frontend/functions/lib/debutAligned.ts`
- Modify: `frontend/functions/api/debut-curve.ts:87-110` (버킷팅 루프를 공유 모듈 호출로 교체)
- Test: `frontend/tests/functions/lib_debut_aligned.test.ts`

**Interfaces:**
- Produces: `alignByDebut(rows: AlignedInputRow[], from: number, to: number): Record<string, Map<number, AlignedValue>>` — group_key별 {day_offset → 최대값} 맵. Task 3이 소비.
- `AlignedInputRow = { group_key: string; debut_date: string | null; snapshot_at: string; value: number | null; source: string }`
- `AlignedValue = { value: number; source: string }`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// frontend/tests/functions/lib_debut_aligned.test.ts
//
// 데뷔일 정렬 버킷팅 규칙 고정: (group, day_offset)당 MAX 값 유지
// (누적 지표는 단조증가 — 같은 날 backfill/live 혼재 시 큰 값이 신뢰값).
import { describe, expect, it } from "vitest";
import { alignByDebut } from "../../functions/lib/debutAligned";

const row = (over: Partial<Parameters<typeof alignByDebut>[0][number]>) => ({
  group_key: "g", debut_date: "2026-06-16", snapshot_at: "2026-06-16T09:00:00Z",
  value: 1, source: "live", ...over,
});

describe("alignByDebut", () => {
  it("day_offset = 스냅샷 날짜 - 데뷔일 (정수일)", () => {
    const out = alignByDebut([
      row({ snapshot_at: "2026-06-16T01:00:00Z", value: 10 }),
      row({ snapshot_at: "2026-06-26T23:00:00Z", value: 20 }),
    ], 0, 60);
    expect([...out.g.keys()].sort((a, b) => a - b)).toEqual([0, 10]);
    expect(out.g.get(10)).toEqual({ value: 20, source: "live" });
  });

  it("같은 날 여러 스냅샷이면 MAX 값을 유지", () => {
    const out = alignByDebut([
      row({ value: 100, source: "live" }),
      row({ value: 900, source: "backfill_estimate" }),
      row({ value: 500, source: "live" }),
    ], 0, 60);
    expect(out.g.get(0)).toEqual({ value: 900, source: "backfill_estimate" });
  });

  it("debut_date null / value null / 범위 밖 행은 제외", () => {
    const out = alignByDebut([
      row({ group_key: "a", debut_date: null }),
      row({ group_key: "b", value: null }),
      row({ group_key: "c", snapshot_at: "2027-06-16T00:00:00Z" }), // D+365 > to
    ], 0, 60);
    expect(Object.keys(out)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run tests/functions/lib_debut_aligned.test.ts`
Expected: FAIL — "Cannot find module '../../functions/lib/debutAligned'"

- [ ] **Step 3: 공유 모듈 구현**

`debut-curve.ts:92-110`의 루프 로직을 그대로 옮긴다 (offset 계산식·MAX 규칙 동일):

```ts
// frontend/functions/lib/debutAligned.ts
//
// 데뷔일 정렬(day_offset) 버킷팅 — /api/debut-curve 와 /api/miiwan-cohort 공유.
// (group, 정수 day_offset)당 스냅샷 중 MAX 값을 유지한다. 누적 지표
// (구독자·조회수·뉴스 수)는 단조증가라 같은 날 backfill_estimate 행과
// 부분집계 live 행이 공존할 때 큰 쪽이 신뢰할 수 있는 신호다.

export interface AlignedInputRow {
  group_key: string;
  debut_date: string | null;
  snapshot_at: string;
  value: number | null;
  source: string;
}

export interface AlignedValue { value: number; source: string }

export function alignByDebut(
  rows: AlignedInputRow[],
  from: number,
  to: number,
): Record<string, Map<number, AlignedValue>> {
  const byGroup: Record<string, Map<number, AlignedValue>> = {};
  for (const r of rows) {
    if (!r.debut_date || r.value == null) continue;
    const offset = Math.round(
      (Date.parse(r.snapshot_at.slice(0, 10)) - Date.parse(r.debut_date)) / 86_400_000,
    );
    if (offset < from || offset > to) continue;
    const slot = byGroup[r.group_key] ?? new Map<number, AlignedValue>();
    const v = Number(r.value);
    const existing = slot.get(offset);
    if (!existing || v > existing.value) slot.set(offset, { value: v, source: r.source });
    byGroup[r.group_key] = slot;
  }
  return byGroup;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/functions/lib_debut_aligned.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: debut-curve.ts 리팩터 (동작 불변)**

`debut-curve.ts`의 `byGroup` 조립부(:87-110)를 교체한다. 그룹 메타(name/debut_date/group_model)는 rows에서 별도로 수집:

```ts
import { alignByDebut } from "../lib/debutAligned";
// ... onRequestGet 내부, rows 조회 이후:
  const aligned = alignByDebut(rows, from, to);
  const meta: Record<string, { name: string; debut_date: string; group_model: string }> = {};
  for (const r of rows) {
    if (!r.debut_date) continue;
    meta[r.group_key] ??= {
      name: r.name, debut_date: r.debut_date, group_model: r.group_model ?? "corporate",
    };
  }
  const series = Object.entries(aligned).map(([key, points]) => ({
    group_key: key,
    ...meta[key]!,
    points: [...points.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, p]) => ({ day_offset: day, value: p.value, source: p.source })),
  }));
```

기존 `byGroup` 선언·for 루프·기존 series 조립은 삭제. 파일 상단 주석의 MAX 규칙 설명(:75-86)은 공유 모듈로 옮겨졌으므로 한 줄 참조로 축약: `// (group, day) MAX 버킷팅 규칙은 ../lib/debutAligned.ts 참조.`

- [ ] **Step 6: 전체 테스트·타입 확인**

Run: `cd frontend && npm test && npm run typecheck`
Expected: 전부 PASS (기존 테스트 회귀 없음)

- [ ] **Step 7: 커밋**

```bash
git add frontend/functions/lib/debutAligned.ts frontend/functions/api/debut-curve.ts frontend/tests/functions/lib_debut_aligned.test.ts
git commit -m "refactor: extract debut-aligned bucketing into shared lib"
```

---

### Task 2: 순수 계산 모듈 (인덱스·성장배수·순위)

**Files:**
- Create: `frontend/functions/lib/cohortReport.ts`
- Test: `frontend/tests/functions/lib_cohort_report.test.ts`

**Interfaces:**
- Consumes: `AlignedValue` 맵 (Task 1의 `Map<number, AlignedValue>`)
- Produces (Task 3이 소비):
  - `type CurvePoint = { day: number; index: number; source: string }`
  - `baseValueAt(points: Map<number, AlignedValue>, targetDay: number, window: number): { day: number; value: number; source: string } | null` — targetDay에 가장 가까운(|Δ|≤window) 점. 동률이면 이른 날짜 우선.
  - `indexCurve(points: Map<number, AlignedValue>, asOfDay: number): CurvePoint[] | null` — D0 기준값=100 정규화, day 0..asOfDay. 기준값 없음/0이면 null.
  - `growthMultiple(points: Map<number, AlignedValue>, asOfDay: number): number | null` — D+asOfDay값 / D0값.
  - `rankOf(mine: number, others: number[]): number` — 내림차순 1-based 순위 (동률은 같은 순위 아님, mine보다 큰 값 개수+1).

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// frontend/tests/functions/lib_cohort_report.test.ts
//
// 투자사 보고에 들어가는 수치라 계산 규칙을 테스트로 고정한다:
// 인덱스 = D0 기준값 100 정규화, 성장배수 = D+N/D0, 순위 = 내림차순.
import { describe, expect, it } from "vitest";
import {
  baseValueAt, indexCurve, growthMultiple, rankOf,
} from "../../functions/lib/cohortReport";

const pts = (entries: Array<[number, number, string?]>) =>
  new Map(entries.map(([d, v, s]) => [d, { value: v, source: s ?? "live" }]));

describe("baseValueAt", () => {
  it("targetDay 정확 일치 우선, 없으면 윈도 내 최근접(동률은 이른 날)", () => {
    expect(baseValueAt(pts([[0, 10]]), 0, 3)).toEqual({ day: 0, value: 10, source: "live" });
    expect(baseValueAt(pts([[-2, 5], [2, 7]]), 0, 3)!.day).toBe(-2); // |−2|=|2| → 이른 날
    expect(baseValueAt(pts([[5, 9]]), 0, 3)).toBeNull(); // 윈도 밖
  });
});

describe("indexCurve", () => {
  it("D0=100 정규화, day 0..asOfDay만 포함", () => {
    const out = indexCurve(pts([[-5, 999], [0, 200], [10, 300], [43, 500], [60, 900]]), 43)!;
    expect(out[0]).toEqual({ day: 0, index: 100, source: "live" });
    expect(out.find((p) => p.day === 10)!.index).toBe(150);
    expect(out.find((p) => p.day === 43)!.index).toBe(250);
    expect(out.some((p) => p.day < 0 || p.day > 43)).toBe(false);
  });
  it("D0 기준값 없음/0이면 null (가짜 수치 생성 금지)", () => {
    expect(indexCurve(pts([[20, 300]]), 43)).toBeNull();
    expect(indexCurve(pts([[0, 0], [10, 5]]), 43)).toBeNull();
  });
});

describe("growthMultiple", () => {
  it("D+asOfDay 최근접값 / D0 기준값", () => {
    expect(growthMultiple(pts([[0, 100], [42, 350]]), 43)).toBeCloseTo(3.5);
  });
  it("기준 또는 도달값 없으면 null", () => {
    expect(growthMultiple(pts([[0, 100]]), 43)).toBeNull(); // D+43 근방 없음
    expect(growthMultiple(pts([[43, 100]]), 43)).toBeNull(); // D0 없음
  });
});

describe("rankOf", () => {
  it("내림차순 1-based: 나보다 큰 값 개수 + 1", () => {
    expect(rankOf(3.5, [1.2, 5.0, 2.0])).toBe(2);
    expect(rankOf(9, [1, 2])).toBe(1);
    expect(rankOf(1, [2, 3, 4])).toBe(4);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run tests/functions/lib_cohort_report.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```ts
// frontend/functions/lib/cohortReport.ts
//
// /api/miiwan-cohort 의 순수 계산부. D1 목 없이 단위 테스트하기 위해
// 분리 — 투자사 보고 수치라 규칙이 테스트로 고정돼야 한다.
import type { AlignedValue } from "./debutAligned";

export interface CurvePoint { day: number; index: number; source: string }
export interface BasePoint { day: number; value: number; source: string }

// D-DAY 기준값 탐색 폭. 데뷔 주간 스냅샷 공백(수집 시작 지연·백필 간격)을
// 흡수하되, D+한참 뒤 값을 기준으로 오인하지 않는 절충.
export const BASE_WINDOW = 3;
// 스코어카드 "같은 D+N" 도달값 탐색 폭.
export const AT_DAY_WINDOW = 7;

export function baseValueAt(
  points: Map<number, AlignedValue>,
  targetDay: number,
  window: number,
): BasePoint | null {
  let best: BasePoint | null = null;
  let bestDist = Infinity;
  for (const [day, p] of points) {
    const dist = Math.abs(day - targetDay);
    if (dist > window) continue;
    if (dist < bestDist || (dist === bestDist && best !== null && day < best.day)) {
      best = { day, value: p.value, source: p.source };
      bestDist = dist;
    }
  }
  return best;
}

export function indexCurve(
  points: Map<number, AlignedValue>,
  asOfDay: number,
): CurvePoint[] | null {
  const base = baseValueAt(points, 0, BASE_WINDOW);
  if (!base || base.value <= 0) return null;
  const out: CurvePoint[] = [];
  for (const [day, p] of points) {
    if (day < 0 || day > asOfDay) continue;
    out.push({
      day,
      index: Math.round((p.value / base.value) * 1000) / 10, // 소수 1자리
      source: p.source,
    });
  }
  // 기준점이 day<0 스냅샷이면 day 0 인덱스 100 점이 없을 수 있음 — 항상 시작점 보장.
  if (!out.some((p) => p.day === Math.max(base.day, 0))) {
    out.push({ day: Math.max(base.day, 0), index: 100, source: base.source });
  }
  out.sort((a, b) => a.day - b.day);
  return out;
}

export function growthMultiple(
  points: Map<number, AlignedValue>,
  asOfDay: number,
): number | null {
  const base = baseValueAt(points, 0, BASE_WINDOW);
  const at = baseValueAt(points, asOfDay, AT_DAY_WINDOW);
  if (!base || base.value <= 0 || !at) return null;
  return at.value / base.value;
}

export function rankOf(mine: number, others: number[]): number {
  return others.filter((v) => v > mine).length + 1;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/functions/lib_cohort_report.test.ts`
Expected: PASS. `indexCurve`의 시작점 보장 규칙 때문에 첫 테스트가 실패하면 테스트가 아니라 구현 쪽 정렬·중복 방지를 점검할 것 (day 0 점이 이미 있으면 추가하지 않음).

- [ ] **Step 5: 커밋**

```bash
git add frontend/functions/lib/cohortReport.ts frontend/tests/functions/lib_cohort_report.test.ts
git commit -m "feat: cohort report pure calc (index curve, growth multiple, rank)"
```

---

### Task 3: `GET /api/miiwan-cohort` 엔드포인트

**Files:**
- Create: `frontend/functions/api/miiwan-cohort.ts`
- Test: `frontend/tests/functions/api_miiwan_cohort.test.ts`

**Interfaces:**
- Consumes: `alignByDebut` (Task 1), `indexCurve`/`growthMultiple`/`rankOf`/`baseValueAt`/`AT_DAY_WINDOW` (Task 2), `d1Query`(`../lib/d1`), `jsonResponse`(`../lib/jsonResponse`), `debutAgeDaysKST`(`../lib/debutWindowBuckets`).
- Produces (Task 5 프론트가 소비하는 응답 계약):

```ts
{
  as_of_day: number,                       // 미완이 오늘 기준 D+N (KST)
  metrics: string[],                       // 4종 고정 순서
  groups: Record<string, { name: string; debut_date: string | null; reference: boolean }>,
  curves: Record<string, Record<string, Array<{ day: number; index: number; source: string }>>>,
    // curves[metric][group_key] — miiwan·코호트·plave 모두 포함(있는 것만)
  scorecard: Record<string, {
    rows: Array<{ group_key: string; value_at_day: number | null;
                  growth_multiple: number | null; source: string | null;
                  reference: boolean }>,
    miiwan_rank: number | null,            // growth_multiple 내림차순, reference 제외
    cohort_size: number,                   // 순위 모수(growth 비-null인 비참조 그룹 수)
  }>,
  organicity: Array<{ group_key: string; score: number | null;
                      video_count: number; reference: boolean }>,
  excluded: Array<{ group_key: string; metric: string; reason: string }>,
}
```

- [ ] **Step 1: 실패하는 테스트 작성**

D1 목은 `api_miiwan_decision.test.ts`의 `envWith` 패턴(SQL 부분일치 분기)을 따른다:

```ts
// frontend/tests/functions/api_miiwan_cohort.test.ts
//
// /api/miiwan-cohort 계약 고정: 데뷔일 정렬 인덱스 곡선·스코어카드 순위에서
// plave(reference)가 순위 모수에 안 들어가는 것, D0 결측 그룹의 excluded
// 처리, 응답 형태. (라이브는 HMAC 게이트 — 이 레이어에서 검증.)
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/miiwan-cohort";

const envWith = (handler: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: handler(sql) })),
    first: vi.fn(async () => handler(sql)[0] ?? null),
  })) },
} as any);

const req = () => ({ request: new Request("https://x/api/miiwan-cohort") });

// 데뷔 30일 뒤 시점을 흉내내려면 miiwan debut_date를 오늘-30일로 만든다
// (엔드포인트가 오늘 기준 as_of_day를 동적 계산하므로 테스트도 상대 날짜 사용).
const iso = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const GROUPS = (miiwanDebutDaysAgo = 30) => [
  { key: "miiwan", name: "MiiWAN", debut_date: iso(miiwanDebutDaysAgo) },
  { key: "myrakl", name: "MYRAKL", debut_date: iso(200) },
  { key: "plave",  name: "PLAVE",  debut_date: iso(1200) },
];

// agg_summary 행: 그룹별 D0·D+30 두 스냅샷 (miiwan 2배, myrakl 3배 성장).
const summaryRows = () => {
  const mk = (gk: string, debutDaysAgo: number, d0: number, d30: number) => [
    { group_key: gk, debut_date: iso(debutDaysAgo),
      snapshot_at: iso(debutDaysAgo) + "T09:00:00Z",
      yt_subscribers: d0, yt_total_views: d0 * 100,
      naver_total_news: 10, dc_total_posts: 5, data_source: "live" },
    { group_key: gk, debut_date: iso(debutDaysAgo),
      snapshot_at: iso(debutDaysAgo - 30) + "T09:00:00Z",
      yt_subscribers: d30, yt_total_views: d30 * 100,
      naver_total_news: 20, dc_total_posts: 9, data_source: "live" },
  ];
  return [...mk("miiwan", 30, 1000, 2000), ...mk("myrakl", 200, 5000, 15000)];
};

async function call(handler: (sql: string) => any[]) {
  const res = await onRequestGet({ env: envWith(handler), ...req() } as any);
  expect(res.status).toBe(200);
  return await res.json() as any;
}

describe("/api/miiwan-cohort", () => {
  const baseHandler = (sql: string): any[] => {
    if (sql.includes("FROM groups")) return GROUPS();
    if (sql.includes("FROM agg_summary")) return summaryRows();
    if (sql.includes("debut_window_organicity_summary")) return [
      { group_key: "miiwan", organic_score_mean: 80, scored_video_count: 10 },
      { group_key: "myrakl", organic_score_mean: 60, scored_video_count: 20 },
    ];
    return [];
  };

  it("as_of_day = 미완이 데뷔 경과일, 곡선은 D0=100 인덱스", async () => {
    const body = await call(baseHandler);
    expect(body.as_of_day).toBeGreaterThanOrEqual(29);
    expect(body.as_of_day).toBeLessThanOrEqual(31);
    const mi = body.curves.yt_subscribers.miiwan;
    expect(mi[0].index).toBe(100);
    expect(mi[mi.length - 1].index).toBe(200); // 1000→2000 = 2배
  });

  it("plave는 reference=true, 순위 모수 제외", async () => {
    const body = await call(baseHandler);
    expect(body.groups.plave.reference).toBe(true);
    const sc = body.scorecard.yt_subscribers;
    // miiwan 2.0배 vs myrakl 3.0배 → miiwan 2위 / 모수 2 (plave 미포함)
    expect(sc.miiwan_rank).toBe(2);
    expect(sc.cohort_size).toBe(2);
    const plaveRow = sc.rows.find((r: any) => r.group_key === "plave");
    expect(plaveRow?.reference).toBe(true);
  });

  it("D0 결측 그룹은 곡선 제외 + excluded 기록 (가짜 수치 없음)", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      // myrakl은 D+150 스냅샷만 → D0 기준값 없음
      if (sql.includes("FROM agg_summary")) return [
        ...summaryRows().filter((r) => r.group_key === "miiwan"),
        { group_key: "myrakl", debut_date: iso(200),
          snapshot_at: iso(50) + "T09:00:00Z",
          yt_subscribers: 9999, yt_total_views: 1, naver_total_news: 1,
          dc_total_posts: 1, data_source: "backfill_estimate" },
      ];
      return [];
    });
    expect(body.curves.yt_subscribers.myrakl).toBeUndefined();
    expect(body.excluded.some((e: any) =>
      e.group_key === "myrakl" && e.metric === "yt_subscribers")).toBe(true);
  });

  it("miiwan debut_date 없으면 503-급 에러 대신 명시적 4xx", async () => {
    const res = await onRequestGet({
      env: envWith((sql) =>
        sql.includes("FROM groups")
          ? [{ key: "miiwan", name: "MiiWAN", debut_date: null }] : []),
      ...req(),
    } as any);
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && npx vitest run tests/functions/api_miiwan_cohort.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 엔드포인트 구현**

```ts
// frontend/functions/api/miiwan-cohort.ts
//
// 동시기(데뷔일 정렬) 코호트 성과 — 투자사 보고용 "왜 잘되는가" 근거 데이터.
// 절대값 비교가 아니라 각 그룹의 D0을 원점으로 정렬한 인덱스 성장(D0=100)·
// 성장배수·순위를 반환한다. 규칙: 가짜 수치 없음 — D0 기준값이 없는
// (그룹,지표)는 excluded로 명시하고 순위 모수에서 뺀다.
//
// plave는 성공 사례 참조선(reference) — 체급이 달라 순위에 섞으면
// 미완이 배지가 무의미해지므로 곡선·표에는 나오되 순위 모수에서 제외.
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";
import { debutAgeDaysKST } from "../lib/debutWindowBuckets";
import { alignByDebut, type AlignedValue } from "../lib/debutAligned";
import {
  AT_DAY_WINDOW, baseValueAt, growthMultiple, indexCurve, rankOf,
} from "../lib/cohortReport";

const TARGET = "miiwan";
const COHORT = ["myrakl", "owis", "bdawn", "bthd", "skinz"] as const;
const REFERENCE = ["plave"] as const;
const ALL_KEYS = [TARGET, ...COHORT, ...REFERENCE];
const METRICS = [
  "yt_subscribers", "yt_total_views", "naver_total_news", "dc_total_posts",
] as const;
// 유기성: 동시기 = D-Day(−10..9)·D+20(10..29)·D+40(30..49)·D+60(50..69) 버킷
// (debutWindowBuckets 라벨 체계) — 데뷔 직후 ~70일 창.
const ORGANICITY_BUCKETS = ["D-Day", "D+20", "D+40", "D+60"];

interface GroupRow { key: string; name: string; debut_date: string | null }
interface SummaryRow {
  group_key: string; debut_date: string | null; snapshot_at: string;
  yt_subscribers: number | null; yt_total_views: number | null;
  naver_total_news: number | null; dc_total_posts: number | null;
  data_source: string;
}
interface OrgRow {
  group_key: string; organic_score_mean: number | null; scored_video_count: number;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const ph = ALL_KEYS.map(() => "?").join(",");
  const groups = await d1Query<GroupRow>(
    env.DB,
    `SELECT key, name, debut_date FROM groups WHERE key IN (${ph})`,
    ALL_KEYS,
  );
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const miiwan = byKey.get(TARGET);
  if (!miiwan?.debut_date) {
    return jsonResponse({ error: "miiwan_debut_date_missing" }, 409);
  }
  const rawAge = debutAgeDaysKST(miiwan.debut_date, new Date());
  const asOfDay = Number.isFinite(rawAge) ? Math.max(0, rawAge) : 0;

  // 한 방 쿼리: 대상 그룹 × 4지표. 정렬 범위는 D-7(기준값 탐색 여유)~D+asOf+7.
  const from = -7;
  const to = asOfDay + AT_DAY_WINDOW;
  const rows = await d1Query<SummaryRow>(
    env.DB,
    `SELECT s.group_key, g.debut_date, s.snapshot_at,
            s.yt_subscribers, s.yt_total_views, s.naver_total_news,
            s.dc_total_posts, s.data_source
       FROM agg_summary s
       JOIN groups g ON g.key = s.group_key
      WHERE s.group_key IN (${ph})
        AND g.debut_date IS NOT NULL
        AND CAST(julianday(date(s.snapshot_at)) - julianday(g.debut_date) AS INTEGER)
            BETWEEN ? AND ?`,
    [...ALL_KEYS, from, to],
  );

  const isRef = (gk: string) => (REFERENCE as readonly string[]).includes(gk);
  const curves: Record<string, Record<string, ReturnType<typeof indexCurve>>> = {};
  const scorecard: Record<string, unknown> = {};
  const excluded: Array<{ group_key: string; metric: string; reason: string }> = [];

  for (const metric of METRICS) {
    const aligned = alignByDebut(
      rows.map((r) => ({
        group_key: r.group_key, debut_date: r.debut_date,
        snapshot_at: r.snapshot_at,
        value: r[metric], source: r.data_source,
      })),
      from, to,
    );
    const metricCurves: Record<string, NonNullable<ReturnType<typeof indexCurve>>> = {};
    const scRows: Array<{
      group_key: string; value_at_day: number | null;
      growth_multiple: number | null; source: string | null; reference: boolean;
    }> = [];
    for (const gk of ALL_KEYS) {
      const pts = aligned[gk];
      const g = byKey.get(gk);
      if (!pts || !g?.debut_date) {
        excluded.push({ group_key: gk, metric, reason: "no_data_in_window" });
        continue;
      }
      const curve = indexCurve(pts, asOfDay);
      if (curve) metricCurves[gk] = curve;
      else excluded.push({ group_key: gk, metric, reason: "no_d0_baseline" });
      const at = baseValueAt(pts, asOfDay, AT_DAY_WINDOW);
      scRows.push({
        group_key: gk,
        value_at_day: at?.value ?? null,
        growth_multiple: growthMultiple(pts, asOfDay),
        source: at?.source ?? null,
        reference: isRef(gk),
      });
    }
    const mine = scRows.find((r) => r.group_key === TARGET)?.growth_multiple ?? null;
    const peers = scRows.filter(
      (r) => r.group_key !== TARGET && !r.reference && r.growth_multiple != null,
    ).map((r) => r.growth_multiple!) ;
    scorecard[metric] = {
      rows: scRows,
      miiwan_rank: mine == null ? null : rankOf(mine, peers),
      cohort_size: mine == null ? peers.length : peers.length + 1,
    };
    curves[metric] = metricCurves as never;
  }

  // 동시기 유기성 — scored_video_count 가중 평균.
  const orgPh = ORGANICITY_BUCKETS.map(() => "?").join(",");
  const orgRows = await d1Query<OrgRow>(
    env.DB,
    `SELECT group_key, organic_score_mean, scored_video_count
       FROM debut_window_organicity_summary
      WHERE group_key IN (${ph}) AND window_bucket IN (${orgPh})`,
    [...ALL_KEYS, ...ORGANICITY_BUCKETS],
  ).catch(() => [] as OrgRow[]);
  const orgAgg = new Map<string, { wsum: number; n: number }>();
  for (const r of orgRows) {
    if (r.organic_score_mean == null || !r.scored_video_count) continue;
    const a = orgAgg.get(r.group_key) ?? { wsum: 0, n: 0 };
    a.wsum += r.organic_score_mean * r.scored_video_count;
    a.n += r.scored_video_count;
    orgAgg.set(r.group_key, a);
  }
  const organicity = ALL_KEYS.filter((gk) => byKey.has(gk)).map((gk) => {
    const a = orgAgg.get(gk);
    return {
      group_key: gk,
      score: a && a.n > 0 ? Math.round((a.wsum / a.n) * 10) / 10 : null,
      video_count: a?.n ?? 0,
      reference: isRef(gk),
    };
  });

  const groupsOut: Record<string, { name: string; debut_date: string | null; reference: boolean }> = {};
  for (const g of groups) {
    groupsOut[g.key] = { name: g.name, debut_date: g.debut_date, reference: isRef(g.key) };
  }

  return jsonResponse({
    as_of_day: asOfDay,
    metrics: [...METRICS],
    groups: groupsOut,
    curves,
    scorecard,
    organicity,
    excluded,
  });
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd frontend && npx vitest run tests/functions/api_miiwan_cohort.test.ts`
Expected: PASS (4 tests). `debutAgeDaysKST` 시그니처가 다르면(`(debut: string, now: Date)` 가정) `functions/lib/debutWindowBuckets.ts`의 실제 시그니처에 맞춰 호출부를 수정할 것 — 테스트를 바꾸지 말 것.

- [ ] **Step 5: 전체 테스트 확인 후 커밋**

Run: `cd frontend && npm test && npm run typecheck`
Expected: 전부 PASS

```bash
git add frontend/functions/api/miiwan-cohort.ts frontend/tests/functions/api_miiwan_cohort.test.ts
git commit -m "feat: /api/miiwan-cohort debut-aligned cohort report endpoint"
```

---

### Task 4: 기존 벤치마크 코드 삭제 (백엔드 + 프론트)

**Files:**
- Modify: `frontend/functions/api/miiwan.ts` — `BENCHMARK_GROUPS`(:84 부근)와 그 위 설명 주석 블록(:40-83), 앵커 벤치마크 블록(:348-489), 응답의 `benchmarks_by_anchor` 키 삭제
- Modify: `frontend/src/views/MiiWANBriefing.tsx` — 코호트 비교 섹션(:552-667)과 전용 코드 삭제
- Modify: `frontend/src/api.ts` — `miiwanCohort` 추가
- Test: 기존 `frontend/tests/functions/api_miiwan_*.test.ts` 회귀 확인 (신규 테스트 없음)

**Interfaces:**
- Produces: `api.miiwanCohort(): Promise<any>` — Task 5가 소비.
- 삭제로 사라지는 것: `MiiwanData.benchmarks_by_anchor`, `type Benchmark`, `type AnchorKey`, `ANCHOR_TABS`, `anchorTab` state, `relativeRatio`, `fmtBench`, `PLACEHOLDER_ZERO_KEYS`. **`EstBadge`는 삭제하지 말고 export로 변경** — Task 5가 import한다.

- [ ] **Step 1: 백엔드 삭제**

`frontend/functions/api/miiwan.ts`에서:
1. `BENCHMARK_GROUPS` 상수(:84-86)와 그 위 벤치마크 사다리 설명 주석 블록(:40-83, `// 5) Cohort benchmarks...` 문단 포함) 삭제.
2. 앵커 블록 전체 삭제 — `type AnchorKey`(:365)부터 `benchmarksByAnchor[t.anchor].push(...)` 루프 끝(:489)까지 (`ANCHORS`, `BenchmarkRow`, `benchmarksByAnchor`, `anchorQuery`, `anchorTasks`, `benchGroups`, `benchByKey` 포함).
3. 응답 객체에서 `benchmarks_by_anchor` 키 제거.
4. 삭제 후 이 파일에서만 쓰이던 import/타입이 미사용이 되면(`GroupRow`가 다른 곳에서도 쓰이는지 확인) 함께 정리. `SummaryRow`는 요약 조회에 계속 쓰이므로 유지.

- [ ] **Step 2: 프론트 삭제 + api 추가**

`frontend/src/views/MiiWANBriefing.tsx`에서:
1. 섹션 `{/* 5) COHORT POSITION ... */}` `<section>`(:552-667) 전체 삭제. 자리에 임시 placeholder를 남기지 말 것 — Task 5가 새 섹션을 같은 위치에 넣는다.
2. `type Benchmark`(:49-54), `type AnchorKey`·`ANCHOR_TABS`(:56-80), `MiiwanData.benchmarks_by_anchor` 필드(:115), `anchorTab` state(:354-357), `relativeRatio`(:306-311), `PLACEHOLDER_ZERO_KEYS`(:327-334), `fmtBench`(:336-346) 삭제.
3. `EstBadge`(:313-325)는 유지하되 `export function EstBadge`로 변경 (Task 5에서 import).
4. 유기성 섹션 안내문(:676-678)의 `위 표의 조회·구독` → `동시기 스코어카드의 조회·구독`으로 수정.

`frontend/src/api.ts`의 `miiwanLiveChat` 아래에 추가:

```ts
  miiwanCohort: () => getJson<any>("/api/miiwan-cohort"),
```

- [ ] **Step 3: 회귀 확인**

Run: `cd frontend && npm test && npm run typecheck`
Expected: 전부 PASS. `api_miiwan_*.test.ts`의 D1 목 `baseHandler`에 벤치마크 분기(`key IN`)가 남아 있어도 무해(미호출)하니 그대로 둔다. `benchmarks_by_anchor`를 assert하는 테스트가 있으면 해당 assert만 삭제.

- [ ] **Step 4: 커밋**

```bash
git add frontend/functions/api/miiwan.ts frontend/src/views/MiiWANBriefing.tsx frontend/src/api.ts
git commit -m "refactor: remove anchor benchmark cohort table (superseded by /api/miiwan-cohort)"
```

---

### Task 5: 신규 프론트 섹션 — MiiWANCohortReport

**Files:**
- Create: `frontend/src/components/MiiWANCohortReport.tsx`
- Modify: `frontend/src/views/MiiWANBriefing.tsx` — Task 4에서 비운 자리(KPI 섹션과 유기성 섹션 사이)에 새 섹션 삽입
- Test: `npm run typecheck` + `npm run build` + 기존 테스트 회귀 (컴포넌트 테스트 관례 없음)

**Interfaces:**
- Consumes: `api.miiwanCohort()` (Task 4), Task 3 응답 계약, `EstBadge`(`../views/MiiWANBriefing`), `colorOf`(`../design/groups`), `fmt`(`../format`), `fmtScale`(`../design/chart-defaults`), `EmptyState`(기존 컴포넌트 — import 경로는 `MiiWANBriefing.tsx` 상단에서 확인해 동일하게).
- Produces: `export function MiiWANCohortReport(): JSX` — 인자 없음, 자체 fetch.

- [ ] **Step 1: 컴포넌트 구현**

디자인 관례: 카드 `class="card"`, pill 탭 `role="tablist"` 패턴(MiiWANBriefing:563-579와 동일), 힌트 `text-hint text-zinc-500`, 수치 `tabular-nums`, 미완이 강조색 `colorOf("miiwan")`(#75d7d1). 차트는 `DebutCurve.tsx` 패턴(canvas ref + `useEffect` Chart 인스턴스, `interaction.mode='index'`, `intersect:false`).

```tsx
// frontend/src/components/MiiWANCohortReport.tsx
//
// 동시기 성과 — 데뷔 코호트 벤치마크 (투자사 보고 서사).
// 구조: ① 결론 헤드라인(스코어카드에서 자동 산출, 하드코딩 금지)
//      ② 인덱스 성장곡선(D0=100) ③ 스코어카드 표 ④ 동시기 유기성
//      ⑤ 방법론 각주. 열세 지표도 숨기지 않는다 — 가짜 없는 보고가 전제.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { colorOf } from "../design/groups";
import { EmptyState } from "./EmptyState"; // 실제 경로는 MiiWANBriefing.tsx의 import를 따를 것
import { EstBadge } from "../views/MiiWANBriefing";

type CurvePoint = { day: number; index: number; source: string };
type ScRow = {
  group_key: string; value_at_day: number | null;
  growth_multiple: number | null; source: string | null; reference: boolean;
};
type CohortData = {
  as_of_day: number;
  metrics: string[];
  groups: Record<string, { name: string; debut_date: string | null; reference: boolean }>;
  curves: Record<string, Record<string, CurvePoint[]>>;
  scorecard: Record<string, { rows: ScRow[]; miiwan_rank: number | null; cohort_size: number }>;
  organicity: Array<{ group_key: string; score: number | null; video_count: number; reference: boolean }>;
  excluded: Array<{ group_key: string; metric: string; reason: string }>;
};

const METRIC_LABELS: Record<string, string> = {
  yt_subscribers: "구독자",
  yt_total_views: "누적 조회수",
  naver_total_news: "뉴스 노출",
  dc_total_posts: "커뮤니티 활동",
};

const accent = colorOf("miiwan");

function fmtMultiple(m: number | null): string {
  return m == null ? "—" : `${(Math.round(m * 10) / 10).toFixed(1)}×`;
}

// 헤드라인: 지표별 순위를 우세(상위 절반)/열세로 나눠 한 줄 결론 생성.
function headline(d: CohortData): { lead: string; trail: string | null } {
  const parts: string[] = [];
  const weak: string[] = [];
  for (const m of d.metrics) {
    const sc = d.scorecard[m];
    if (!sc || sc.miiwan_rank == null || sc.cohort_size < 2) continue;
    const label = METRIC_LABELS[m] ?? m;
    const mine = sc.rows.find((r) => r.group_key === "miiwan");
    const txt = `${label} 성장 ${fmtMultiple(mine?.growth_multiple ?? null)} (동시기 ${sc.cohort_size}팀 중 ${sc.miiwan_rank}위)`;
    if (sc.miiwan_rank <= Math.ceil(sc.cohort_size / 2)) parts.push(txt);
    else weak.push(txt);
  }
  return {
    lead: parts.length
      ? `데뷔 D+${d.as_of_day} 기준, ${parts.join(" · ")}`
      : `데뷔 D+${d.as_of_day} 기준 동시기 비교`,
    trail: weak.length ? `보완 지표: ${weak.join(" · ")}` : null,
  };
}

export function MiiWANCohortReport() {
  const [data, setData] = useState<CohortData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<string>("yt_subscribers");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    api.miiwanCohort().then(setData).catch((e) => setErr(String(e)));
  }, []);

  const curves = data?.curves?.[metric] ?? {};

  useEffect(() => {
    if (!canvasRef.current || !data) return;
    chartRef.current?.destroy();
    const entries = Object.entries(curves)
      // 미완이 라인이 항상 마지막(최상단)에 그려지게 정렬
      .sort(([a], [b]) => (a === "miiwan" ? 1 : b === "miiwan" ? -1 : 0));
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        datasets: entries.map(([gk, pts]) => {
          const ref = data.groups[gk]?.reference;
          const isMine = gk === "miiwan";
          return {
            label: data.groups[gk]?.name ?? gk,
            data: pts.map((p) => ({ x: p.day, y: p.index })),
            borderColor: colorOf(gk),
            backgroundColor: colorOf(gk),
            borderWidth: isMine ? 3 : 1.5,
            borderDash: ref ? [6, 4] : undefined,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.25,
          };
        }),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { type: "linear", title: { display: true, text: "데뷔 후 경과일 (D+N)" },
               ticks: { callback: (v) => `D+${v}` } },
          y: { title: { display: true, text: "인덱스 (D-Day = 100)" } },
        },
        plugins: {
          tooltip: { callbacks: {
            title: (items) => `D+${items[0]?.parsed.x}`,
            label: (item) => `${item.dataset.label}: ${item.parsed.y}`,
          } },
        },
      },
    });
    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [data, metric]);

  if (err) return <EmptyState title="동시기 비교 로드 실패" hint={err} icon="⚠️" />;
  if (!data) return <EmptyState title="불러오는 중…" hint="" icon="⏳" />;

  const sc = data.scorecard[metric];
  const head = useMemo(() => headline(data), [data]);
  const orgRows = data.organicity.filter((o) => o.score != null);
  const miiwanOrg = orgRows.find((o) => o.group_key === "miiwan");

  return (
    <div class="space-y-4">
      {/* ① 결론 헤드라인 — 스코어카드 자동 산출 */}
      <div class="card border-l-4" style={{ borderLeftColor: accent }}>
        <p class="font-semibold text-zinc-100">{head.lead}</p>
        {head.trail && <p class="mt-1 text-hint text-zinc-400">{head.trail}</p>}
        <p class="mt-1 text-hint text-zinc-500">
          절대 규모가 아니라 <strong class="text-zinc-300">같은 데뷔 경과 시점(D+{data.as_of_day})의
          성장 기울기</strong>로 비교 — 각 그룹의 데뷔일을 0일로 정렬한 값.
        </p>
      </div>

      {/* ② 인덱스 성장곡선 + 지표 pill 탭 */}
      <div>
        <div role="tablist" aria-label="cohort metric"
             class="mb-3 flex overflow-x-auto gap-1 card p-1">
          {data.metrics.map((m) => {
            const active = m === metric;
            return (
              <button key={m} role="tab" aria-selected={active}
                      class={"flex-1 min-w-[80px] rounded-md px-3 py-1.5 text-sm font-medium transition "
                        + (active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")}
                      style={active ? { color: accent } : undefined}
                      onClick={() => setMetric(m)}>
                {METRIC_LABELS[m] ?? m}
              </button>
            );
          })}
        </div>
        {Object.keys(curves).length === 0 ? (
          <EmptyState title="이 지표의 곡선 데이터 부족"
                      hint="D-Day 기준값이 축적되면 자동으로 채워집니다." icon="📈" />
        ) : (
          <div class="card" style={{ height: "320px" }}>
            <canvas ref={canvasRef} />
          </div>
        )}
      </div>

      {/* ③ 동시기 스코어카드 */}
      {sc && (
        <div class="overflow-x-auto rounded-lg border border-zinc-800">
          <table class="w-full min-w-[560px] text-sm tabular-nums">
            <thead class="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th class="px-3 py-2 text-left">그룹</th>
                <th class="px-3 py-2 text-right">D+{data.as_of_day} 시점 값</th>
                <th class="px-3 py-2 text-right">성장배수 (D-Day 대비)</th>
              </tr>
            </thead>
            <tbody>
              {[...sc.rows]
                .sort((a, b) => (b.growth_multiple ?? -1) - (a.growth_multiple ?? -1))
                .map((r) => {
                  const isMine = r.group_key === "miiwan";
                  return (
                    <tr key={r.group_key}
                        class={"border-t border-zinc-800/60" + (isMine ? " bg-zinc-800/40" : "")}>
                      <td class="px-3 py-2" style={{ color: colorOf(r.group_key) }}>
                        {data.groups[r.group_key]?.name ?? r.group_key}
                        {r.reference && <span class="ml-1 text-hint text-zinc-500">참조</span>}
                      </td>
                      <td class="px-3 py-2 text-right text-zinc-300">
                        {r.value_at_day == null ? "—" : fmt(r.value_at_day)}
                        <EstBadge source={r.source} />
                      </td>
                      <td class={"px-3 py-2 text-right " + (isMine ? "font-semibold" : "text-zinc-300")}
                          style={isMine ? { color: accent } : undefined}>
                        {fmtMultiple(r.growth_multiple)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          {sc.miiwan_rank != null && (
            <p class="px-3 py-2 text-hint text-zinc-500 border-t border-zinc-800/60">
              성장배수 기준 동시기 {sc.cohort_size}팀 중 <strong style={{ color: accent }}>
              MiiWAN {sc.miiwan_rank}위</strong> (참조 그룹 제외).
            </p>
          )}
        </div>
      )}

      {/* ④ 동시기 유기성 — 데뷔 창(D-Day~D+60 버킷) 한정. 아래 '코호트
          유기성 비교'(롤링 창)와 기준이 다름을 명시. */}
      {orgRows.length > 0 && (
        <div class="card">
          <p class="mb-2 text-sm font-medium text-zinc-200">
            동시기 유기성 (각 그룹의 데뷔 창 D-Day~D+60 기준)
            {miiwanOrg?.score != null && (
              <span class="ml-2 text-hint text-zinc-500">MiiWAN {miiwanOrg.score}점</span>
            )}
          </p>
          <div class="space-y-1.5">
            {[...orgRows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((o) => (
              <div key={o.group_key} class="flex items-center gap-2 text-sm">
                <span class="w-20 shrink-0" style={{ color: colorOf(o.group_key) }}>
                  {data.groups[o.group_key]?.name ?? o.group_key}
                </span>
                <div class="h-2 flex-1 rounded bg-zinc-800">
                  <div class="h-2 rounded"
                       style={{ width: `${Math.min(100, o.score!)}%`,
                                background: colorOf(o.group_key),
                                opacity: o.group_key === "miiwan" ? 1 : 0.5 }} />
                </div>
                <span class="w-12 text-right tabular-nums text-zinc-400">{o.score}</span>
                {o.reference && <span class="text-hint text-zinc-600">참조</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ⑤ 방법론 각주 — "이 비교 어떻게 만든 거냐"에 화면만으로 답하기 */}
      <p class="text-hint text-zinc-500 leading-relaxed">
        방법론: 각 그룹의 데뷔일을 D-Day(=0일)로 정렬하고 같은 경과일의 스냅샷을
        비교. 성장곡선은 D-Day 값=100 인덱스, 성장배수는 D+{data.as_of_day} 값 ÷ D-Day 값.
        순위 코호트는 유사 시기에 데뷔한 K-POP 버추얼 {
          Object.values(data.groups).filter((g) => !g.reference).length - 1}팀,
        PLAVE는 성공 사례 참조선(순위 제외). <span class="text-zinc-400">est</span> 배지 =
        백필 추정치(곡선 모양 신뢰, 절대값 참고). 해당 구간 데이터가 없는 그룹은
        수치를 만들어 채우지 않고 비교에서 제외
        {data.excluded.length > 0 && ` (현재 ${data.excluded.length}건 제외)`}.
      </p>
    </div>
  );
}
```

주의: `EmptyState` import 경로와 props(title/hint/icon)는 `MiiWANBriefing.tsx` 상단의 실제 import·사용례를 열어 확인하고 동일하게 맞출 것. `useMemo` 훅은 early return(`if (!data)`)보다 **앞**에 두면 안 되는 게 아니라 — Preact hooks 규칙상 조건부 return 이후에 훅이 오면 안 되므로, 구현 시 `head`·`orgRows` 계산을 early return **앞**으로 옮기거나 훅 없이 일반 계산으로 바꿀 것 (위 코드 그대로면 `useMemo`가 early return 뒤에 있어 규칙 위반 — `const head = data ? headline(data) : null` 식 일반 계산으로 단순화 권장).

- [ ] **Step 2: 브리핑 탭에 삽입**

`frontend/src/views/MiiWANBriefing.tsx`:
1. 상단 import에 `import { MiiWANCohortReport } from "../components/MiiWANCohortReport";` 추가.
2. Task 4에서 비운 자리(KPI 그리드 섹션 닫힘과 `{/* 5b) ... 유기성 */}` 사이)에:

```tsx
      {/* 5) 동시기 성과 — 데뷔일 정렬(D+N) 코호트 벤치마크. 절대값이 아니라
          성장 기울기·순위로 "동시기 대비 잘하고 있는가"를 증명하는 보고서형
          섹션 (투자사 보고 근거). */}
      <section>
        <h2 class="section-title mb-3">동시기 성과 — 데뷔 코호트 벤치마크</h2>
        <MiiWANCohortReport />
      </section>
```

- [ ] **Step 3: 타입·빌드·전체 테스트 확인**

Run: `cd frontend && npm run typecheck && npm test && npm run build`
Expected: 전부 PASS. typecheck 실패 시 대부분 `EmptyState`/`EstBadge` import 경로·props 불일치 — 실제 정의를 열어 맞춘다.

- [ ] **Step 4: 로컬 스모크 (가능하면)**

로컬 D1에 miiwan 행이 없어(Explore 확인) 브리핑 탭 신규 섹션은 EmptyState로 뜨는 게 정상. `npx wrangler pages dev`가 이미 설정돼 있으면 `/api/miiwan-cohort` 응답이 200 + `excluded`에 miiwan 포함으로 나오는지만 확인. 안 되면 생략(테스트로 갈음).

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/components/MiiWANCohortReport.tsx frontend/src/views/MiiWANBriefing.tsx
git commit -m "feat: 동시기 성과 보고 섹션 (인덱스 곡선·스코어카드·동시기 유기성)"
```
