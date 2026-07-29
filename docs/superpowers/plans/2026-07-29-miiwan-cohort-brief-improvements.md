# MiiWAN 동시기 성과(브리프 탭) 개선 4건 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MiiWAN 개요(브리프 탭)의 동시기 성과 섹션에서 ① 성장의 질 산점도에 데뷔 전(D-30~) 성장 반영, ② 광고 의심 판정을 "과다 사용 팀만" 걸리도록 재보정, ③ 팀별 상세표에 데뷔 전 값 컬럼 추가, ④ 자연 유입 점수 막대를 읽을 수 있게 재설계.

**Architecture:** 광고 의심 임계는 `cohortHeadline.ts`의 상수 1곳만 바꾸면 4개 소비처(곡선·표 배지·산점도·헤드라인)가 함께 따라온다. 데뷔 전 앵커·총 성장배수는 `functions/lib/cohortReport.ts`에 순수 함수로 추가하고 API 응답(`ScorecardRow`)에 실어 프런트가 소비한다. 막대 재설계는 컴포넌트 JSX만 바꾸되 등급 경계·색은 `organicity.ts` 단일 원천을 재사용한다.

**Tech Stack:** Preact + Chart.js 4 (프런트), Cloudflare Pages Functions + D1 (API), vitest (테스트), pnpm.

## Global Constraints

- 패키지 매니저 **pnpm**, 작업 디렉터리 `frontend/`. 테스트 `pnpm vitest run`, 타입 체크 `pnpm typecheck`(= `tsc -b --noEmit`), 빌드 `pnpm build`.
- **가짜 수치 금지**: 값이 없는 팀은 합성하지 않고 제외 + 사유 공시. 측정일이 목표일과 다르면 화면에 밝힌다(기존 `measuredOn`/`base_day` 패턴).
- **임계값 하드카피 금지**: 광고 의심 판정 숫자는 `ORG_AD_SUSPECT_THRESHOLD` 상수 참조만. 등급 경계·색은 `src/lib/organicity.ts`(`VERDICT_THRESHOLDS`/`VERDICT_COLOR`)에서만 가져온다.
- **카피 원칙**: 읽는 사람은 투자사·경영진. "코호트/유기성/인덱스/스냅샷/허용폭" 같은 내부 용어를 화면 문구에 쓰지 않는다 (`MiiWANCohortReport.tsx:23-27` 주석 참조).
- 워커(`worker/`)·다른 유기성 화면(`CompetitorOrganicityBar` 등)·`VERDICT_THRESHOLDS` 자체는 건드리지 않는다.
- 커밋은 태스크당 1개, 기존 스타일(`feat(cohort-ui): …` / `feat(cohort-api): …`, 한국어 요약) 유지.
- 기존 코드의 주석 밀도·톤(왜-중심 한국어 주석)을 따른다.

## 배경 데이터 (2026-07-29 원격 D1 실측 — 계획 근거)

판정점수 = min(편수 기준, 조회수 기준), API와 동일 가중 집계:

| 그룹 | 편수 기준 | 조회수 기준 | 판정(min) |
|---|---|---|---|
| bdawn | 72.7 | 37.4 | **37.4** |
| bthd | 49.5 | 45.6 | 45.6 |
| miiwan | 74.0 | 41.4 | 41.4 |
| myrakl | 65.2 | 29.8 | **29.8** |
| owis | 79.1 | 46.7 | 46.7 |
| plave(참조) | 70.9 | 58.9 | 58.9 |
| skinz | 66.0 | 43.6 | 43.6 |

→ 현행 임계 70(organic 컷)이면 **참조 PLAVE 포함 전원 "광고 의심"** — 배지가 정보를 잃는다. 임계를 `VERDICT_THRESHOLDS.suspect`(40, 그 미만 = likely_paid 티어)로 내리면 myrakl·bdawn만 걸린다.

D-30±7 구간 구독자 데이터: miiwan(live)·owis·bdawn·skinz·plave 존재, **bthd는 D-21부터**(56행), **myrakl은 데뷔 전 전무**.

---

### Task 1: 광고 의심 임계 재보정 (요청 2)

**Files:**
- Modify: `frontend/src/lib/cohortHeadline.ts:72-82` (상수 + 주석)
- Test: `frontend/tests/lib/cohortHeadline.test.ts`, `frontend/tests/lib/cohortQuality.test.ts`

