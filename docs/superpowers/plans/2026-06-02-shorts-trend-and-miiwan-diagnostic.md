# 숏폼 트렌드 뷰 + MiiWAN 숏츠 운영 진단 패널 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 경쟁사 YouTube 숏폼을 velocity·신선도로 랭킹하는 신규 최상위 뷰를 만들고, 그 상단에 MiiWAN 자사 숏츠 운영을 5차원 라이브 진단 + 플레이북으로 정리한다.

**Architecture:** 순수 read 경로. 새 Pages Function `api/shorts-trend.ts` 가 `youtube_videos`(+stats, agg_summary, agg_member_popularity, groups)를 읽어 `{ diagnostic, trend, groups }` 단일 JSON 반환. 진단 계산은 테스트 가능한 순수 모듈 `functions/lib/shortsDiagnostic.ts`, 트렌드 랭킹은 클라이언트 순수 모듈 `src/lib/shortsTrend.ts`. 워커·D1 migration·aggregate 변경 전부 없음.

**Tech Stack:** Cloudflare Pages Functions (TS), Preact + Vite, vitest. 기존 `frontend/functions/lib/d1.ts`(`d1Query`), `frontend/functions/lib/jsonResponse.ts`, `frontend/src/format.ts`(`fmt`/`pct`) 재사용.

**근거 설계:** `docs/superpowers/specs/2026-06-02-shorts-trend-and-miiwan-diagnostic-design.md`

**작업 디렉토리:** 모든 명령은 `frontend/` 에서 실행 (`cd frontend`). 테스트는 `pnpm test`(=`vitest run`), 타입체크는 `pnpm typecheck`.

---

## 파일 구조

| 파일 | 책임 | 신규/수정 |
|---|---|---|
| `frontend/functions/lib/shortsDiagnostic.ts` | 진단 순수 헬퍼: 통계·제목 정규식·status 엔진·우선순위·`buildDiagnostic` | 신규 |
| `frontend/tests/lib/shortsDiagnostic.test.ts` | 위 단위 테스트 | 신규 |
| `frontend/functions/api/shorts-trend.ts` | Pages Function — `{ diagnostic, trend, groups }` 반환 | 신규 |
| `frontend/tests/functions/api_shorts_trend.test.ts` | API 통합 테스트 (D1 mock) | 신규 |
| `frontend/src/lib/shortsTrend.ts` | 트렌드 랭킹·신선도 클라이언트 순수 헬퍼 | 신규 |
| `frontend/tests/lib/shortsTrend.test.ts` | 위 단위 테스트 | 신규 |
| `frontend/src/api.ts` | `shortsTrend()` 클라이언트 메서드 | 수정 |
| `frontend/src/router.ts` | `tab` union 에 `"shorts"` | 수정 |
| `frontend/src/components/Header.tsx` | 네비 항목 "숏폼 트렌드" | 수정 |
| `frontend/src/App.tsx` | `state.tab === "shorts"` 렌더 분기 | 수정 |
| `frontend/src/components/MiiwanShortsDiagnostic.tsx` | 진단 패널 컴포넌트 (props 로 diagnostic 받음) | 신규 |
| `frontend/src/components/ShortsTrendTable.tsx` | 경쟁사 트렌드 테이블 컴포넌트 | 신규 |
| `frontend/src/views/ShortsTrend.tsx` | 뷰 — fetch + 진단 패널 + 트렌드 테이블 조립 | 신규 |

Preact 컴포넌트는 기존 코드베이스 관례상 단위 테스트하지 않는다 (lib·functions 만 테스트). 컴포넌트/뷰는 `pnpm typecheck` + 로컬 수동 검증으로 확인한다.

---

## Task 1: 진단 통계·제목 헬퍼 (순수 함수)

**Files:**
- Create: `frontend/functions/lib/shortsDiagnostic.ts`
- Test: `frontend/tests/lib/shortsDiagnostic.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/lib/shortsDiagnostic.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  median, mean, stdev, coefficientOfVariation,
  breakoutRatio, bandConcentration, cadenceDays,
  titleHasGroupToken, titleHasDecoration, titleHasHashtag,
  coveragePct, normalizedHHI, groupNameVariants,
} from "../../functions/lib/shortsDiagnostic";

describe("기초 통계", () => {
  test("median 홀/짝", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  test("mean / stdev / CV", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(stdev([2, 4, 6])).toBeCloseTo(1.633, 2);
    expect(coefficientOfVariation([2, 4, 6])).toBeCloseTo(0.408, 2);
    expect(coefficientOfVariation([5, 5, 5])).toBe(0); // 평탄
  });
  test("breakoutRatio = max/median", () => {
    expect(breakoutRatio([1128, 2259, 866])).toBeCloseTo(2.0, 1);
    expect(breakoutRatio([])).toBe(0);
  });
  test("bandConcentration — median ±40% 밴드 내 비율", () => {
    // median=1000, 밴드 [600,1400]. 5개 중 4개가 밴드 안 → 0.8
    expect(bandConcentration([700, 900, 1000, 1300, 5000])).toBeCloseTo(0.8, 5);
  });
});

describe("cadenceDays — 게시 간격 중앙값(일)", () => {
  test("3일·1일 간격 → 중앙값 2일", () => {
    const dates = [
      "2026-05-01T00:00:00Z",
      "2026-05-04T00:00:00Z", // +3d
      "2026-05-05T00:00:00Z", // +1d
    ];
    expect(cadenceDays(dates)).toBe(2);
  });
  test("1개 이하 → 0", () => {
    expect(cadenceDays(["2026-05-01T00:00:00Z"])).toBe(0);
    expect(cadenceDays([])).toBe(0);
  });
});

describe("제목 정규식", () => {
  test("그룹명 식별자 포함 (대소문자 무시)", () => {
    expect(titleHasGroupToken("미완소년 데뷔무대 직캠", ["미완소년", "MiiWAN"])).toBe(true);
    expect(titleHasGroupToken("MIIWAN debut stage", ["미완소년", "MiiWAN"])).toBe(true);
    expect(titleHasGroupToken("똑똑똑? 복복복!", ["미완소년", "MiiWAN"])).toBe(false);
    expect(titleHasGroupToken(null, ["MiiWAN"])).toBe(false);
  });
  test("장식/이모지 감지", () => {
    expect(titleHasDecoration("˚₊‧꒰ა 어디까지 날아갈지…~")).toBe(true); // 장식 기호
    expect(titleHasDecoration("그룹 내 게임 서열 1위 겜율이 🎮🏆")).toBe(true); // 이모지
    expect(titleHasDecoration("최고의 인테리어는 마하진 ⟡")).toBe(true);
    expect(titleHasDecoration("포켓몬 박사 나이선 학위 박탈 논란?!")).toBe(false); // ?! 는 장식 아님
    expect(titleHasDecoration("미완소년 신곡 무대")).toBe(false);
  });
  test("해시태그 감지", () => {
    expect(titleHasHashtag("데뷔 #미완소년 #MiiWAN")).toBe(true);
    expect(titleHasHashtag("데뷔 무대")).toBe(false);
  });
});

describe("coveragePct", () => {
  test("predicate 충족 비율 (%)", () => {
    const rows = [{ title: "a #x" }, { title: "b" }, { title: "c #y" }, { title: "d" }];
    expect(coveragePct(rows, (r) => titleHasHashtag(r.title))).toBe(50);
    expect(coveragePct([], () => true)).toBe(0);
  });
});

describe("normalizedHHI", () => {
  test("완전 균등 → 0, 완전 집중 → 1", () => {
    expect(normalizedHHI([1, 1, 1, 1])).toBeCloseTo(0, 5);
    expect(normalizedHHI([5, 0, 0, 0])).toBeCloseTo(1, 5);
    expect(normalizedHHI([])).toBeNull();
    expect(normalizedHHI([3])).toBeNull(); // n<2 의미 없음
  });
});

describe("groupNameVariants — 공식 그룹명만 (별명 제외)", () => {
  test("name/name_kr + 이름 변형만 추출, 초성·별명 제외", () => {
    const v = groupNameVariants("MiiWAN", "미완소년",
      ["miiwan", "MIIWAN", "미완", "ㅁㅇㅅㄴ", "겜율이"]);
    expect(v).toContain("MiiWAN");
    expect(v).toContain("미완소년");
    expect(v).toContain("miiwan");
    expect(v).toContain("미완");      // 미완소년의 부분문자열 → 변형으로 인정
    expect(v).not.toContain("ㅁㅇㅅㄴ"); // 초성 약자 — 검색 텍스트 아님
    expect(v).not.toContain("겜율이");  // 멤버 별명
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test shortsDiagnostic`
Expected: FAIL — `functions/lib/shortsDiagnostic.ts` 모듈/함수 없음.

