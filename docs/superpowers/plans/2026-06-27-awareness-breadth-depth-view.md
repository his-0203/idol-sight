# 인지도 정의 정제 — organicity 직교 병기 + breadth×depth 2D 사분면 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MarketOverview에 (A) 그룹 카드 organicity 직교 caveat 플래그와 (B) 카테고리별 인지도×코어팬 2D 사분면을 추가한다. 점수 산식 불변·신규 수집 0·UI 전용.

**Architecture:** 테스트 가능한 로직은 전부 순수 lib 모듈로(`lib/organicity.ts` 확장 + 신규 `lib/breadthDepth.ts`), `.tsx`(신규 `BreadthDepthQuadrant`, `MarketOverview` 수정)는 얇게 두고 tsc로만 가드 — 코드베이스 기존 패턴(vitest `environment:"node"`, 컴포넌트 렌더 테스트 없음, 로직은 lib에서 테스트). organicity 그룹→단일값 collapse는 현재 `CompetitorOrganicityBar`에만 있는 것을 lib로 추출해 바와 MarketOverview가 공유(DRY).

**Tech Stack:** Preact + TypeScript, vitest(`environment:"node"`), 기존 `/api/market`·`/api/debut-window/summary` 엔드포인트(서버 변경 없음).

## Global Constraints

- **점수 산식 불변**: awareness/Health 등 어떤 점수도 바꾸지 않는다. organicity는 인지도에 **곱/합 금지** — 직교 caveat 표기로만.
- **카테고리 분리(하드 제약)**: 인지도가 카테고리-리더 상대 정규화라 K-POP과 서브컬처를 **절대 한 축에 섞지 않는다**. 2D 사분면은 카테고리별 독립.
- **신규 수집 0 / 서버 변경 0**: `/api/market`·`/api/debut-window/summary` 모두 기존 그대로. worker·migration 변경 없음.
- **스코프 정직성**: organicity는 "영상 카탈로그 기준 — 인지도 점수에 미반영" 각주 필수. 코어팬은 "추정(ground-truth 아님)" 명시.
- **thin-sample 억제**: organicity verdict는 `isThinSample`(scored<3)이면 caveat 미표시.
- **기존 동작 보존**: `CompetitorOrganicityBar`는 리팩터 후 동작 불변(tsc + 기존 `organicity.test.ts` 가드).
- **테스트 환경**: vitest `environment:"node"` — DOM 없음. 모든 단위테스트는 순수 함수 대상. `.tsx`는 tsc로만 검증.
- **CI 그린 필수**: 각 태스크 종료 시 `cd frontend && npx vitest run` + `npx tsc --noEmit` 둘 다 통과.

---

### Task 1: organicity 그룹→단일값 collapse를 lib로 추출 + caveat 규칙 (DRY 리팩터)

**Files:**
- Modify: `frontend/src/lib/organicity.ts` (말미에 추가)
- Modify: `frontend/src/components/CompetitorOrganicityBar.tsx` (로컬 타입·함수 삭제 → 임포트)
- Test: `frontend/tests/lib/organicity.test.ts` (describe 블록 추가)

**Interfaces:**
- Consumes: 기존 `scoreToVerdict`, `isThinSample`, `Verdict`(같은 파일).
- Produces:
  - `type OrganicityMode = "all_weighted" | "all_simple" | "long" | "short"`
  - `interface OrganicitySummaryRow { group_key: string; window_bucket: string; organic_score_mean: number|null; organic_score_mean_long: number|null; organic_score_mean_short: number|null; organic_score_mean_simple: number|null; organic_score_mean_shrunk: number|null; video_count: number; scored_video_count: number; long_form_count: number; short_form_count: number }`
  - `type OrganicityDisplayMode = "exact" | "current" | "none"`
  - `interface GroupOrganicity { group_key: string; score: number|null; sample_count: number; scored_count: number; thin: boolean; display_mode: OrganicityDisplayMode; shown_bucket: string }`
  - `function organicityScoreFor(row: OrganicitySummaryRow, mode: OrganicityMode): number|null`
  - `function organicitySampleCountFor(row: OrganicitySummaryRow, mode: OrganicityMode): number`
  - `function selectGroupOrganicity(byBucket: Map<string, OrganicitySummaryRow>, selected: string, mode: OrganicityMode, groupKey: string, bucketsOrdered: readonly string[]): GroupOrganicity`
  - `function computeGroupOrganicities(rows: OrganicitySummaryRow[], opts: { buckets: readonly string[]; currentBucket: string; mode: OrganicityMode; excludeGroups?: ReadonlySet<string> }): Map<string, GroupOrganicity>`
  - `interface OrganicityCaveat { show: boolean; verdict: Verdict|null; label: string }`
  - `function organicityCaveat(g: GroupOrganicity | null | undefined): OrganicityCaveat`