**Interfaces:**
- Produces: `ORG_AD_SUSPECT_THRESHOLD === VERDICT_THRESHOLDS.suspect` (=40). 4개 소비처(곡선 `MiiWANCohortReport.tsx:164-167`, 표 배지 `:640-643`, 산점도 `cohortQuality.ts:127,140,143`, 헤드라인)는 상수 참조라 코드 수정 불필요 — 테스트 기대값만 갱신.

- [ ] **Step 1: 가드 테스트 추가 (실패 확인)**

`frontend/tests/lib/cohortHeadline.test.ts`에 추가:

```ts
import { VERDICT_THRESHOLDS } from "../../src/lib/organicity";

describe("ORG_AD_SUSPECT_THRESHOLD", () => {
  it("과다 사용 티어(suspect 컷) 미만만 광고 의심으로 본다", () => {
    // 2026-07-29 실측: min 판정점수가 전 그룹 29.8~58.9라 organic(70) 컷은
    // 참조 PLAVE까지 전원을 걸어 배지가 정보를 잃었다. suspect(40) 컷이면
    // 뚜렷한 하위 2팀(myrakl 29.8 · bdawn 37.4)만 남는다.
    expect(ORG_AD_SUSPECT_THRESHOLD).toBe(VERDICT_THRESHOLDS.suspect);
    expect(ORG_AD_SUSPECT_THRESHOLD).toBe(40);
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm vitest run tests/lib/cohortHeadline.test.ts` → 새 테스트 FAIL(70 ≠ 40) 확인.

- [ ] **Step 3: 상수 변경** — `cohortHeadline.ts:82`를 다음으로 교체 (주석도 재작성):

```ts
/**
 * 자연 유입 점수가 이 값 미만이면 "광고 영향 의심" 배지를 단다.
 * 컷은 organicity.ts 등급 체계의 `suspect` 경계(40) — 그 아래는 likely_paid
 * 티어, 즉 "광고를 과하게 쓴 것으로 보이는" 팀이다.
 *
 * 왜 organic(70)이 아닌가: 판정 점수는 편수·조회수 중 **낮은 쪽**(adJudgeScore)
 * 인데, 조회수 기준은 소수의 고조회 영상에 끌려 구조적으로 낮게 나온다
 * (2026-07-29 실측: 전 그룹 min 29.8~58.9, 참조 PLAVE조차 58.9). organic 컷을
 * 그대로 쓰면 전원이 걸려 배지가 변별력을 잃는다 — 배지는 "광고 과다 사용이
 * 뚜렷한 팀"만 가리켜야 하고, 경계 대역은 산점도·막대의 연속 점수가 보여준다.
 * 숫자를 손으로 적지 않고 organicity.ts 컷을 참조하는 이유는 종전과 같다
 * (재보정 시 hand-copy desync 방지).
 */
export const ORG_AD_SUSPECT_THRESHOLD = VERDICT_THRESHOLDS.suspect;
```

- [ ] **Step 4: 전체 lib 테스트 실행** — `pnpm vitest run tests/lib/` → 임계 70을 전제한 기존 기대값(헤드라인 문구·adSuspect 판정·산점도 threshold/yRange 등)이 깨지면 **새 임계 40 기준으로 기대값을 갱신**한다. 테스트가 "점수 65는 의심" 같은 시나리오면 픽스처 점수를 의도(의심/통과)에 맞게 옮겨도 된다 — 단 의도(어느 쪽 분기를 검증하는지)는 보존.