- [ ] **Step 3: 헬퍼 구현**

`frontend/functions/lib/shortsDiagnostic.ts` (이 Task 범위 — 통계·제목·변형 헬퍼만):

```ts
// MiiWAN 숏츠 운영 진단 — 순수 헬퍼.
// 설계: docs/superpowers/specs/2026-06-02-shorts-trend-and-miiwan-diagnostic-design.md
// 임계값은 Task 2 의 THRESHOLDS 상수에 모은다. 본 파일 전체가 부수효과 없는
// 순수 함수라 vitest 로 단독 검증 가능하고, API 에서 그대로 호출한다.

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function stdev(nums: number[]): number {
  if (nums.length === 0) return 0;
  const m = mean(nums);
  return Math.sqrt(mean(nums.map((n) => (n - m) ** 2)));
}

export function coefficientOfVariation(nums: number[]): number {
  const m = mean(nums);
  return m === 0 ? 0 : stdev(nums) / m;
}

export function breakoutRatio(views: number[]): number {
  const med = median(views);
  return med === 0 ? 0 : Math.max(...views) / med;
}

// median ±40% 밴드 안에 들어오는 표본 비율 (0~1). 높을수록 '평탄·정체'.
export function bandConcentration(views: number[]): number {
  if (views.length === 0) return 0;
  const med = median(views);
  if (med === 0) return 0;
  const lo = med * 0.6, hi = med * 1.4;
  return views.filter((v) => v >= lo && v <= hi).length / views.length;
}

function toMs(iso: string): number {
  // SQLite 'YYYY-MM-DD HH:MM:SS' (Z 없음) 도 UTC 로 취급.
  let s = iso.trim();
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!/[Z+]|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  return Date.parse(s);
}

// 게시 시각 정렬 후 인접 간격(일)의 중앙값. 표본 2개 미만이면 0.
export function cadenceDays(publishedAts: string[]): number {
  const ms = publishedAts.map(toMs).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  if (ms.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < ms.length; i++) gaps.push((ms[i] - ms[i - 1]) / 86_400_000);
  return median(gaps);
}

export function titleHasGroupToken(title: string | null, tokens: string[]): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  return tokens.some((tok) => tok && t.includes(tok.toLowerCase()));
}

// 이모지(Extended_Pictographic) · 기호(\p{S}) · 장식 문장부호 curated set.
// '?!' '…' '~' 같은 일반 문장부호는 의도적으로 제외 (장식 아님).
const DECORATION_RE = /\p{Extended_Pictographic}|\p{S}|[‧꒰꒱ა⟡⟢✦✧⋆]/u;
export function titleHasDecoration(title: string | null): boolean {
  return !!title && DECORATION_RE.test(title);
}

export function titleHasHashtag(title: string | null): boolean {
  return !!title && title.includes("#");
}

export function coveragePct<T>(rows: T[], pred: (r: T) => boolean): number {
  if (rows.length === 0) return 0;
  return (rows.filter(pred).length / rows.length) * 100;
}

// 정규화 HHI: 0=완전 균등, 1=완전 집중. n<2 또는 합 0 → null.
export function normalizedHHI(shares: number[]): number | null {
  const vals = shares.filter((s) => s > 0);
  const n = shares.length;
  if (n < 2) return null;
  const total = vals.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const hhi = vals.reduce((acc, s) => acc + (s / total) ** 2, 0);
  const floor = 1 / n;
  return (hhi - floor) / (1 - floor);
}

// 공식 그룹명 토큰만 추출 (멤버 별명·초성 약자 제외). name/name_kr 을 기준으로,
// context_keywords 중 그 이름과 부분문자열 관계인 것(대소문자 변형·축약)만 인정.
export function groupNameVariants(
  name: string | null, nameKr: string | null, contextKeywords: string[],
): string[] {
  const base = [name, nameKr].filter((x): x is string => !!x);
  const lc = (s: string) => s.toLowerCase();
  const variants = contextKeywords.filter((k) =>
    base.some((b) => lc(b).includes(lc(k)) || lc(k).includes(lc(b))));
  return Array.from(new Set([...base, ...variants]));
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test shortsDiagnostic`
Expected: PASS (모든 describe 블록).

- [ ] **Step 5: 커밋**

```bash
git add frontend/functions/lib/shortsDiagnostic.ts frontend/tests/lib/shortsDiagnostic.test.ts
git commit -m "feat(shorts-diagnostic): 진단 통계·제목·그룹명 변형 순수 헬퍼 + 테스트"
```

---

## Task 2: status 엔진 + `buildDiagnostic` + 우선순위

**Files:**
- Modify: `frontend/functions/lib/shortsDiagnostic.ts` (헬퍼 아래에 타입·상수·빌더 추가)
- Modify: `frontend/tests/lib/shortsDiagnostic.test.ts` (describe 블록 추가)

- [ ] **Step 1: 실패하는 테스트 추가**

`frontend/tests/lib/shortsDiagnostic.test.ts` 상단 import 에 추가:

```ts
import { statusByThresholds, buildDiagnostic, type DiagnosticInput } from "../../functions/lib/shortsDiagnostic";
```

파일 끝에 describe 추가:

```ts
describe("statusByThresholds", () => {
  test("higher-better: good/warn/bad 경계", () => {
    const t = { good: 10, warn: 3, direction: "higher" as const };
    expect(statusByThresholds(12, t)).toBe("good");
    expect(statusByThresholds(10, t)).toBe("good");
    expect(statusByThresholds(5, t)).toBe("warn");
    expect(statusByThresholds(3, t)).toBe("warn");
    expect(statusByThresholds(2, t)).toBe("bad");
  });
  test("lower-better: good/warn/bad 경계", () => {
    const t = { good: 0.2, warn: 0.5, direction: "lower" as const };
    expect(statusByThresholds(0.1, t)).toBe("good");
    expect(statusByThresholds(0.2, t)).toBe("good");
    expect(statusByThresholds(0.4, t)).toBe("warn");
    expect(statusByThresholds(0.5, t)).toBe("warn");
    expect(statusByThresholds(0.7, t)).toBe("bad");
  });
});

// 리포트(2026-06-02) 수치를 재현하는 입력. organic 쇼츠 13개 조회수.
const REPORT_VIEWS = [2259, 1519, 1403, 1334, 1321, 1303, 1128, 1098, 969, 912, 902, 866, 740];
function reportInput(over: Partial<DiagnosticInput> = {}): DiagnosticInput {
  const shorts = REPORT_VIEWS.map((v, i) => ({
    video_id: `v${i}`,
    title: "˚₊‧꒰ა 내부 별명 영상",   // 그룹명 0%, 장식 有
    published_at: `2026-05-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
    views: v, likes: Math.round(v * 0.06), comments: 5,
    viral_velocity_ratio: 1.1,
  }));
  return {
    group_key: "miiwan", shorts,
    groupTokens: ["미완소년", "MiiWAN"],
    subscribers: 1300, twitterHandles: [], twitterPosts: 0,
    newsCount: 13, newsCountPrev: 13, dcPosts: 38,
    memberShares: [3, 2, 2, 2, 1], now: Date.parse("2026-06-02T00:00:00Z"),
    ...over,
  };
}