- [ ] **Step 1: Write the failing test**

`frontend/tests/lib/organicity.test.ts` 말미에 추가:

```typescript
import {
  computeGroupOrganicities,
  organicityCaveat,
  organicityScoreFor,
  selectGroupOrganicity,
  type OrganicitySummaryRow,
} from "../../src/lib/organicity";

function row(p: Partial<OrganicitySummaryRow> & { group_key: string; window_bucket: string }): OrganicitySummaryRow {
  return {
    organic_score_mean: null, organic_score_mean_long: null,
    organic_score_mean_short: null, organic_score_mean_simple: null,
    organic_score_mean_shrunk: null, video_count: 0, scored_video_count: 0,
    long_form_count: 0, short_form_count: 0, ...p,
  };
}

describe("selectGroupOrganicity (bucket fallback collapse)", () => {
  const buckets = ["D-20", "D-Day", "D+20"] as const;

  it("exact: selected bucket has a score for the mode", () => {
    const m = new Map([
      ["D-Day", row({ group_key: "g", window_bucket: "D-Day", organic_score_mean_simple: 72, organic_score_mean_shrunk: 72, video_count: 10, scored_video_count: 10 })],
    ]);
    const r = selectGroupOrganicity(m, "D-Day", "all_simple", "g", buckets);
    expect(r.score).toBe(72);
    expect(r.display_mode).toBe("exact");
    expect(r.thin).toBe(false);
  });

  it("current: selected bucket empty → newest non-null bucket", () => {
    const m = new Map([
      ["D-20", row({ group_key: "g", window_bucket: "D-20", organic_score_mean_simple: 60, organic_score_mean_shrunk: 60, video_count: 5, scored_video_count: 5 })],
    ]);
    const r = selectGroupOrganicity(m, "D+20", "all_simple", "g", buckets);
    expect(r.score).toBe(60);
    expect(r.display_mode).toBe("current");
    expect(r.shown_bucket).toBe("D-20");
  });

  it("none: no scoreable bucket for the mode", () => {
    const m = new Map([
      ["D-Day", row({ group_key: "g", window_bucket: "D-Day" })],
    ]);
    const r = selectGroupOrganicity(m, "D-Day", "all_simple", "g", buckets);
    expect(r.score).toBeNull();
    expect(r.display_mode).toBe("none");
  });

  it("thin sample flagged when scored < 3", () => {
    const m = new Map([
      ["D-Day", row({ group_key: "g", window_bucket: "D-Day", organic_score_mean_simple: 90, organic_score_mean_shrunk: 90, video_count: 2, scored_video_count: 2 })],
    ]);
    const r = selectGroupOrganicity(m, "D-Day", "all_simple", "g", buckets);
    expect(r.thin).toBe(true);
  });
});

describe("organicityScoreFor (all_simple uses shrunk headline)", () => {
  it("falls back to raw simple mean when shrunk null", () => {
    expect(organicityScoreFor(row({ group_key: "g", window_bucket: "b", organic_score_mean_simple: 50, organic_score_mean_shrunk: null }), "all_simple")).toBe(50);
    expect(organicityScoreFor(row({ group_key: "g", window_bucket: "b", organic_score_mean_simple: 50, organic_score_mean_shrunk: 58 }), "all_simple")).toBe(58);
  });
});

describe("computeGroupOrganicities", () => {
  const buckets = ["D-Day", "D+20"];
  const rows = [
    row({ group_key: "a", window_bucket: "D-Day", organic_score_mean_simple: 80, organic_score_mean_shrunk: 80, video_count: 9, scored_video_count: 9 }),
    row({ group_key: "b", window_bucket: "D-Day", organic_score_mean_simple: 30, organic_score_mean_shrunk: 30, video_count: 9, scored_video_count: 9 }),
    row({ group_key: "x", window_bucket: "D-Day", organic_score_mean_simple: 99, organic_score_mean_shrunk: 99, video_count: 9, scored_video_count: 9 }),
  ];

  it("returns one entry per group, excluding excludeGroups", () => {
    const m = computeGroupOrganicities(rows, { buckets, currentBucket: "D-Day", mode: "all_simple", excludeGroups: new Set(["x"]) });
    expect(m.size).toBe(2);
    expect(m.get("a")!.score).toBe(80);
    expect(m.has("x")).toBe(false);
  });

  it("ignores rows in buckets not in the display list", () => {
    const extra = [...rows, row({ group_key: "c", window_bucket: "D-999", organic_score_mean_simple: 50, organic_score_mean_shrunk: 50, video_count: 9, scored_video_count: 9 })];
    const m = computeGroupOrganicities(extra, { buckets, currentBucket: "D-Day", mode: "all_simple" });
    expect(m.has("c")).toBe(false);
  });
});

describe("organicityCaveat", () => {
  const g = (score: number | null, thin = false): import("../../src/lib/organicity").GroupOrganicity =>
    ({ group_key: "g", score, sample_count: 9, scored_count: 9, thin, display_mode: "exact", shown_bucket: "D-Day" });

  it("shows for caution tiers, hides for organic/strong", () => {
    expect(organicityCaveat(g(35)).show).toBe(true);   // likely_paid
    expect(organicityCaveat(g(35)).label).toBe("유료 의심↑");
    expect(organicityCaveat(g(50)).show).toBe(true);   // suspect
    expect(organicityCaveat(g(50)).label).toBe("유료 의심");
    expect(organicityCaveat(g(60)).show).toBe(true);   // borderline
    expect(organicityCaveat(g(60)).label).toBe("오가닉성 주의");
    expect(organicityCaveat(g(75)).show).toBe(false);  // organic
    expect(organicityCaveat(g(90)).show).toBe(false);  // organic_strong
  });

  it("hides when thin, null score, or missing", () => {
    expect(organicityCaveat(g(35, true)).show).toBe(false);
    expect(organicityCaveat(g(null)).show).toBe(false);
    expect(organicityCaveat(undefined).show).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/lib/organicity.test.ts`