- [ ] **Step 5: 통과 확인 + 컴포넌트 문구 점검** — `pnpm vitest run && pnpm typecheck`. `MiiWANCohortReport.tsx`에서 `ORG_AD_SUSPECT_THRESHOLD`가 들어가는 화면 문구 3곳(표 각주 `:769`, 배지 title `:713`, 막대 캡션 `:858`)이 새 값(40)으로 자연스럽게 읽히는지 확인 — 상수 보간이라 코드 수정은 없어야 정상.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "fix(cohort-ui): 광고 의심 컷을 suspect(40)로 재보정 — 전원 배지 문제 해소"`

---

### Task 2: API — 데뷔 전 앵커 값·총 성장배수 (요청 1·3의 데이터 공급)

**Files:**
- Modify: `frontend/functions/lib/cohortReport.ts` (순수 함수 추가)
- Modify: `frontend/functions/api/miiwan-cohort.ts:55-71` (ScorecardRow), `:216-231` (행 채우기)
- Modify: `frontend/src/lib/cohortHeadline.ts:11-23` (ScRow 타입)
- Test: `frontend/tests/functions/lib_cohort_report.test.ts`, `frontend/tests/functions/api_miiwan_cohort.test.ts`

**Interfaces:**
- Consumes: 기존 `baseValueAt`, `PRE_DEBUT_DAYS`(30), `PRE_BASE_WINDOW`(7), `AT_DAY_WINDOW`(7), `BASE_WINDOW`(3), `AlignedValue`.
- Produces:
  - `preAnchor(points: Map<number, AlignedValue>): BasePoint | null` — D-30±7 우선, 없으면 데뷔 전(day<0) 가장 이른 양수 값, 그것도 없으면 null.
  - `totalMultiple(points, asOfDay): { multiple: number; anchor_day: number; anchor_source: string } | null` — D+N 값 ÷ (preAnchor ?? D0 기준값).
  - API `ScorecardRow`·프런트 `ScRow`에 추가 필드: `pre_value: number | null; pre_day: number | null; pre_source: string | null; total_multiple: number | null; total_anchor_day: number | null; total_anchor_source: string | null`.

- [ ] **Step 1: 순수 함수 실패 테스트 작성** — `frontend/tests/functions/lib_cohort_report.test.ts`에 추가 (기존 테스트의 `AlignedValue` 맵 헬퍼 스타일을 따른다):

```ts
describe("preAnchor / totalMultiple", () => {
  const pt = (value: number, source = "live") => ({ value, source });

  it("D-30±7 안의 값을 앵커로 잡는다", () => {
    const pts = new Map([[-30, pt(1000)], [0, pt(2000)], [40, pt(4000)]]);
    expect(preAnchor(pts)).toEqual({ day: -30, value: 1000, source: "live" });
    expect(totalMultiple(pts, 40)).toEqual(
      { multiple: 4, anchor_day: -30, anchor_source: "live" });
  });

  it("D-30±7이 비면 데뷔 전 가장 이른 값으로 물러난다 (bthd 케이스: D-21부터)", () => {
    const pts = new Map([[-21, pt(500)], [-10, pt(800)], [0, pt(1000)], [40, pt(2000)]]);
    expect(preAnchor(pts)).toEqual({ day: -21, value: 500, source: "live" });
    expect(totalMultiple(pts, 40)?.multiple).toBe(4);
    expect(totalMultiple(pts, 40)?.anchor_day).toBe(-21);
  });

  it("데뷔 전 값이 전무하면 앵커는 null, 총 배수는 D0 기준으로 물러난다 (myrakl 케이스)", () => {
    const pts = new Map([[0, pt(1000)], [40, pt(3000)]]);
    expect(preAnchor(pts)).toBeNull();
    expect(totalMultiple(pts, 40)).toEqual(
      { multiple: 3, anchor_day: 0, anchor_source: "live" });
  });

  it("0 이하 값은 앵커로 쓰지 않는다", () => {
    const pts = new Map([[-30, pt(0)], [-15, pt(200)], [0, pt(400)], [40, pt(800)]]);
    expect(preAnchor(pts)).toEqual({ day: -15, value: 200, source: "live" });
  });

  it("도달값이 없으면 null", () => {
    const pts = new Map([[-30, pt(1000)], [0, pt(2000)]]);
    expect(totalMultiple(pts, 40)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm vitest run tests/functions/lib_cohort_report.test.ts` → "preAnchor is not defined"류 FAIL.

- [ ] **Step 3: 구현** — `frontend/functions/lib/cohortReport.ts`의 `preMultiple` 아래에 추가:

```ts
/**
 * 데뷔 전 앵커 — "데뷔 전부터 지금까지" 총 성장배수의 분모.
 * D-PRE_DEBUT_DAYS±PRE_BASE_WINDOW 를 먼저 찾고, 비면 데뷔 전 구간에서
 * 확보된 가장 이른 양수 값으로 물러난다(수집이 D-21부터인 팀을 창 하나
 * 차이로 통째로 떨어뜨리지 않는다 — 실제 앵커 날짜는 호출부가 공시).
 * 데뷔 전 값이 전무하면 null — 합성하지 않는다.
 */
export function preAnchor(points: Map<number, AlignedValue>): BasePoint | null {
  const strict = baseValueAt(points, -PRE_DEBUT_DAYS, PRE_BASE_WINDOW);
  if (strict && strict.value > 0) return strict;
  let earliest: BasePoint | null = null;
  for (const [day, p] of points) {
    if (day >= 0 || !(p.value > 0)) continue;
    if (!earliest || day < earliest.day) {
      earliest = { day, value: p.value, source: p.source };
    }
  }
  return earliest;
}

/**
 * 총 성장배수 = D+N 값 ÷ 데뷔 전 앵커. 데뷔 후 배수(growthMultiple)와 달리
 * 데뷔 전에 쌓은 성장까지 한 숫자로 잰다 — 산점도 x축이 "데뷔 전부터 후까지"
 * 를 묻기 위해 쓴다. 데뷔 전 앵커가 없는 팀은 D0 기준값으로 물러나되
 * anchor_day(=0)로 그 사실을 실어 보낸다(화면이 공시).
 */
export function totalMultiple(
  points: Map<number, AlignedValue>,
  asOfDay: number,
): { multiple: number; anchor_day: number; anchor_source: string } | null {
  const at = baseValueAt(points, asOfDay, AT_DAY_WINDOW);
  if (!at) return null;
  const anchor = preAnchor(points) ?? baseValueAt(points, 0, BASE_WINDOW);
  if (!anchor || !(anchor.value > 0)) return null;
  return {
    multiple: at.value / anchor.value,
    anchor_day: anchor.day,
    anchor_source: anchor.source,
  };
}
```

- [ ] **Step 4: 순수 테스트 통과 확인** — `pnpm vitest run tests/functions/lib_cohort_report.test.ts`.

- [ ] **Step 5: API 응답에 싣기** — `frontend/functions/api/miiwan-cohort.ts`:
  - import에 `preAnchor, totalMultiple` 추가.
  - `ScorecardRow` 인터페이스(`:55-71`)에 필드 추가:

```ts
  /** 데뷔 전 앵커 값 (D-30±7 우선, 없으면 데뷔 전 최초 확보 값). 표의 "데뷔 전 값" 컬럼. */
  pre_value: number | null;
  pre_day: number | null;
  pre_source: string | null;
  /** 총 성장배수 = D+N ÷ 데뷔 전 앵커 (앵커 없으면 데뷔일 기준 — anchor_day 로 공시). */
  total_multiple: number | null;
  total_anchor_day: number | null;
  total_anchor_source: string | null;
```

  - 데이터 없는 그룹의 null 행(`:172-177`)에도 6개 필드 `null` 추가.
  - 정상 행(`:216-231`)에서:

```ts
      const anchor = preAnchor(pts);
      const total = totalMultiple(pts, asOfDay);
```
  를 계산해 `pre_value: anchor?.value ?? null, pre_day: anchor?.day ?? null, pre_source: anchor?.source ?? null, total_multiple: total?.multiple ?? null, total_anchor_day: total?.anchor_day ?? null, total_anchor_source: total?.anchor_source ?? null` 채운다.

- [ ] **Step 6: 프런트 타입 동기화** — `frontend/src/lib/cohortHeadline.ts`의 `ScRow`(`:11-23`)에 같은 6개 필드를 추가 (주석 포함):

```ts
  /** 데뷔 전 앵커 값 (D-30±7 우선, 없으면 데뷔 전 최초 확보 값). */
  pre_value: number | null; pre_day: number | null; pre_source: string | null;
  /** 총 성장배수 (데뷔 전 앵커 → D+N). 앵커 날짜는 total_anchor_day 로 공시. */
  total_multiple: number | null;
  total_anchor_day: number | null; total_anchor_source: string | null;
```

- [ ] **Step 7: API 테스트 갱신** — `pnpm vitest run tests/functions/api_miiwan_cohort.test.ts` 실행. 픽스처 기반 스냅샷/기대 행이 새 필드로 깨지면 기대값에 6개 필드를 추가하고, 최소 1개 케이스에서 `pre_value`·`total_multiple`이 픽스처 값으로 옳게 계산되는지 어서션을 추가한다. 프런트 lib 테스트도 ScRow 픽스처에 필드 추가가 필요할 수 있다(`pnpm vitest run`으로 전체 확인).

- [ ] **Step 8: 통과 확인** — `pnpm vitest run && pnpm typecheck`.

- [ ] **Step 9: Commit** — `git commit -m "feat(cohort-api): 데뷔 전 앵커 값·총 성장배수 응답 추가 (D-30 반영 기반)"`

---

### Task 3: 팀별 상세표 — "데뷔 전 값" 컬럼 (요청 3)

**Files:**
- Modify: `frontend/src/components/MiiWANCohortReport.tsx:610-737` (표), `:740-785` (각주)

**Interfaces:**
- Consumes: Task 2의 `ScRow.pre_value / pre_day / pre_source`, 기존 `fmt`, `EstBadge`, `measuredOn`.

- [ ] **Step 1: 헤더 컬럼 추가** — `:614-618` `<thead>`의 "출발선 (데뷔일 값)" **앞**에:

```tsx
                <th scope="col" class="px-3 py-2 text-right">데뷔 전 값 (30일 전 기준)</th>
```

- [ ] **Step 2: 데이터 셀 추가** — 출발선 셀(`:674-681`) 앞에 같은 구조로:

```tsx
                      {/* 데뷔 전 값 = 데뷔 전 배수·총 성장의 출발점. D-30±7이 비면
                          확보된 가장 이른 데뷔 전 값을 쓰고 측정일을 그대로 밝힌다. */}
                      <td class="px-3 py-2 text-right text-zinc-400">
                        {r.pre_value == null ? "—" : fmt(r.pre_value)}
                        <EstBadge source={r.pre_source} />
                        {r.pre_day != null && (
                          <div class="text-hint text-zinc-600">{measuredOn(r.pre_day)}</div>
                        )}
                      </td>
```

- [ ] **Step 3: colSpan 보정** — 참조 구분선 행(`:653`)의 `colSpan={showEfficiency ? 6 : 5}`를 `colSpan={showEfficiency ? 7 : 6}`으로.

- [ ] **Step 4: 각주 갱신** — 배수 계산 각주(`:876-880`)에 한 문장 추가: "데뷔 전 값은 데뷔 30일 전(±7일) 측정값이고, 그 창에 측정이 없는 팀은 확보된 가장 이른 데뷔 전 값을 측정일과 함께 실었다. 데뷔 전 측정이 아예 없는 팀은 — 로 둔다." (문구는 이 뜻이면 다듬어도 됨. `데뷔 전 성장 배수`가 —인데 데뷔 전 값이 있는 행(bthd)이 모순으로 안 읽히도록 "데뷔 전 배수는 30일 전 값이 있을 때만 낸다"까지 명시.)

- [ ] **Step 5: 검증** — `pnpm typecheck && pnpm vitest run`. `pnpm dev`로 로컬 확인이 어려우면(로컬 D1에 miiwan 없음) 생략하고 타입·테스트만으로 판단.

- [ ] **Step 6: Commit** — `git commit -m "feat(cohort-ui): 팀별 상세표에 데뷔 전 값 컬럼 추가"`

---

### Task 4: 성장의 질 산점도 — 데뷔 전 포함 총 성장배수 축 (요청 1)

**Files:**
- Modify: `frontend/src/lib/cohortQuality.ts` (x축 데이터 소스 교체 + 앵커 공시)
- Modify: `frontend/src/components/MiiWANCohortReport.tsx:326-375` (축 제목·툴팁), 산점도 캡션부(`:484-523` 근방)
- Test: `frontend/tests/lib/cohortQuality.test.ts`

**Interfaces:**
- Consumes: Task 2의 `ScRow.total_multiple / total_anchor_day`.
- Produces: `QualityPoint.growth` = **총 성장배수**, `QualityPoint.anchorDay: number` (앵커 경과일, 0 = 데뷔일 폴백), `QualityScatter.medianGrowth` = 총 성장배수 중앙값. `scatterNote()` 문구는 총 성장 기준.

- [ ] **Step 1: 테스트 갱신 (실패 선행)** — `tests/lib/cohortQuality.test.ts`의 픽스처 `ScRow`에 `total_multiple`·`total_anchor_day` 등 Task 2 필드를 채우고, 기대를 다음으로 바꾼다/추가한다:
  - `growth`가 `growth_multiple`이 아니라 `total_multiple`에서 오는지.
  - `total_multiple == null`이면 excluded (사유: "성장배수를 낼 수 없음" 계열).
  - `anchorDay`가 그대로 실리는지 (D-30 케이스와 D0 폴백 케이스 각 1개).
  - `medianGrowth`가 총 성장배수 기준으로 계산되는지.

- [ ] **Step 2: 실패 확인** — `pnpm vitest run tests/lib/cohortQuality.test.ts`.

- [ ] **Step 3: lib 구현** — `cohortQuality.ts`:
  - `QualityPoint`에 `/** x 값의 분모를 잰 경과일 (음수 = 데뷔 전, 0 = 데뷔일 폴백). */ anchorDay: number;` 추가, `growth` 주석을 "데뷔 전 앵커 대비 총 성장배수"로 수정.
  - `buildQualityScatter` 루프에서:

```ts
    const growth = r.total_multiple;
    // …
    draft.push({
      // …기존 필드…
      growth,
      anchorDay: r.total_anchor_day ?? 0,
```

  - exclusion 사유 문구를 총 성장 기준으로 수정: `"데뷔 전·데뷔일 값이 없어 성장배수를 낼 수 없음"`.
  - `scatterNote()`의 성장 문장을 총 성장 기준으로 손보고, MiiWAN 앵커가 데뷔 전이 아니면(=0) 그 사실을 붙일 것. 예: "성장 배수는 데뷔 30일 전 값 대비"를 전제로 한 문구.

- [ ] **Step 4: 컴포넌트 반영** — `MiiWANCohortReport.tsx` 산점도 `useEffect`:
  - x축 제목(`:348`) → `"총 성장 배수 (데뷔 전 값 대비, 데뷔 전~현재)"`.
  - 툴팁(`:362-367`) → 앵커 공시 포함:

```ts
              label: (item) => {
                const p = s.points[item.datasetIndex];
                if (!p) return item.dataset.label ?? "";
                const anchor = p.anchorDay < 0
                  ? `데뷔 ${-p.anchorDay}일 전 대비` : "데뷔일 대비(데뷔 전 측정 없음)";
                return `${p.name}: 총 ${fmtMultiple(p.growth)} (${anchor})`
                  + ` · 자연 유입 ${p.organic}점 · 구독자 ${fmt(p.scale)}`;
              },
```

  - 산점도 섹션 리드/캡션(: ~484-523 사이의 설명문)에서 "데뷔 후" 전제 문구를 "데뷔 전(약 30일 전)부터 현재까지"로 갱신하고, 앵커가 데뷔 전이 아닌 팀이 있으면(myrakl) 캡션에 자동으로 한 줄 공시:

```tsx
            {quality.points.some((p) => p.anchorDay === 0) && (
              <p class="text-hint text-zinc-600">
                {quality.points.filter((p) => p.anchorDay === 0).map((p) => p.name).join(", ")}
                {"은(는) 데뷔 전 측정값이 없어 데뷔일 대비 배수로 그렸다."}
              </p>
            )}
```
  (배치는 기존 excluded 캡션 옆, 스타일은 주변과 통일. `quality`는 이미 `:396`에서 계산돼 있음.)

- [ ] **Step 5: 검증** — `pnpm vitest run && pnpm typecheck`.

- [ ] **Step 6: Commit** — `git commit -m "feat(cohort-ui): 성장의 질 산점도 x축을 데뷔 전 포함 총 성장배수로 전환"`

---

### Task 5: 자연 유입 점수 막대 재설계 (요청 4)

**Files:**
- Modify: `frontend/src/components/MiiWANCohortReport.tsx:790-864` (⑤ 섹션)

**Interfaces:**
- Consumes: `VERDICT_THRESHOLDS`, `VERDICT_COLOR`, `scoreColor` (`src/lib/organicity.ts`), 기존 `adJudgeScore`, `ORG_AD_SUSPECT_THRESHOLD`, `clampPct`, `colorOf`.
- 대상은 동시기 섹션의 구간 막대만 — 별개 섹션 `CompetitorOrganicityBar`는 건드리지 않는다.

**설계 (현재 문제: min~max 구간 막대만 있어 ① 어느 끝이 어느 기준인지 ② 판정 점수가 뭔지 ③ 몇 점부터 위험인지 안 보인다):**
1. 행 왼쪽에 **판정 점수(min)를 큰 숫자로** — 색은 `scoreColor(판정점수)` (등급색, 단일 원천).
2. 트랙 배경에 **등급 밴드** (0–40 / 40–55 / 55–70 / 70–85 / 85–100, `VERDICT_COLOR`를 낮은 알파로) + **판정 기준선**(`ORG_AD_SUSPECT_THRESHOLD`) 세로선.
3. 구간 막대 위에 **기준별 마커**: 편수 기준 = 채운 점, 조회수 기준 = 속 빈 점 (title 툴팁으로 "편수 기준 74점" 등).
4. 목록 위에 **눈금 행** (0 · 40 · 55 · 70 · 85 · 100).
5. 캡션 재작성 — 읽는 순서대로: 큰 숫자(판정) → 막대(두 기준의 간격) → 색 밴드(등급).

- [ ] **Step 1: 헬퍼 추가** — 컴포넌트 상단(파일 스코프, `clampPct` 근처):

```ts
/** organicity 등급색 hex → rgba. 등급 밴드 배경은 원색이면 막대를 잡아먹는다. */
function hexAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 등급 밴드 배경 — 경계·색 모두 organicity.ts 단일 원천에서 파생. */
const TIER_BAND_ALPHA = 0.10;
const T = VERDICT_THRESHOLDS;
const TIER_BAND_BG = `linear-gradient(to right, ${[
  [VERDICT_COLOR.likely_paid, 0, T.suspect],
  [VERDICT_COLOR.suspect, T.suspect, T.borderline],
  [VERDICT_COLOR.borderline, T.borderline, T.organic],
  [VERDICT_COLOR.organic, T.organic, T.organic_strong],
  [VERDICT_COLOR.organic_strong, T.organic_strong, 100],
].map(([c, from, to]) =>
  `${hexAlpha(c as string, TIER_BAND_ALPHA)} ${from}% ${to}%`).join(", ")})`;
```

  (import에 `VERDICT_COLOR, VERDICT_THRESHOLDS, scoreColor`를 `../lib/organicity`에서 추가.)

- [ ] **Step 2: 목록 렌더 교체** — `:813-852`의 `<div class="space-y-1.5">…</div>`를 다음 구조로 교체:

```tsx
          {/* 눈금 행 — 등급 경계를 축처럼 보여준다. 좌우 스페이서는 아래 행의
              이름/숫자 컬럼 폭과 같아야 트랙과 정렬된다. */}
          <div class="flex items-center gap-2 text-sm" aria-hidden="true">
            <span class="w-20 shrink-0" />
            <span class="w-9 shrink-0" />
            <div class="relative h-4 flex-1 text-[10px] tabular-nums text-zinc-600">
              {[0, T.suspect, T.borderline, T.organic, T.organic_strong, 100].map((t) => (
                <span key={t} class="absolute -translate-x-1/2" style={{ left: `${t}%` }}>{t}</span>
              ))}
            </div>
            <span class="w-32 shrink-0" />
            <span class="w-20 shrink-0" />
          </div>
          <div class="space-y-1.5">
            {orgRows.map((o) => {
              const byCount = o.score!;
              const byViews = o.score_view_weighted ?? byCount;
              const judge = adJudgeScore(o)!;
              const lo = Math.min(byCount, byViews);
              const hi = Math.max(byCount, byViews);
              const isMine = o.group_key === "miiwan";
              const wide = hi - lo >= ORG_SCORE_GAP_CHIP;
              return (
                <div key={o.group_key} class="flex items-center gap-2 text-sm">
                  <span class="w-20 shrink-0" style={{ color: colorOf(o.group_key) }}>
                    {data.groups[o.group_key]?.name ?? o.group_key}
                  </span>
                  {/* 판정 점수 — 이 행의 결론. 색은 등급색(단일 원천). */}
                  <span class="w-9 shrink-0 text-right tabular-nums font-semibold"
                        style={{ color: scoreColor(judge) }}
                        title={`판정 점수 ${judge}점 (편수 ${byCount} · 조회수 ${byViews} 중 낮은 쪽)`}>
                    {judge}
                  </span>
                  <div class="relative h-3 flex-1 rounded"
                       style={{ background: TIER_BAND_BG }}>
                    {/* 광고 의심 기준선 */}
                    <div class="absolute top-[-2px] bottom-[-2px] w-px"
                         style={{ left: `${ORG_AD_SUSPECT_THRESHOLD}%`,
                                  background: hexAlpha(VERDICT_COLOR.likely_paid, 0.7) }} />
                    {/* 두 기준 사이 구간 */}
                    <div class="absolute top-1/2 h-1 -translate-y-1/2 rounded"
                         style={{ left: `${clampPct(lo)}%`,
                                  width: `${Math.max(1, clampPct(hi) - clampPct(lo))}%`,
                                  background: colorOf(o.group_key),
                                  opacity: isMine ? 0.9 : 0.45 }} />
                    {/* 편수 기준 = 채운 점 / 조회수 기준 = 속 빈 점 */}
                    <div class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                         title={`편수 기준 ${byCount}점`}
                         style={{ left: `${clampPct(byCount)}%`,
                                  background: colorOf(o.group_key),
                                  opacity: isMine ? 1 : 0.75 }} />
                    {o.score_view_weighted != null && (
                      <div class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                           title={`조회수 기준 ${byViews}점`}
                           style={{ left: `${clampPct(byViews)}%`,
                                    borderColor: colorOf(o.group_key),
                                    background: "rgb(24 24 27)", // zinc-900 카드 배경
                                    opacity: isMine ? 1 : 0.75 }} />
                    )}
                  </div>
                  <span class="w-32 shrink-0 text-right text-hint tabular-nums text-zinc-500">
                    편수 {byCount} · 조회수 {o.score_view_weighted == null ? "—" : byViews}
                  </span>
                  <span class="w-20 shrink-0 text-right text-hint text-zinc-600">
                    영상 {o.video_count}편
                  </span>
                  {wide && (
                    <span class={CHIP} title="영상 편수로 본 점수와 조회수로 본 점수가 크게 갈린다">
                      편수·조회수 차이 큼
                    </span>
                  )}
                  {o.reference && <span class="text-hint text-zinc-600">참고용</span>}
                </div>
              );
            })}
          </div>
```

- [ ] **Step 3: 캡션 교체** — `:853-862` 문단을 읽는 순서대로 재작성:

```tsx
          <p class="mt-2 text-hint text-zinc-500 leading-relaxed">
            <strong class="text-zinc-300">굵은 숫자가 판정 점수</strong> — 영상 편수로 본
            점수(채운 점)와 조회수로 본 점수(빈 점) 중 <strong class="text-zinc-300">낮은
            쪽</strong>이다. 조회수 점수가 유독 낮으면 조회수가 소수의 광고성 영상에 쏠려
            있다는 뜻이고, 두 점 사이가 멀수록 그 쏠림이 크다. 배경 색 구간은 점수대의
            뜻이다 — {ORG_AD_SUSPECT_THRESHOLD}점 미만(붉은 구간)이면 광고를 과하게 쓴
            것으로 보고 위 그래프·표에 &lsquo;광고 의심&rsquo;을 붙이며,
            {" "}{VERDICT_THRESHOLDS.organic}점 이상(초록 구간)이면 자연 유입이 우세하다.
            MiiWAN이 지금까지 지나온 기간({orgWindowLabel})까지만 세서 비교한다 — 먼저
            데뷔한 팀만 더 긴 기간을 쓰면 공정하지 않기 때문이다.
          </p>
```

- [ ] **Step 4: 검증** — `pnpm vitest run && pnpm typecheck && pnpm build`. 좁은 화면(카드 폭)에서 눈금·마커가 겹치는 정도는 코드 리뷰로만 판단(로컬 D1에 데이터 없음) — flex 폭 상수(w-20/w-9/w-32/w-20)가 눈금 행과 데이터 행에서 동일한지 재확인.

- [ ] **Step 5: Commit** — `git commit -m "feat(cohort-ui): 자연 유입 점수 막대 재설계 — 판정 점수·등급 밴드·기준 마커"`

---

### Task 6: 최종 검증

- [ ] **Step 1**: `pnpm vitest run` 전체 + `pnpm typecheck` + `pnpm build` 모두 통과 확인.
- [ ] **Step 2**: `git log --oneline -6`으로 태스크별 커밋 5개 확인. 푸시는 하지 않는다(사용자 확인 후 — main push 시 자동 배포되므로).

## Self-Review 결과

- 요청 1 → Task 2(데이터)+4(산점도), 요청 2 → Task 1, 요청 3 → Task 2+3, 요청 4 → Task 5. 커버 완료.
- 타입 일관성: `pre_value/pre_day/pre_source/total_multiple/total_anchor_day/total_anchor_source` 명칭이 Task 2(API·ScRow)와 Task 3·4(소비처)에서 동일. `preAnchor`/`totalMultiple`/`anchorDay` 동일.
- myrakl(데뷔 전 데이터 전무)·bthd(D-21부터) 엣지가 Task 2 테스트와 Task 3·4의 공시 문구에 모두 반영됨.