describe("buildDiagnostic — 리포트 재현", () => {
  test("브레이크아웃 배율 ≈ 2.0× → bad", () => {
    const d = buildDiagnostic(reportInput());
    const k = d.dimensions.viral_physics.find((x) => x.id === "breakout_ratio")!;
    expect(k.value).toBeCloseTo(2.0, 1);
    expect(k.status).toBe("bad");
  });
  test("그룹명 커버리지 0% → bad", () => {
    const d = buildDiagnostic(reportInput());
    const k = d.dimensions.discoverability.find((x) => x.id === "group_name_coverage")!;
    expect(k.value).toBe(0);
    expect(k.status).toBe("bad");
  });
  test("장식 특수문자 100% → bad, 평균 ER ≈ 6% → good", () => {
    const d = buildDiagnostic(reportInput());
    const dec = d.dimensions.discoverability.find((x) => x.id === "decoration_ratio")!;
    expect(dec.status).toBe("bad");
    const er = d.dimensions.core_strength.find((x) => x.id === "avg_er")!;
    expect(er.status).toBe("good");
  });
  test("X 미운영 → bad", () => {
    const d = buildDiagnostic(reportInput());
    const x = d.dimensions.discovery_channels.find((y) => y.id === "x_operating")!;
    expect(x.status).toBe("bad");
    expect(x.display).toBe("미운영");
  });
  test("우선순위 TOP3 = bad KPI, 차원 우선순위 순", () => {
    const d = buildDiagnostic(reportInput());
    expect(d.priorities).toHaveLength(3);
    // viral_physics 가 가장 앞 차원이므로 breakout_ratio 가 1순위.
    expect(d.priorities[0].id).toBe("breakout_ratio");
    expect(d.priorities[0].fix.length).toBeGreaterThan(0);
  });
  test("표본 부족(n<5): 분포 KPI status=na + caveat", () => {
    const d = buildDiagnostic(reportInput({ shorts: reportInput().shorts.slice(0, 3) }));
    const k = d.dimensions.viral_physics.find((x) => x.id === "breakout_ratio")!;
    expect(k.status).toBe("na");
    expect(d.caveats.some((c) => c.includes("표본"))).toBe(true);
  });
  test("항상 식별자 caveat 포함", () => {
    const d = buildDiagnostic(reportInput());
    expect(d.caveats.some((c) => c.includes("공식 그룹명"))).toBe(true);
  });
  test("숏폼 0개 → shorts_n 0, 분포 na, 크래시 없음", () => {
    const d = buildDiagnostic(reportInput({ shorts: [] }));
    expect(d.shorts_n).toBe(0);
    expect(d.dimensions.viral_physics.every((k) => k.status === "na")).toBe(true);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test shortsDiagnostic`
Expected: FAIL — `statusByThresholds` / `buildDiagnostic` / `DiagnosticInput` 없음.

- [ ] **Step 3: 타입·상수·빌더 구현**

`frontend/functions/lib/shortsDiagnostic.ts` 끝에 추가:

```ts
export type Status = "good" | "warn" | "bad" | "na";

export interface ShortRow {
  video_id: string;
  title: string | null;
  published_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  viral_velocity_ratio: number | null;
}

export interface Kpi {
  id: string;
  label: string;
  value: number | null;
  display: string;
  status: Status;
  target: string;
  why: string;
  fix: string;
}

export interface DiagnosticInput {
  group_key: string;
  shorts: ShortRow[];
  groupTokens: string[];
  subscribers: number | null;
  twitterHandles: string[];
  twitterPosts: number | null;
  newsCount: number | null;
  newsCountPrev: number | null;
  dcPosts: number | null;
  memberShares: number[];
  now: number;
}

export interface Diagnostic {
  group_key: string;
  shorts_n: number;
  dimensions: {
    viral_physics: Kpi[];
    discoverability: Kpi[];
    core_strength: Kpi[];
    discovery_channels: Kpi[];
    operating_rhythm: Kpi[];
  };
  priorities: Array<{ id: string; label: string; display: string; fix: string }>;
  caveats: string[];
}

export interface Threshold {
  good: number;
  warn: number;
  direction: "higher" | "lower";
}

export function statusByThresholds(value: number, t: Threshold): Status {
  if (t.direction === "higher") {
    if (value >= t.good) return "good";
    if (value >= t.warn) return "warn";
    return "bad";
  }
  if (value <= t.good) return "good";
  if (value <= t.warn) return "warn";
  return "bad";
}

// 표본이 이 미만이면 분포 기반(A. 바이럴 물리) KPI 는 na 처리.
const SMALL_SAMPLE = 5;

const T = {
  breakout:   { good: 10,  warn: 3,   direction: "higher" } as Threshold,
  cv:         { good: 0.8, warn: 0.4, direction: "higher" } as Threshold,
  band:       { good: 0.4, warn: 0.7, direction: "lower"  } as Threshold,
  coverage:   { good: 80,  warn: 40,  direction: "higher" } as Threshold,
  decoration: { good: 20,  warn: 50,  direction: "lower"  } as Threshold,
  hashtag:    { good: 50,  warn: 20,  direction: "higher" } as Threshold,
  er:         { good: 4,   warn: 2,   direction: "higher" } as Threshold,
  velocity:   { good: 2,   warn: 1,   direction: "higher" } as Threshold,
};

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function buildDiagnostic(input: DiagnosticInput): Diagnostic {
  const { shorts, groupTokens, now } = input;
  const n = shorts.length;
  const small = n < SMALL_SAMPLE;
  const views = shorts.map((s) => s.views ?? 0).filter((v) => v > 0);
  const ers = shorts
    .filter((s) => (s.views ?? 0) > 0)
    .map((s) => ((s.likes ?? 0) + (s.comments ?? 0)) / (s.views as number) * 100);
  const velocities = shorts
    .map((s) => s.viral_velocity_ratio)
    .filter((v): v is number => v != null);

  // 분포 KPI 는 표본 부족 시 na.
  const distStatus = (s: Status): Status => (small || views.length === 0 ? "na" : s);

  const breakout = breakoutRatio(views);
  const cv = coefficientOfVariation(views);
  const band = bandConcentration(views);
  const med = median(views);
  const cadence = cadenceDays(
    shorts.map((s) => s.published_at).filter((p): p is string => !!p),
  );
  const hhi = normalizedHHI(input.memberShares);
  const avgVel = velocities.length ? mean(velocities) : null;

  const covGroup = coveragePct(shorts, (s) => titleHasGroupToken(s.title, groupTokens));
  const covDecor = coveragePct(shorts, (s) => titleHasDecoration(s.title));
  const covHash = coveragePct(shorts, (s) => titleHasHashtag(s.title));
  const avgLen = mean(shorts.map((s) => (s.title ?? "").length));
  const avgEr = ers.length ? mean(ers) : null;

  const xOk = input.twitterHandles.length > 0 && (input.twitterPosts ?? 0) > 0;
  const newsDelta = (input.newsCount ?? 0) - (input.newsCountPrev ?? 0);

  const dimensions: Diagnostic["dimensions"] = {
    viral_physics: [
      {
        id: "breakout_ratio", label: "브레이크아웃 배율",
        value: round(breakout), display: `${round(breakout)}×`,
        status: distStatus(statusByThresholds(breakout, T.breakout)),
        target: "≥10×",
        why: "바이럴 채널은 1편이 중앙값의 수십~수백 배로 튄다. 2× 평탄 = breakout 0건.",
        fix: "초동 속도(피크 시간 업로드+알림·커뮤니티 부스트)와 공유 유발 소재로 1편을 끝까지 밀어 콜드 피드로 진입시킨다.",
      },
      {
        id: "view_cv", label: "조회 변동계수(CV)",
        value: round(cv, 2), display: round(cv, 2).toFixed(2),
        status: distStatus(statusByThresholds(cv, T.cv)),
        target: "≥0.8",
        why: "조회가 거의 평탄(낮은 CV)하면 '같은 사람들'에게만 도달한다는 신호.",
        fix: "포맷 실험으로 분산을 키우고, 반응 좋은 1편에 초기 트래픽을 집중.",
      },
      {
        id: "band_concentration", label: "좁은 밴드 집중도",
        value: round(band * 100), display: `${round(band * 100)}%`,
        status: distStatus(statusByThresholds(band, T.band)),
        target: "<40%",
        why: "조회 92%가 좁은 밴드에 갇히면 구독자 도달 천장에 막힌 것.",
        fix: "구독 피드 밖(추천)으로 나갈 후킹·사운드·식별자를 영상에 심는다.",
      },
      {
        id: "ceiling_vs_subs", label: "천장 vs 구독자",
        value: input.subscribers ? round(med / input.subscribers, 2) : null,
        display: input.subscribers ? `중앙 ${med} / 구독 ${input.subscribers}` : "구독자 미상",
        status: "na",
        target: "—",
        why: "중앙 조회가 활성 구독자 규모에 수렴하면 추천 피드 미진입(에코챔버) 징후.",
        fix: "비구독자 완시청률을 끌어올려 추천 확장 게이트를 통과.",
      },
    ],
    discoverability: [
      {
        id: "group_name_coverage", label: "공식 그룹명 제목 커버리지",
        value: round(covGroup), display: `${round(covGroup)}%`,
        status: n === 0 ? "na" : statusByThresholds(covGroup, T.coverage),
        target: "≥80%",
        why: "제목에 그룹명이 없으면 검색·추천 매칭 단서가 없어 신규 유입 경로가 닫힌다.",
        fix: "제목 앞부분에 미완소년·MiiWAN 등 공식 식별자를 배치(곡명·본명 사전 추가 시 정밀도↑).",
      },
      {
        id: "decoration_ratio", label: "이모지·장식 특수문자 비율",
        value: round(covDecor), display: `${round(covDecor)}%`,
        status: n === 0 ? "na" : statusByThresholds(covDecor, T.decoration),
        target: "<20%",
        why: "장식 기호·이모지 과다는 검색 키워드를 밀어내고 알고리즘 분류를 방해.",
        fix: "장식은 줄이고 검색어 중심으로. 감성은 썸네일·첫 컷으로.",
      },
      {
        id: "avg_title_len", label: "평균 제목 길이",
        value: round(avgLen), display: `${round(avgLen)}자`,
        status: "na", target: "—",
        why: "지나치게 짧으면 키워드가 부족, 너무 길면 핵심이 묻힌다(해석 보조).",
        fix: "앞 15~20자에 핵심 키워드를 담는다.",
      },
      {
        id: "hashtag_pct", label: "해시태그 사용률",
        value: round(covHash), display: `${round(covHash)}%`,
        status: n === 0 ? "na" : statusByThresholds(covHash, T.hashtag),
        target: "≥50%",
        why: "해시태그는 묶음 노출·재생목록 유입 경로.",
        fix: "#미완소년 #버추얼아이돌 등 주제 태그와 시리즈명을 일관 사용.",
      },
    ],
    core_strength: [
      {
        id: "avg_er", label: "평균 ER",
        value: avgEr == null ? null : round(avgEr, 2),
        display: avgEr == null ? "—" : `${round(avgEr, 2)}%`,
        status: avgEr == null ? "na" : statusByThresholds(avgEr, T.er),
        target: "≥4%",
        why: "본 사람의 관여도. 높으면 콘텐츠 자체는 강하다는 뜻.",
        fix: "유지 — cadence·퀄리티는 그대로 두고 '바깥을 향하게' 재설계.",
      },
      {
        id: "member_hhi", label: "멤버 집중 HHI(정규화)",
        value: hhi == null ? null : round(hhi, 2),
        display: hhi == null ? "—" : round(hhi, 2).toFixed(2),
        status: "na", target: "—",
        why: "0=균등, 1=집중. 대표 얼굴 형성 정도(해석 보조).",
        fix: "대표 1인 푸시와 균등 노출 사이 전략적 선택.",
      },
      {
        id: "dc_activity", label: "DC 갤러리 활동",
        value: input.dcPosts ?? null,
        display: input.dcPosts == null ? "—" : `${input.dcPosts}건`,
        status: (input.dcPosts ?? 0) > 0 ? "good" : "na",
        target: "—",
        why: "코어 응집 장치(신규 유입구는 아님).",
        fix: "코어 담론을 신규 발견 콘텐츠로 번역해 바깥으로 확장.",
      },
    ],
    discovery_channels: [
      {
        id: "x_operating", label: "X(트위터) 운영",
        value: null, display: xOk ? "운영" : "미운영",
        status: xOk ? "good" : "bad",
        target: "운영",
        why: "글로벌·버추얼 팬덤 1차 발견·2차창작 확산 채널.",
        fix: "X 계정 개설·운영 + 숏폼 동시 배포로 외부 유입 생성.",
      },
      {
        id: "news_stall", label: "뉴스 추세",
        value: input.newsCount ?? null,
        display: input.newsCount == null ? "—" : `${input.newsCount}건 (Δ${newsDelta >= 0 ? "+" : ""}${newsDelta})`,
        status: newsDelta > 0 ? "good" : "warn",
        target: "증가",
        why: "미디어 발견 경로. 정체는 PR 동력 약화 신호.",
        fix: "데뷔 마일스톤·기획 보도자료로 기사 흐름 재가동.",
      },
    ],
    operating_rhythm: [
      {
        id: "upload_cadence", label: "업로드 간격(중앙값)",
        value: cadence || null,
        display: cadence ? `${round(cadence)}일` : "—",
        status: "na", target: "일관성",
        why: "주제·포맷·빈도가 일정해야 알고리즘이 채널 시청자상을 학습(해석 보조).",
        fix: "정기 cadence 유지 + 포맷·주제 일관, 잦은 노선 변경 지양.",
      },
      {
        id: "avg_velocity", label: "평균 24h velocity",
        value: avgVel == null ? null : round(avgVel, 2),
        display: avgVel == null ? "—" : `${round(avgVel, 2)}×`,
        status: avgVel == null ? "na" : statusByThresholds(avgVel, T.velocity),
        target: "≥2×",
        why: "업로드 직후 확산 여부. 1 미만은 채널 평균에도 못 미침.",
        fix: "피크 시간 업로드 + 초기 알림·커뮤니티 동원으로 초동 부스트.",
      },
    ],
  };

  // 우선순위: status=bad KPI 를 차원 우선순위 순으로 모아 상위 3개.
  const order: Array<keyof Diagnostic["dimensions"]> = [
    "viral_physics", "discoverability", "discovery_channels",
    "operating_rhythm", "core_strength",
  ];
  const priorities = order
    .flatMap((dim) => dimensions[dim])
    .filter((k) => k.status === "bad")
    .slice(0, 3)
    .map((k) => ({ id: k.id, label: k.label, display: k.display, fix: k.fix }));

  const caveats: string[] = ["식별자 = 공식 그룹명 기준 (곡명·본명 사전 추가 시 정밀도↑)"];
  if (small) caveats.push(`표본 ${n}편 — 분포 지표(바이럴 물리)는 방향성 참고`);

  return { group_key: input.group_key, shorts_n: n, dimensions, priorities, caveats };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test shortsDiagnostic`
Expected: PASS (전체).

- [ ] **Step 5: 커밋**

```bash
git add frontend/functions/lib/shortsDiagnostic.ts frontend/tests/lib/shortsDiagnostic.test.ts
git commit -m "feat(shorts-diagnostic): status 엔진 + buildDiagnostic 5차원 + 우선순위 + 테스트"
```

---

## Task 3: API 엔드포인트 `api/shorts-trend.ts`

**Files:**
- Create: `frontend/functions/api/shorts-trend.ts`
- Test: `frontend/tests/functions/api_shorts_trend.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/functions/api_shorts_trend.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/shorts-trend";

// SQL 문자열로 분기해 가짜 row 반환 (api_market.test.ts 패턴).
const envWith = (handler: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: handler(sql) })),
    first: vi.fn(async () => handler(sql)[0] ?? null),
  })) },
} as any);