Expected: FAIL — `selectGroupOrganicity`, `computeGroupOrganicities`, `organicityCaveat`, `organicityScoreFor` not exported.

- [ ] **Step 3: Implement — append to `frontend/src/lib/organicity.ts`**

```typescript
// ── Group-level organicity collapse (shared by CompetitorOrganicityBar +
// MarketOverview). Extracted from CompetitorOrganicityBar so the bucket
// fallback + thin-sample rule live in exactly one place — same single-source
// discipline this file's header enforces for the color scale. ──────────────

export type OrganicityMode = "all_weighted" | "all_simple" | "long" | "short";

export interface OrganicitySummaryRow {
  group_key: string;
  window_bucket: string;
  organic_score_mean: number | null;        // view-weighted
  organic_score_mean_long: number | null;
  organic_score_mean_short: number | null;
  organic_score_mean_simple: number | null; // count-based
  organic_score_mean_shrunk: number | null; // thin-sample-shrunk headline
  video_count: number;
  scored_video_count: number;
  long_form_count: number;
  short_form_count: number;
}

export type OrganicityDisplayMode = "exact" | "current" | "none";

export interface GroupOrganicity {
  group_key: string;
  score: number | null;
  sample_count: number;
  scored_count: number;
  thin: boolean;
  display_mode: OrganicityDisplayMode;
  shown_bucket: string;
}

/** Score column for a mode. all_simple = thin-sample-shrunk headline (V2.50),
 * falling back to the raw simple mean on pre-0092 rows. */
export function organicityScoreFor(row: OrganicitySummaryRow, mode: OrganicityMode): number | null {
  if (mode === "all_weighted") return row.organic_score_mean;
  if (mode === "all_simple")   return row.organic_score_mean_shrunk ?? row.organic_score_mean_simple;
  if (mode === "long")         return row.organic_score_mean_long;
  return row.organic_score_mean_short;
}

export function organicitySampleCountFor(row: OrganicitySummaryRow, mode: OrganicityMode): number {
  if (mode === "long")  return row.long_form_count;
  if (mode === "short") return row.short_form_count;
  return row.video_count;
}

/** Collapse a group's per-bucket rows to one display value:
 *  exact (selected bucket scored) → current (newest scored bucket) → none. */
export function selectGroupOrganicity(
  byBucket: Map<string, OrganicitySummaryRow>,
  selected: string,
  mode: OrganicityMode,
  groupKey: string,
  bucketsOrdered: readonly string[],
): GroupOrganicity {
  const exact = byBucket.get(selected);
  if (exact && organicityScoreFor(exact, mode) !== null) {
    const sample = organicitySampleCountFor(exact, mode);
    return {
      group_key: groupKey, score: organicityScoreFor(exact, mode),
      sample_count: sample, scored_count: exact.scored_video_count,
      thin: isThinSample(sample), display_mode: "exact", shown_bucket: selected,
    };
  }
  for (let i = bucketsOrdered.length - 1; i >= 0; i--) {
    const b = bucketsOrdered[i]!;
    const r = byBucket.get(b);
    if (r && organicityScoreFor(r, mode) !== null) {
      const sample = organicitySampleCountFor(r, mode);
      return {
        group_key: groupKey, score: organicityScoreFor(r, mode),
        sample_count: sample, scored_count: r.scored_video_count,
        thin: isThinSample(sample), display_mode: "current", shown_bucket: b,
      };
    }
  }
  return {
    group_key: groupKey, score: null, sample_count: 0, scored_count: 0,
    thin: false, display_mode: "none", shown_bucket: selected,
  };
}

/** Build a group_key → GroupOrganicity map at a given (bucket, mode). */
export function computeGroupOrganicities(
  rows: OrganicitySummaryRow[],
  opts: { buckets: readonly string[]; currentBucket: string; mode: OrganicityMode; excludeGroups?: ReadonlySet<string> },
): Map<string, GroupOrganicity> {
  const { buckets, currentBucket, mode, excludeGroups } = opts;
  const byGroup = new Map<string, Map<string, OrganicitySummaryRow>>();
  for (const r of rows) {
    if (excludeGroups?.has(r.group_key)) continue;
    if (!buckets.includes(r.window_bucket)) continue;
    let m = byGroup.get(r.group_key);
    if (!m) { m = new Map(); byGroup.set(r.group_key, m); }
    m.set(r.window_bucket, r);
  }
  const out = new Map<string, GroupOrganicity>();
  for (const [key, byBucket] of byGroup) {
    out.set(key, selectGroupOrganicity(byBucket, currentBucket, mode, key, buckets));
  }
  return out;
}

export interface OrganicityCaveat {
  show: boolean;
  verdict: Verdict | null;
  label: string;
}

// caution tiers only — organic / organic_strong never flag.
const CAVEAT_LABEL: Partial<Record<Verdict, string>> = {
  borderline: "오가닉성 주의",
  suspect: "유료 의심",
  likely_paid: "유료 의심↑",
};

/** Orthogonal caveat for a group's awareness card. Shows ONLY when the
 * organicity headline is in a caution tier AND the sample is not thin —
 * never folded into the awareness score (catalog flow-quality ≠ cumulative
 * reach; different scope). */
export function organicityCaveat(g: GroupOrganicity | null | undefined): OrganicityCaveat {
  if (!g || g.score === null || g.thin) return { show: false, verdict: null, label: "" };
  const verdict = scoreToVerdict(g.score);
  const label = CAVEAT_LABEL[verdict];
  if (!label) return { show: false, verdict, label: "" };
  return { show: true, verdict, label };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/lib/organicity.test.ts`