function baseEnv(over: Partial<Record<string, any[]>> = {}) {
  return envWith((sql) => {
    if (sql.includes("FROM groups")) {
      return over.groups ?? [
        { key: "plave", name: "PLAVE", name_kr: "플레이브", context_keywords: null, twitter_handles: null },
        { key: "miiwan", name: "MiiWAN", name_kr: "미완소년",
          context_keywords: '["미완","miiwan"]', twitter_handles: "[]" },
      ];
    }
    if (sql.includes("is_short = 1") && sql.includes("!=")) {
      // 경쟁사 트렌드 숏폼
      return over.trend ?? [
        { video_id: "p1", group_key: "plave", title: "플레이브 댄스 챌린지",
          content_type: "Dance", published_at: "2026-05-30T00:00:00Z",
          views: 120000, likes: 9000, comments: 400,
          view_count_24h: 80000, viral_velocity_ratio: 4.2 },
      ];
    }
    if (sql.includes("is_short = 1") && sql.includes("= 'miiwan'")) {
      // MiiWAN 숏폼 (진단용)
      return over.miiwanShorts ?? [
        { video_id: "m1", title: "˚₊‧꒰ა 내부 별명", published_at: "2026-05-20T00:00:00Z",
          views: 1100, likes: 70, comments: 5, viral_velocity_ratio: 1.1 },
      ];
    }
    if (sql.includes("FROM agg_summary") && sql.includes("<= datetime")) {
      return over.prevSummary ?? [{ group_key: "miiwan", naver_total_news: 13 }];
    }
    if (sql.includes("FROM agg_summary")) {
      return over.summary ?? [{ group_key: "miiwan", yt_subscribers: 1300,
        twitter_posts: 0, naver_total_news: 13, dc_total_posts: 38 }];
    }
    if (sql.includes("FROM agg_member_popularity")) {
      return over.members ?? [{ composite_score: 3 }, { composite_score: 2 }, { composite_score: 1 }];
    }
    return [];
  });
}