Expected: PASS (all, including pre-existing drift-guard tests).

- [ ] **Step 5: Refactor `CompetitorOrganicityBar.tsx` to consume the shared helpers**

`frontend/src/components/CompetitorOrganicityBar.tsx`:
- 임포트에 추가: `import { computeGroupOrganicities, organicityScoreFor, organicitySampleCountFor, selectGroupOrganicity, type GroupOrganicity, type OrganicityMode, type OrganicitySummaryRow } from "../lib/organicity";`
- 삭제: 로컬 `type Mode`, `interface SummaryRow`, `interface DisplayRow`, `type DisplayMode`, `function scoreFor`, `function sampleCountFor`, `function pickDisplayRow`.
- `Mode` 사용처를 `OrganicityMode`로, `SummaryRow`를 `OrganicitySummaryRow`로, `DisplayRow`를 `GroupOrganicity`로 치환. `MODE_LABEL: Record<Mode, string>` → `Record<OrganicityMode, string>`. `useState<Mode>` → `useState<OrganicityMode>`. `api.debutWindowSummary<SummaryRow>` → `<OrganicitySummaryRow>`.
- `display` useMemo를 교체:

```typescript
  const display = useMemo<GroupOrganicity[]>(() => {
    if (!allRows) return [];
    return Array.from(
      computeGroupOrganicities(allRows, {
        buckets, currentBucket: bucket, mode, excludeGroups: EXCLUDED_GROUPS,
      }).values(),
    );
  }, [allRows, bucket, mode, buckets]);
```

(`MODE_LABEL`, `EXCLUDED_GROUPS`는 로컬 유지. 동작 불변.)