describe("/api/shorts-trend", () => {
  it("트렌드·그룹·진단을 한 번에 반환", async () => {
    const res = await onRequestGet({ env: baseEnv(), request: new Request("https://x/api/shorts-trend") } as any);
    const body = await res.json() as any;
    expect(body.trend).toHaveLength(1);
    expect(body.trend[0].group_name_kr).toBe("플레이브");
    expect(body.groups.some((g: any) => g.key === "plave")).toBe(true);
    expect(body.diagnostic.group_key).toBe("miiwan");
    expect(body.diagnostic.dimensions.discoverability.length).toBeGreaterThan(0);
  });

  it("MiiWAN 은 트렌드(경쟁사) 목록에서 제외", async () => {
    const res = await onRequestGet({ env: baseEnv(), request: new Request("https://x/api/shorts-trend") } as any);
    const body = await res.json() as any;
    expect(body.trend.every((r: any) => r.group_key !== "miiwan")).toBe(true);
  });

  it("MiiWAN 숏폼 0개여도 진단은 반환(크래시 없음)", async () => {
    const res = await onRequestGet({
      env: baseEnv({ miiwanShorts: [] }),
      request: new Request("https://x/api/shorts-trend"),
    } as any);
    const body = await res.json() as any;
    expect(body.diagnostic.shorts_n).toBe(0);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test api_shorts_trend`
Expected: FAIL — `functions/api/shorts-trend.ts` 없음.

- [ ] **Step 3: 엔드포인트 구현**

`frontend/functions/api/shorts-trend.ts`:

```ts
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";
import {
  buildDiagnostic, groupNameVariants,
  type ShortRow, type DiagnosticInput,
} from "../lib/shortsDiagnostic";

const SELF_KEY = "miiwan";
const WINDOW_DAYS = 90;
const TREND_LIMIT = 400;

interface GroupRow {
  key: string; name: string; name_kr: string;
  context_keywords: string | null; twitter_handles: string | null;
}
interface TrendRow {
  video_id: string; group_key: string; title: string | null;
  content_type: string | null; published_at: string | null;
  views: number | null; likes: number | null; comments: number | null;
  view_count_24h: number | null; viral_velocity_ratio: number | null;
}
interface SummaryRow {
  group_key: string; yt_subscribers: number | null; twitter_posts: number | null;
  naver_total_news: number | null; dc_total_posts: number | null;
}

const parseJsonArr = (s: string | null): string[] => {
  try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
};

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  // 최신 stat 1건을 video 당 join 하기 위한 상관 서브쿼리.
  const latestStat = `
    (SELECT views FROM youtube_video_stats WHERE video_id = v.video_id
      ORDER BY snapshot_at DESC LIMIT 1) AS views,
    (SELECT likes FROM youtube_video_stats WHERE video_id = v.video_id
      ORDER BY snapshot_at DESC LIMIT 1) AS likes,
    (SELECT comments FROM youtube_video_stats WHERE video_id = v.video_id
      ORDER BY snapshot_at DESC LIMIT 1) AS comments`;

  const groups = await d1Query<GroupRow>(env.DB,
    `SELECT key, name, name_kr, context_keywords, twitter_handles
       FROM groups WHERE is_active = 1`);
  const nameByKey: Record<string, string> = {};
  for (const g of groups) nameByKey[g.key] = g.name_kr || g.name;

  // 경쟁사(=MiiWAN 제외) 숏폼, 최근 90일.
  const trendRows = await d1Query<TrendRow>(env.DB,
    `SELECT v.video_id, v.group_key, v.title, v.content_type, v.published_at,
            v.view_count_24h, v.viral_velocity_ratio, ${latestStat}
       FROM youtube_videos v
      WHERE v.is_short = 1 AND v.group_key != ?
        AND v.published_at >= datetime('now', ?)
      ORDER BY v.published_at DESC
      LIMIT ?`,
    [SELF_KEY, `-${WINDOW_DAYS} days`, TREND_LIMIT]);

  const trend = trendRows.map((r) => ({ ...r, group_name_kr: nameByKey[r.group_key] ?? r.group_key }));

  // MiiWAN 숏폼 전체 (진단용 — 90일 제한 없음, 표본 확보).
  const miiwanShorts = await d1Query<ShortRow>(env.DB,
    `SELECT v.video_id, v.title, v.published_at, v.viral_velocity_ratio, ${latestStat}
       FROM youtube_videos v
      WHERE v.is_short = 1 AND v.group_key = ?`,
    [SELF_KEY]);

  const summaryNow = await d1Query<SummaryRow>(env.DB,
    `SELECT group_key, yt_subscribers, twitter_posts, naver_total_news, dc_total_posts
       FROM agg_summary
      WHERE group_key = ?
      ORDER BY snapshot_at DESC LIMIT 1`, [SELF_KEY]);
  const summaryPrev = await d1Query<{ group_key: string; naver_total_news: number | null }>(env.DB,
    `SELECT group_key, naver_total_news
       FROM agg_summary
      WHERE group_key = ? AND snapshot_at <= datetime('now', '-7 days')
      ORDER BY snapshot_at DESC LIMIT 1`, [SELF_KEY]);
  const members = await d1Query<{ composite_score: number | null }>(env.DB,
    `SELECT composite_score FROM agg_member_popularity
      WHERE group_key = ?
        AND snapshot_at = (SELECT MAX(snapshot_at) FROM agg_member_popularity WHERE group_key = ?)`,
    [SELF_KEY, SELF_KEY]);

  const self = groups.find((g) => g.key === SELF_KEY);
  const s = summaryNow[0];
  const input: DiagnosticInput = {
    group_key: SELF_KEY,
    shorts: miiwanShorts,
    groupTokens: self
      ? groupNameVariants(self.name, self.name_kr, parseJsonArr(self.context_keywords))
      : [SELF_KEY],
    subscribers: s?.yt_subscribers ?? null,
    twitterHandles: self ? parseJsonArr(self.twitter_handles) : [],
    twitterPosts: s?.twitter_posts ?? null,
    newsCount: s?.naver_total_news ?? null,
    newsCountPrev: summaryPrev[0]?.naver_total_news ?? null,
    dcPosts: s?.dc_total_posts ?? null,
    memberShares: members.map((m) => m.composite_score ?? 0),
    now: Date.now(),
  };

  return jsonResponse({
    generated_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    limit: TREND_LIMIT,
    trend,
    groups: groups.filter((g) => g.key !== SELF_KEY).map((g) => ({ key: g.key, name_kr: g.name_kr })),
    diagnostic: buildDiagnostic(input),
  });
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test api_shorts_trend`
Expected: PASS (3 it 블록).

- [ ] **Step 5: 커밋**

```bash
git add frontend/functions/api/shorts-trend.ts frontend/tests/functions/api_shorts_trend.test.ts
git commit -m "feat(shorts-trend): /api/shorts-trend — 경쟁사 트렌드 + MiiWAN 진단 단일 응답"
```

---

## Task 4: 트렌드 랭킹·신선도 클라이언트 헬퍼

**Files:**
- Create: `frontend/src/lib/shortsTrend.ts`
- Test: `frontend/tests/lib/shortsTrend.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`frontend/tests/lib/shortsTrend.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  daysSince, isFresh, velocityEligible, sortShorts,
  FRESH_DAYS, FRESH_VELOCITY, MIN_VIEWS_FLOOR, type TrendShort,
} from "../../src/lib/shortsTrend";

const NOW = Date.parse("2026-06-02T00:00:00Z");

function row(over: Partial<TrendShort>): TrendShort {
  return {
    video_id: "x", group_key: "plave", group_name_kr: "플레이브",
    title: "t", content_type: "Dance", published_at: "2026-05-30T00:00:00Z",
    views: 100000, likes: 0, comments: 0,
    view_count_24h: 50000, viral_velocity_ratio: 3.0, ...over,
  };
}

describe("daysSince", () => {
  test("UTC ISO 와 SQLite 공백 포맷 모두 처리", () => {
    expect(daysSince("2026-05-30T00:00:00Z", NOW)).toBe(3);
    expect(daysSince("2026-05-30 00:00:00", NOW)).toBe(3);
    expect(daysSince(null, NOW)).toBeNull();
  });
});

describe("isFresh", () => {
  test("최근 + 고velocity → true", () => {
    expect(isFresh(row({ published_at: "2026-05-30T00:00:00Z", viral_velocity_ratio: 2.5 }), NOW)).toBe(true);
  });
  test("오래됨 → false", () => {
    expect(isFresh(row({ published_at: "2026-04-01T00:00:00Z", viral_velocity_ratio: 9 }), NOW)).toBe(false);
  });
  test("velocity 낮음 → false", () => {
    expect(isFresh(row({ viral_velocity_ratio: 1.0 }), NOW)).toBe(false);
  });
});

describe("velocityEligible — 노이즈 floor", () => {
  test("floor 미만 조회 → 제외", () => {
    expect(velocityEligible(row({ views: MIN_VIEWS_FLOOR - 1 }))).toBe(false);
    expect(velocityEligible(row({ views: MIN_VIEWS_FLOOR }))).toBe(true);
    expect(velocityEligible(row({ viral_velocity_ratio: null }))).toBe(false);
  });
});

describe("sortShorts", () => {
  const fresh = row({ video_id: "fresh", published_at: "2026-05-30T00:00:00Z", viral_velocity_ratio: 5, views: 100000 });
  const old = row({ video_id: "old", published_at: "2026-04-01T00:00:00Z", viral_velocity_ratio: 9, views: 100000 });
  const tiny = row({ video_id: "tiny", views: 100, viral_velocity_ratio: 50 });

  test("fresh 정렬: 신선 영상이 위로", () => {
    const out = sortShorts([old, fresh], "fresh", NOW);
    expect(out[0].video_id).toBe("fresh");
  });
  test("velocity 정렬: floor 미만(tiny)은 뒤로", () => {
    const out = sortShorts([tiny, fresh], "velocity", NOW);
    expect(out[0].video_id).toBe("fresh");
    expect(out[1].video_id).toBe("tiny");
  });
  test("views 정렬 내림차순", () => {
    const a = row({ video_id: "a", views: 10 });
    const b = row({ video_id: "b", views: 999 });
    expect(sortShorts([a, b], "views", NOW)[0].video_id).toBe("b");
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm test shortsTrend`
Expected: FAIL — `src/lib/shortsTrend.ts` 없음.

- [ ] **Step 3: 헬퍼 구현**

`frontend/src/lib/shortsTrend.ts`:

```ts
// 경쟁사 숏폼 트렌드 랭킹·신선도 — 클라이언트 순수 헬퍼.
// 설계: docs/superpowers/specs/2026-06-02-shorts-trend-and-miiwan-diagnostic-design.md
export const FRESH_DAYS = 14;        // 신선도 윈도우
export const FRESH_VELOCITY = 2.0;   // 🔥 배지 최소 velocity
export const MIN_VIEWS_FLOOR = 5000; // velocity 랭킹 노이즈 floor

export interface TrendShort {
  video_id: string;
  group_key: string;
  group_name_kr: string;
  title: string | null;
  content_type: string | null;
  published_at: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  view_count_24h: number | null;
  viral_velocity_ratio: number | null;
}

export type TrendSort = "fresh" | "velocity" | "views" | "recent";

export function daysSince(publishedAt: string | null, now: number): number | null {
  if (!publishedAt) return null;
  let s = publishedAt.trim();
  if (s.includes(" ") && !s.includes("T")) s = s.replace(" ", "T");
  if (!/[Z+]|[+-]\d\d:?\d\d$/.test(s)) s += "Z";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

export function isFresh(s: TrendShort, now: number): boolean {
  const d = daysSince(s.published_at, now);
  return d != null && d <= FRESH_DAYS
    && s.viral_velocity_ratio != null && s.viral_velocity_ratio >= FRESH_VELOCITY;
}

export function velocityEligible(s: TrendShort): boolean {
  return (s.views ?? 0) >= MIN_VIEWS_FLOOR && s.viral_velocity_ratio != null;
}

export function sortShorts(rows: TrendShort[], sort: TrendSort, now: number): TrendShort[] {
  const out = [...rows];
  if (sort === "recent") {
    return out.sort((a, b) => (daysSince(a.published_at, now) ?? 1e9) - (daysSince(b.published_at, now) ?? 1e9));
  }
  if (sort === "views") {
    return out.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  }
  if (sort === "velocity") {
    // floor 미만/측정불가는 맨 뒤. 그 안에서 velocity 내림차순.
    return out.sort((a, b) => {
      const ea = velocityEligible(a), eb = velocityEligible(b);
      if (ea !== eb) return ea ? -1 : 1;
      return (b.viral_velocity_ratio ?? -1) - (a.viral_velocity_ratio ?? -1);
    });
  }
  // "fresh": 신선 영상 먼저, 그 안에서 velocity 내림차순.
  return out.sort((a, b) => {
    const fa = isFresh(a, now), fb = isFresh(b, now);
    if (fa !== fb) return fa ? -1 : 1;
    return (b.viral_velocity_ratio ?? -1) - (a.viral_velocity_ratio ?? -1);
  });
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm test shortsTrend`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/shortsTrend.ts frontend/tests/lib/shortsTrend.test.ts
git commit -m "feat(shorts-trend): 클라이언트 랭킹·신선도 헬퍼 + 테스트"
```

---

## Task 5: 배선 — api.ts / router / Header / App

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/router.ts:2`
- Modify: `frontend/src/components/Header.tsx:9-14`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: api.ts 클라이언트 메서드 추가**

`frontend/src/api.ts` 의 `search:` 줄 바로 위(또는 `healthSpec:` 근처)에 추가:

```ts
  shortsTrend: () => getJson<any>("/api/shorts-trend"),
```

- [ ] **Step 2: router.ts tab union 확장**

`frontend/src/router.ts:2` 의 `tab` 타입에 `"shorts"` 추가:

```ts
  tab: "market" | "weekly" | "content" | "members" | "community" | "risk" | "insights" | "miiwan" | "shorts";
```

- [ ] **Step 3: Header 네비 항목 추가**

`frontend/src/components/Header.tsx` 의 `MARKET_TABS` 배열에 항목 추가 (insights 와 miiwan 사이):

```ts
const MARKET_TABS: Array<[RouterState["tab"], string]> = [
  ["market",   "시장 개요"],
  ["weekly",   "주간 업데이트"],
  ["insights", "인사이트"],
  ["shorts",   "숏폼 트렌드"],
  ["miiwan",   "MiiWAN"],
];
```

- [ ] **Step 4: App.tsx 렌더 분기 추가**

`frontend/src/App.tsx` 상단 import 에 추가:

```ts
import { ShortsTrend } from "./views/ShortsTrend";
```

그리고 `{state.tab === "miiwan" && <MiiWANBriefing />}` 줄 아래에 추가:

```tsx
        {state.tab === "shorts"    && <ShortsTrend />}
```

- [ ] **Step 5: 타입체크 (뷰는 Task 8 에서 생성되므로 import 만으로는 실패 — 빈 stub 우선 생성)**

이 시점엔 `ShortsTrend` 가 없어 타입체크가 깨진다. 임시 stub 을 만들어 배선만 검증한다:

`frontend/src/views/ShortsTrend.tsx` (stub — Task 8 에서 본 구현으로 대체):

```tsx
export function ShortsTrend() {
  return <div class="p-4 text-zinc-400">숏폼 트렌드 (구현 예정)</div>;
}
```

Run: `pnpm typecheck`
Expected: PASS (에러 0).

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/api.ts frontend/src/router.ts frontend/src/components/Header.tsx frontend/src/App.tsx frontend/src/views/ShortsTrend.tsx
git commit -m "feat(shorts-trend): 라우팅·네비·API 클라이언트 배선 + 뷰 stub"
```

---

## Task 6: 진단 패널 컴포넌트 `MiiwanShortsDiagnostic.tsx`

**Files:**
- Create: `frontend/src/components/MiiwanShortsDiagnostic.tsx`

진단 객체(Task 2 의 `Diagnostic` JSON 형태)를 props 로 받아 렌더한다. API 응답을 그대로 쓰므로 타입을 로컬에 재정의(프런트는 functions/lib 를 import 하지 않음 — 빌드 경계 분리).

- [ ] **Step 1: 컴포넌트 구현**

`frontend/src/components/MiiwanShortsDiagnostic.tsx`:

```tsx
import { useState } from "preact/hooks";

type Status = "good" | "warn" | "bad" | "na";
interface Kpi {
  id: string; label: string; value: number | null; display: string;
  status: Status; target: string; why: string; fix: string;
}
export interface DiagnosticData {
  group_key: string;
  shorts_n: number;
  dimensions: {
    viral_physics: Kpi[]; discoverability: Kpi[]; core_strength: Kpi[];
    discovery_channels: Kpi[]; operating_rhythm: Kpi[];
  };
  priorities: Array<{ id: string; label: string; display: string; fix: string }>;
  caveats: string[];
}

const STATUS_COLOR: Record<Status, string> = {
  good: "#22c55e", warn: "#eab308", bad: "#ef4444", na: "#6b7280",
};
const DIM_LABEL: Record<string, string> = {
  viral_physics: "바이럴 물리", discoverability: "발견 가능성",
  core_strength: "코어 강도", discovery_channels: "발견 채널",
  operating_rhythm: "운영 리듬",
};

// 숏폼 알고리즘 7 레버 (리포트 9p evergreen).
const LEVERS: Array<[string, string]> = [
  ["① 첫 1~3초 후킹", "강한 첫 컷(질문·반전·시각 충격). 인트로·로고 제거."],
  ["② 시청 지속·재시청", "짧게, 군더더기 컷 삭제, 끝→처음 루프 설계."],
  ["③ 검색·분류 메타데이터", "제목 앞 검색어(그룹명·곡명·본명) + 설명·해시태그."],
  ["④ 트렌딩 사운드", "상승 중 사운드 빠르게 차용, 챌린지·밈에 얹기."],
  ["⑤ 초동 속도", "피크 시간 업로드 + 알림·커뮤니티 초기 부스트."],
  ["⑥ 공유·외부 유입", "공유 욕구 소재 + X·커뮤니티 동시 배포."],
  ["⑦ 업로드 일관성", "정기 cadence + 포맷·주제 일관."],
];
// 플랫폼별 전략 (리포트 10p evergreen).
const PLATFORMS: Array<[string, string]> = [
  ["YouTube", "검색 SEO — 제목 앞 키워드, 롱폼 자산화, 자막·챕터."],
  ["TikTok", "FYP·트렌딩 사운드·첫 2초·글로벌(동남아·일본) 도달."],
  ["IG Reels", "비주얼·세계관·저장 유발, 그리드 일관성."],
];

function KpiCell({ k }: { k: Kpi }) {
  return (
    <div class="rounded-ctrl border border-zinc-800 p-3" title={`${k.why}\n\n처방: ${k.fix}`}>
      <div class="flex items-center justify-between">
        <span class="text-hint text-zinc-400">{k.label}</span>
        <span class="inline-block h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[k.status] }} />
      </div>
      <div class="mt-1 text-lg font-bold tabular-nums">{k.display}</div>
      <div class="text-hint text-zinc-600">목표 {k.target}</div>
    </div>
  );
}

export function MiiwanShortsDiagnostic({ data }: { data: DiagnosticData }) {
  const [showPlaybook, setShowPlaybook] = useState(false);
  const dims = data.dimensions;

  return (
    <section class="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-lg font-bold">MiiWAN 숏츠 운영 진단</h2>
        <span class="text-hint text-zinc-500">숏폼 {data.shorts_n}편 기준</span>
      </div>

      {data.shorts_n === 0 ? (
        <p class="text-zinc-400">숏폼 데이터가 아직 없습니다.</p>
      ) : (
        <>
          {/* 우선순위 TOP 3 */}
          {data.priorities.length > 0 && (
            <div class="mb-4 rounded-ctrl border border-red-900/50 bg-red-950/20 p-3">
              <div class="mb-2 font-semibold text-red-300">🔴 지금 우선순위 TOP {data.priorities.length}</div>
              <ol class="space-y-1.5">
                {data.priorities.map((p, i) => (
                  <li key={p.id} class="text-data">
                    <span class="font-semibold">{i + 1}. {p.label}</span>
                    <span class="text-zinc-500"> ({p.display})</span>
                    <span class="text-zinc-400"> — {p.fix}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* 5차원 KPI 그리드 */}
          <div class="space-y-3">
            {(Object.keys(dims) as Array<keyof typeof dims>).map((key) => (
              <div key={key}>
                <div class="mb-1.5 text-hint font-semibold uppercase tracking-wide text-zinc-500">
                  {DIM_LABEL[key]}
                </div>
                <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {dims[key].map((k) => <KpiCell key={k.id} k={k} />)}
                </div>
              </div>
            ))}
          </div>

          {/* caveats */}
          <ul class="mt-3 space-y-0.5">
            {data.caveats.map((c) => (
              <li key={c} class="text-hint text-zinc-600">· {c}</li>
            ))}
          </ul>
        </>
      )}

      {/* 플레이북 (접기) */}
      <button
        class="mt-4 text-data text-brand-fg hover:underline"
        onClick={() => setShowPlaybook((v) => !v)}
      >
        📘 숏폼 알고리즘 플레이북 {showPlaybook ? "▲" : "▼"}
      </button>
      {showPlaybook && (
        <div class="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <div class="mb-1.5 text-hint font-semibold text-zinc-400">알고리즘 7 레버</div>
            <ul class="space-y-1">
              {LEVERS.map(([t, d]) => (
                <li key={t} class="text-hint">
                  <span class="font-semibold text-zinc-300">{t}</span>
                  <span class="text-zinc-500"> — {d}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div class="mb-1.5 text-hint font-semibold text-zinc-400">플랫폼별 전략</div>
            <ul class="space-y-1">
              {PLATFORMS.map(([t, d]) => (
                <li key={t} class="text-hint">
                  <span class="font-semibold text-zinc-300">{t}</span>
                  <span class="text-zinc-500"> — {d}</span>
                </li>
              ))}
            </ul>
            <p class="mt-2 text-hint text-zinc-600">원본 1개 → 플랫폼별 3벌 리퍼포징(워터마크 제거·세로 풀스크린·캡션 교체).</p>
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: 타입체크**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/components/MiiwanShortsDiagnostic.tsx
git commit -m "feat(shorts-diagnostic): MiiWAN 진단 패널 컴포넌트 (5차원 + 우선순위 + 플레이북)"
```

---

## Task 7: 트렌드 테이블 컴포넌트 `ShortsTrendTable.tsx`

**Files:**
- Create: `frontend/src/components/ShortsTrendTable.tsx`

- [ ] **Step 1: 컴포넌트 구현**

`frontend/src/components/ShortsTrendTable.tsx`:

```tsx
import { useMemo, useState } from "preact/hooks";
import { fmt, pct } from "../format";
import {
  sortShorts, isFresh, daysSince,
  type TrendShort, type TrendSort,
} from "../lib/shortsTrend";

const SORT_LABEL: Record<TrendSort, string> = {
  fresh: "신선 우선", velocity: "velocity", views: "조회수", recent: "최신순",
};

function erOf(s: TrendShort): number | null {
  if (!s.views) return null;
  return ((s.likes ?? 0) + (s.comments ?? 0)) / s.views * 100;
}

function velocityDisplay(s: TrendShort, now: number): string {
  if (s.viral_velocity_ratio != null) return `${s.viral_velocity_ratio.toFixed(1)}×`;
  const d = daysSince(s.published_at, now);
  return d != null && d < 2 ? "측정중" : "—";
}

export function ShortsTrendTable(
  { rows, groups, windowDays, limit }:
  { rows: TrendShort[]; groups: Array<{ key: string; name_kr: string }>;
    windowDays: number; limit: number },
) {
  const now = Date.now();
  const [sort, setSort] = useState<TrendSort>("fresh");
  const [group, setGroup] = useState<string>("all");
  const [type, setType] = useState<string>("all");
  const [freshOnly, setFreshOnly] = useState(false);

  const contentTypes = useMemo(
    () => Array.from(new Set(rows.map((r) => r.content_type).filter((x): x is string => !!x))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    let r = rows;
    if (group !== "all") r = r.filter((x) => x.group_key === group);
    if (type !== "all") r = r.filter((x) => x.content_type === type);
    if (freshOnly) r = r.filter((x) => isFresh(x, now));
    return sortShorts(r, sort, now);
  }, [rows, group, type, freshOnly, sort, now]);

  return (
    <section>
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <h2 class="text-lg font-bold">경쟁사 숏폼 트렌드</h2>
        <span class="text-hint text-zinc-500">최근 {windowDays}일 · 최대 {limit}편</span>
      </div>

      <div class="mb-3 flex flex-wrap gap-2 text-data">
        <select class="rounded-ctrl border border-zinc-800 bg-zinc-900 px-2 py-1"
          value={group} onChange={(e) => setGroup((e.target as HTMLSelectElement).value)}>
          <option value="all">전체 그룹</option>
          {groups.map((g) => <option key={g.key} value={g.key}>{g.name_kr}</option>)}
        </select>
        <select class="rounded-ctrl border border-zinc-800 bg-zinc-900 px-2 py-1"
          value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
          <option value="all">전체 타입</option>
          {contentTypes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select class="rounded-ctrl border border-zinc-800 bg-zinc-900 px-2 py-1"
          value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as TrendSort)}>
          {(Object.keys(SORT_LABEL) as TrendSort[]).map((k) => (
            <option key={k} value={k}>{SORT_LABEL[k]}</option>
          ))}
        </select>
        <label class="flex items-center gap-1.5 text-zinc-400">
          <input type="checkbox" checked={freshOnly}
            onChange={(e) => setFreshOnly((e.target as HTMLInputElement).checked)} />
          🔥 신선만
        </label>
      </div>

      {filtered.length === 0 ? (
        <p class="text-zinc-400">최근 {windowDays}일 내 경쟁사 숏폼이 없습니다.</p>
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full text-data">
            <thead class="text-hint uppercase text-zinc-500">
              <tr>
                <th class="px-2 py-1.5 text-left"></th>
                <th class="px-2 py-1.5 text-left">그룹</th>
                <th class="px-2 py-1.5 text-left">제목</th>
                <th class="px-2 py-1.5 text-left">타입</th>
                <th class="px-2 py-1.5 text-right">게시</th>
                <th class="px-2 py-1.5 text-right">조회수</th>
                <th class="px-2 py-1.5 text-right">24h</th>
                <th class="px-2 py-1.5 text-right">velocity</th>
                <th class="px-2 py-1.5 text-right">ER</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const d = daysSince(s.published_at, now);
                return (
                  <tr key={s.video_id} class="border-t border-zinc-800/60">
                    <td class="px-2 py-1.5">{isFresh(s, now) ? "🔥" : ""}</td>
                    <td class="px-2 py-1.5 text-zinc-400">{s.group_name_kr}</td>
                    <td class="px-2 py-1.5">
                      <a class="hover:underline" target="_blank" rel="noreferrer"
                        href={`https://www.youtube.com/shorts/${s.video_id}`}>
                        {s.title ?? "(제목 없음)"}
                      </a>
                    </td>
                    <td class="px-2 py-1.5 text-zinc-500">{s.content_type ?? "—"}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums text-zinc-400">
                      {d == null ? "—" : `${d}일 전`}
                    </td>
                    <td class="px-2 py-1.5 text-right tabular-nums">{fmt(s.views)}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums text-zinc-400">{fmt(s.view_count_24h)}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums font-semibold">{velocityDisplay(s, now)}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums text-zinc-400">{pct(erOf(s))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: 타입체크**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/components/ShortsTrendTable.tsx
git commit -m "feat(shorts-trend): 경쟁사 트렌드 테이블 컴포넌트 (필터·정렬·🔥 배지)"
```

---

## Task 8: 뷰 조립 `ShortsTrend.tsx` + 최종 검증

**Files:**
- Modify: `frontend/src/views/ShortsTrend.tsx` (Task 5 stub 대체)

- [ ] **Step 1: 뷰 본 구현으로 stub 교체**

`frontend/src/views/ShortsTrend.tsx` 전체 내용을 교체:

```tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { MiiwanShortsDiagnostic, type DiagnosticData } from "../components/MiiwanShortsDiagnostic";
import { ShortsTrendTable } from "../components/ShortsTrendTable";
import type { TrendShort } from "../lib/shortsTrend";

interface Payload {
  window_days: number;
  limit: number;
  trend: TrendShort[];
  groups: Array<{ key: string; name_kr: string }>;
  diagnostic: DiagnosticData;
}

export function ShortsTrend() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.shortsTrend().then(setData).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div class="p-4 text-red-400">불러오기 실패: {err}</div>;
  if (!data) return <div class="p-4 text-zinc-500">불러오는 중…</div>;

  return (
    <div>
      <MiiwanShortsDiagnostic data={data.diagnostic} />
      <ShortsTrendTable
        rows={data.trend}
        groups={data.groups}
        windowDays={data.window_days}
        limit={data.limit}
      />
    </div>
  );
}
```

- [ ] **Step 2: 전체 테스트 + 타입체크 + 빌드**

Run: `pnpm test`
Expected: PASS (기존 + 신규 shortsDiagnostic / shortsTrend / api_shorts_trend 전부).

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm build`
Expected: 빌드 성공 (tsc + vite).

- [ ] **Step 3: 로컬 수동 검증 (선택, D1 로컬 데이터 있을 때)**

Run: `pnpm dev` 후 브라우저에서 `#tab=shorts` 로 이동.
확인 항목:
- 상단 진단 패널: 우선순위 TOP 3, 5차원 KPI 적·노·초, caveats, 플레이북 토글.
- 하단 트렌드 테이블: 그룹/타입/정렬 필터, 🔥 배지, 제목 클릭 → YouTube Shorts 새 탭.
- MiiWAN 이 트렌드 테이블에 안 보이는지(경쟁사만).

(원격 D1 검증은 운영자 직접 실행 영역 — 배포 후 확인.)

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/views/ShortsTrend.tsx
git commit -m "feat(shorts-trend): ShortsTrend 뷰 — 진단 패널 + 트렌드 테이블 조립"
```

---

## Self-Review 결과 (작성자 체크)

**Spec 커버리지:**
- 기능 1 트렌드 테이블(4.1~4.4) → Task 3(API)·4(헬퍼)·7(테이블)·8(뷰). ✓
- 기능 2 진단 패널 5차원·우선순위·플레이북(5.1~5.3) → Task 1·2(계산)·3(API 배선)·6(패널). ✓
- 정직성/한계(5.4): 식별자 caveat·표본부족 na·thresholds 상수 → Task 2 구현·테스트. ✓
- API 계약(6): `{ diagnostic, trend, groups }` → Task 3. ✓
- 배선(7): router/App/Header/api.ts → Task 5. ✓
- 에러 처리(8): velocity NULL "측정중"/"—"(Task 7), 빈 결과(Task 7), 숏폼 0개(Task 6·3 테스트), HHI 없음 graceful(Task 2 normalizedHHI null). ✓
- 테스트(9): lib·functions vitest, 컴포넌트는 typecheck+수동(관례). ✓

**Placeholder 스캔:** 모든 코드 스텝에 실제 코드 포함, TBD/TODO 없음. ✓

**타입 일관성:** `ShortRow`/`DiagnosticInput`/`Diagnostic`/`Kpi`/`Status`(Task 1·2) ↔ API import(Task 3) ↔ 프런트 로컬 재정의 `DiagnosticData`(Task 6, 동일 형태) ↔ `TrendShort`/`TrendSort`(Task 4) ↔ 테이블·뷰(Task 7·8). `buildDiagnostic`/`groupNameVariants`/`sortShorts`/`isFresh`/`daysSince`/`velocityEligible` 시그니처 전 Task 일치. ✓
- 주의: 프런트(`src/`)는 `functions/lib/` 를 import 하지 않고 `DiagnosticData` 를 로컬 재정의한다(Vite/Pages 빌드 경계 분리). API JSON 형태와 1:1 동일하게 유지할 것.