- [ ] **Step 6: Verify refactor — tsc + full frontend tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: PASS, 0 type errors. (바 동작은 tsc + 기존 테스트로 가드 — 렌더 변화 없음.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/organicity.ts frontend/src/components/CompetitorOrganicityBar.tsx frontend/tests/lib/organicity.test.ts
git commit -m "refactor(organicity): extract group-level collapse + caveat rule into lib

selectGroupOrganicity/computeGroupOrganicities/organicityCaveat 추출.
CompetitorOrganicityBar 동작 불변 리팩터(공유 헬퍼 사용). 인지도×organicity
직교 caveat 규칙(주의 구간 + non-thin만) 신설 — MarketOverview에서 소비.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: breadth×depth 사분면 순수 계산 (`lib/breadthDepth.ts`)

**Files:**
- Create: `frontend/src/lib/breadthDepth.ts`
- Test: `frontend/tests/lib/breadthDepth.test.ts`

**Interfaces:**
- Consumes: (없음 — 자족 순수 모듈)
- Produces:
  - `interface QuadrantInput { key: string; name: string; x: number; y: number; caveat: boolean }`
  - `type QuadrantKey = "strong" | "ad_driven" | "niche" | "low"`
  - `const QUADRANT_LABEL: Record<QuadrantKey, string>`
  - `function median(nums: number[]): number`
  - `interface QuadrantPoint extends QuadrantInput { quadrant: QuadrantKey }`
  - `interface QuadrantLayout { points: QuadrantPoint[]; xMedian: number; yMedian: number; plottable: boolean }`
  - `function computeQuadrantLayout(input: QuadrantInput[]): QuadrantLayout`

- [ ] **Step 1: Write the failing test**

`frontend/tests/lib/breadthDepth.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  QUADRANT_LABEL,
  computeQuadrantLayout,
  median,
  type QuadrantInput,
} from "../../src/lib/breadthDepth";

const p = (key: string, x: number, y: number, caveat = false): QuadrantInput => ({ key, name: key.toUpperCase(), x, y, caveat });

describe("median", () => {
  it("odd length → middle", () => expect(median([3, 1, 2])).toBe(2));
  it("even length → mean of middles", () => expect(median([1, 2, 3, 4])).toBe(2.5));
  it("empty → 0", () => expect(median([])).toBe(0));
});

describe("computeQuadrantLayout", () => {
  it("classifies by category median crosshair (>= is right/top)", () => {
    // x values [80,80,20,20] → median 50; y values [200,20,200,20] → median 110
    const layout = computeQuadrantLayout([
      p("hi_strong", 80, 200),  // right + top → strong
      p("hi_ad", 80, 20),       // right + low  → ad_driven
      p("lo_niche", 20, 200),   // left + top   → niche
      p("lo_low", 20, 20),      // left + low   → low
    ]);
    expect(layout.plottable).toBe(true);
    expect(layout.xMedian).toBe(50);
    expect(layout.yMedian).toBe(110); // median of [200,20,200,20] = (200+20)/2... sorted [20,20,200,200] → (20+200)/2 = 110
    const q = Object.fromEntries(layout.points.map((pt) => [pt.key, pt.quadrant]));
    expect(q.hi_strong).toBe("strong");
    expect(q.hi_ad).toBe("ad_driven");
    expect(q.lo_niche).toBe("niche");
    expect(q.lo_low).toBe("low");
  });

  it("drops non-finite x/y and flags <2 plottable as not plottable", () => {
    const layout = computeQuadrantLayout([
      p("only", 50, 50),
      { key: "noy", name: "NOY", x: 50, y: NaN, caveat: false },
    ]);
    expect(layout.points).toHaveLength(1);
    expect(layout.plottable).toBe(false);
  });

  it("preserves caveat flag on points", () => {
    const layout = computeQuadrantLayout([p("a", 80, 200, true), p("b", 20, 20)]);
    expect(layout.points.find((pt) => pt.key === "a")!.caveat).toBe(true);
  });

  it("exposes the four quadrant labels", () => {
    expect(QUADRANT_LABEL.strong).toBe("진성 강세");
    expect(QUADRANT_LABEL.ad_driven).toBe("광고형/바이럴");
    expect(QUADRANT_LABEL.niche).toBe("니치 충성");
    expect(QUADRANT_LABEL.low).toBe("저조");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run tests/lib/breadthDepth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `frontend/src/lib/breadthDepth.ts`**

```typescript
// Pure geometry for the breadth(인지도) × depth(추정 코어팬) 2D quadrant.
// Awareness is category-leader-relative, so callers MUST pass one category's
// groups at a time — never mix K-POP and 서브컬처 on one crosshair.
//
// The crosshair sits at the category MEDIAN of each axis (relative position;
// honest for the small N per category). Classification uses raw y; the SVG
// layer positions y on a log1p scale so a 0-core group is still plottable.

export interface QuadrantInput {
  key: string;
  name: string;
  x: number;       // awareness score 0–100
  y: number;       // est_active_core (count >= 0)
  caveat: boolean; // organicity caution → ⚠ marker
}

export type QuadrantKey = "strong" | "ad_driven" | "niche" | "low";

export const QUADRANT_LABEL: Record<QuadrantKey, string> = {
  strong:    "진성 강세",      // 고인지·강코어
  ad_driven: "광고형/바이럴",  // 고인지·약코어 (도달≫헌신)
  niche:     "니치 충성",      // 저인지·강코어 (컬트)
  low:       "저조",           // 저인지·약코어
};

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export interface QuadrantPoint extends QuadrantInput { quadrant: QuadrantKey }

export interface QuadrantLayout {
  points: QuadrantPoint[];
  xMedian: number;
  yMedian: number;
  plottable: boolean; // false when < 2 finite points → caller shows a note
}

function classify(x: number, y: number, xMed: number, yMed: number): QuadrantKey {
  const right = x >= xMed;
  const top = y >= yMed;
  if (right && top) return "strong";
  if (right && !top) return "ad_driven";
  if (!right && top) return "niche";
  return "low";
}

export function computeQuadrantLayout(input: QuadrantInput[]): QuadrantLayout {
  const valid = input.filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
  if (valid.length < 2) {
    return {
      points: valid.map((pt) => ({ ...pt, quadrant: "low" as QuadrantKey })),
      xMedian: 0, yMedian: 0, plottable: false,
    };
  }
  const xMedian = median(valid.map((pt) => pt.x));
  const yMedian = median(valid.map((pt) => pt.y));
  const points = valid.map((pt) => ({ ...pt, quadrant: classify(pt.x, pt.y, xMedian, yMedian) }));
  return { points, xMedian, yMedian, plottable: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run tests/lib/breadthDepth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/breadthDepth.ts frontend/tests/lib/breadthDepth.test.ts
git commit -m "feat(breadthDepth): pure quadrant geometry for 인지도×코어팬 2D

카테고리 중앙값 십자선 분류(진성강세/광고형/니치/저조). 비유한 좌표 제외,
<2점이면 plottable=false. 순수·테스트.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `BreadthDepthQuadrant.tsx` SVG 컴포넌트

**Files:**
- Create: `frontend/src/components/BreadthDepthQuadrant.tsx`

**Interfaces:**
- Consumes: `computeQuadrantLayout`, `QUADRANT_LABEL`, `QuadrantInput` (Task 2).
- Produces: `export function BreadthDepthQuadrant(props: { points: QuadrantInput[] }): JSX.Element` — 카테고리당 1개 렌더. 테스트 없음(렌더 — node env). tsc로만 가드.

- [ ] **Step 1: Implement `frontend/src/components/BreadthDepthQuadrant.tsx`**

```tsx
import { useMemo } from "preact/hooks";
import {
  QUADRANT_LABEL,
  computeQuadrantLayout,
  type QuadrantInput,
} from "../lib/breadthDepth";

// SVG geometry constants.
const W = 320, H = 220, PAD_L = 36, PAD_R = 12, PAD_T = 18, PAD_B = 28;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

// y uses log1p so a 0-core group still plots at the axis floor.
const ly = (v: number) => Math.log1p(Math.max(0, v));

/** breadth(인지도) × depth(추정 적극코어) 2D 사분면. 한 카테고리만 받는다
 *  (인지도가 카테고리-리더 상대값이라 교차 비교 불가). 합치지 않고 함께 읽기. */
export function BreadthDepthQuadrant({ points }: { points: QuadrantInput[] }) {
  const layout = useMemo(() => computeQuadrantLayout(points), [points]);

  if (!layout.plottable) {
    return (
      <div class="text-hint text-zinc-600 px-2 py-3">
        인지도·추정 코어팬 둘 다 집계된 그룹이 2개 미만 — 사분면 생략.
      </div>
    );
  }

  // x: 0–100 linear. y: log1p over [0, maxY].
  const maxY = Math.max(...layout.points.map((p) => p.y), 1);
  const sx = (x: number) => PAD_L + (Math.max(0, Math.min(100, x)) / 100) * PLOT_W;
  const sy = (y: number) => PAD_T + PLOT_H - (ly(y) / ly(maxY || 1)) * PLOT_H;
  const cx = sx(layout.xMedian);
  const cy = sy(layout.yMedian);

  return (
    <div class="card p-2">
      <div class="mb-1 flex flex-wrap items-baseline gap-2">
        <span class="text-xs font-semibold text-zinc-300">넓이 × 깊이</span>
        <span class="text-hint text-zinc-500">
          인지도(가로) × 추정 적극 코어(세로·log). 합치지 않고 함께 읽기.
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} class="w-full" role="img"
           aria-label="인지도 대 추정 코어팬 사분면">
        {/* quadrant crosshair (category medians) */}
        <line x1={cx} y1={PAD_T} x2={cx} y2={PAD_T + PLOT_H} stroke="#3f3f46" stroke-dasharray="3 3" />
        <line x1={PAD_L} y1={cy} x2={PAD_L + PLOT_W} y2={cy} stroke="#3f3f46" stroke-dasharray="3 3" />
        {/* quadrant labels (corners) */}
        <text x={PAD_L + PLOT_W - 2} y={PAD_T + 9} text-anchor="end" class="fill-zinc-600" font-size="8">{QUADRANT_LABEL.strong}</text>
        <text x={PAD_L + PLOT_W - 2} y={PAD_T + PLOT_H - 2} text-anchor="end" class="fill-zinc-600" font-size="8">{QUADRANT_LABEL.ad_driven}</text>
        <text x={PAD_L + 2} y={PAD_T + 9} text-anchor="start" class="fill-zinc-600" font-size="8">{QUADRANT_LABEL.niche}</text>
        <text x={PAD_L + 2} y={PAD_T + PLOT_H - 2} text-anchor="start" class="fill-zinc-600" font-size="8">{QUADRANT_LABEL.low}</text>
        {/* axis hints */}
        <text x={PAD_L + PLOT_W} y={H - 6} text-anchor="end" class="fill-zinc-500" font-size="8">인지도 →</text>
        {/* points */}
        {layout.points.map((pt) => (
          <g key={pt.key}>
            <circle cx={sx(pt.x)} cy={sy(pt.y)} r={4}
                    fill={pt.caveat ? "#ef4444" : "#38bdf8"}
                    fill-opacity={0.85} />
            <text x={sx(pt.x) + 6} y={sy(pt.y) + 3} class="fill-zinc-300" font-size="9">
              {pt.caveat ? "⚠ " : ""}{pt.name}
            </text>
          </g>
        ))}
      </svg>
      <div class="text-hint text-zinc-600 px-1">
        십자선 = 카테고리 중앙값(상대 위치). 코어팬은 좋아요·댓글 추정(ground-truth 아님).
        ⚠ = 영상 카탈로그 organicity 주의(인지도 점수엔 미반영).
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify tsc**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS, 0 errors. (렌더 단위테스트 없음 — node env. 로직은 Task 2에서 검증됨.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/BreadthDepthQuadrant.tsx
git commit -m "feat(ui): BreadthDepthQuadrant SVG — 인지도×코어팬 사분면 (카테고리별)

중앙값 십자선·4사분면 라벨·log1p y축·organicity ⚠ 마커. <2점이면 생략 노트.
점수 무관 참고 패널.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: MarketOverview 배선 — caveat 플래그 + 사분면 패널

**Files:**
- Modify: `frontend/src/views/MarketOverview.tsx`

**Interfaces:**
- Consumes: `computeGroupOrganicities`, `organicityCaveat`, `type GroupOrganicity`, `type OrganicitySummaryRow` (Task 1); `BreadthDepthQuadrant`, `type QuadrantInput` (Task 2/3); 기존 `api.debutWindowSummary`, `DEFAULT_DISPLAY_BUCKETS`/`DEFAULT_CURRENT_BUCKET` (`lib/debutWindow`), `DEFAULT_ORGANICITY_MODE` (`lib/organicity`).
- Produces: (뷰 — 외부 소비 없음)

- [ ] **Step 1: Add imports + organicity fetch/derivation**

`frontend/src/views/MarketOverview.tsx` 상단 임포트에 추가:

```typescript
import { BreadthDepthQuadrant } from "../components/BreadthDepthQuadrant";
import type { QuadrantInput } from "../lib/breadthDepth";
import {
  DEFAULT_ORGANICITY_MODE,
  computeGroupOrganicities,
  organicityCaveat,
  type GroupOrganicity,
  type OrganicitySummaryRow,
} from "../lib/organicity";
import { DEFAULT_CURRENT_BUCKET, DEFAULT_DISPLAY_BUCKETS } from "../lib/debutWindow";
```

컴포넌트 본문에서 `market` 상태 선언부 근처에 organicity 상태 추가 + fetch effect:

```typescript
  const [orgRows, setOrgRows] = useState<OrganicitySummaryRow[] | null>(null);
  const [orgBuckets, setOrgBuckets] = useState<string[]>(DEFAULT_DISPLAY_BUCKETS);
  const [orgCurrent, setOrgCurrent] = useState<string>(DEFAULT_CURRENT_BUCKET);

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary<OrganicitySummaryRow>().then((r) => {
      if (cancelled) return;
      if (r.window?.buckets?.length) {
        setOrgBuckets(r.window.buckets);
        setOrgCurrent(r.window.current_bucket);
      }
      setOrgRows(r.rows);
    }).catch(() => { if (!cancelled) setOrgRows([]); });
    return () => { cancelled = true; };
  }, []);

  // group_key → GroupOrganicity (current rolling bucket, count-based headline).
  const orgByKey = useMemo<Map<string, GroupOrganicity>>(() => {
    if (!orgRows) return new Map();
    return computeGroupOrganicities(orgRows, {
      buckets: orgBuckets, currentBucket: orgCurrent, mode: DEFAULT_ORGANICITY_MODE,
    });
  }, [orgRows, orgBuckets, orgCurrent]);
```

(주의: 기존 컴포넌트가 `useEffect`/`useMemo`/`useState`를 이미 임포트하면 중복 추가 금지 — 임포트 라인은 기존 것에 병합.)

- [ ] **Step 2: Add the caveat flag to each card (after the 인지도 line, ~line 357)**

기존 인지도 블록(`<div class="mt-1 flex items-center gap-1.5 text-hint">` … 닫는 `</div>`) **직후**에 삽입:

```tsx
                    {(() => {
                      const cav = organicityCaveat(orgByKey.get(key));
                      if (!cav.show) return null;
                      return (
                        <div
                          class="mt-0.5 flex items-center gap-1 text-[10px] text-orange-400/90"
                          title="영상 카탈로그 organicity가 주의 구간 — 광고로 산 도달 가능성. 인지도 점수에는 반영 안 됨(직교 참고 신호)."
                        >
                          <span aria-hidden="true">⚠</span>
                          <span>{cav.label}</span>
                        </div>
                      );
                    })()}
```

- [ ] **Step 3: Add the quadrant panel to each category section (between header and grid, ~line 287→288)**

`<div class="grid grid-cols-2 gap-2 md:grid-cols-4">` **직전**에 삽입:

```tsx
            <div class="mb-2">
              <BreadthDepthQuadrant
                points={entries.reduce<QuadrantInput[]>((acc, [key, g]: any) => {
                  const x = g.awareness?.score;
                  const y = g.core_fan_estimate?.est_active_core;
                  if (x != null && y != null) {
                    acc.push({ key, name: g.name, x, y, caveat: organicityCaveat(orgByKey.get(key)).show });
                  }
                  return acc;
                }, [])}
              />
            </div>
```

- [ ] **Step 4: Verify tsc + full frontend suite**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: PASS, 0 type errors, all tests green (기존 `api_market.test.ts` 포함 — 서버 미변경).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/MarketOverview.tsx
git commit -m "feat(ui): MarketOverview에 organicity caveat 플래그 + breadth×depth 사분면

카드 인지도 옆 organicity 주의 플래그(주의구간+non-thin, '점수 미반영' 각주),
카테고리 섹션마다 인지도×코어팬 사분면. /api/debut-window/summary 재사용,
서버·점수 불변. 인지도 정의 재검토 결론의 즉시 구현분.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- 스펙 §1(A) organicity caveat → Task 1(규칙 lib) + Task 4 Step 2(카드 플래그). ✅
- 스펙 §1(B) 2D 사분면 → Task 2(계산) + Task 3(SVG) + Task 4 Step 3(배선). ✅
- 스펙 §3.1 클라이언트 합류 → Task 4 Step 1 fetch. ✅
- 스펙 §3.2 DRY 추출 → Task 1. ✅
- 스펙 §3.3 caveat 규칙(주의구간+non-thin, 스코프 각주) → Task 1 `organicityCaveat` + Task 4 title. ✅
- 스펙 §3.4 카테고리별 분리·중앙값·라벨·점라벨·⚠ → Task 2/3. ✅
- 스펙 §3.5 sortMode 불변 → Task 4는 카드 리스트/정렬 미변경(추가만). ✅
- 스펙 §4 파일 목록 → Task 1–4 파일과 일치. ✅
- 스펙 §6 선행(#52 머지) → 이미 완료(main `c32b065`), 본 브랜치는 main 분기. ✅

**2. Placeholder scan:** TBD/TODO/"적절히" 없음. 모든 코드 스텝에 실제 코드. ✅

**3. Type consistency:** `OrganicitySummaryRow`/`GroupOrganicity`/`OrganicityMode`/`QuadrantInput`/`organicityCaveat`/`computeGroupOrganicities`/`computeQuadrantLayout` — Task 1·2 정의와 Task 3·4 소비처 시그니처 일치 확인. `organicityScoreFor`의 all_simple = shrunk fallback이 기존 바 동작과 동일. ✅

**참고**: Task 2 테스트의 yMedian 주석(110) 검증 — sorted [20,20,200,200]의 중앙값 = (20+200)/2 = 110. 테스트 기대값과 일치.
