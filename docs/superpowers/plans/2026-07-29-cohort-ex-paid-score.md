# 자연 유입 섹션 "유료 판정 제외 점수" 상시 노출 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 브리프 탭 자연 유입 점수 섹션에서, 드릴다운 없이 한눈에 "유료 판정 영상을 제외하면 조회수 가중 점수가 얼마나 회복되는가"(미완이 41.4→약 69.5)와 그 쏠림 규모(14편이 조회수 71%)가 보이게 한다.

**Architecture:** `/api/miiwan-cohort`가 `debut_window_video_organicity`(영상 단위)를 기존 유기성 창과 같은 버킷으로 집계해 그룹별 `paid_video_count / window_video_count / paid_view_share / score_view_weighted_ex_paid`를 organicity 행에 싣는다. 프런트는 ① 각 그룹 막대 트랙에 제외 점수 마커(세로 틱, 전 그룹 대칭) ② 섹션 리드 아래 MiiWAN 자동 요약 한 줄(`exPaidNote`, 순수 함수) ③ 캡션 한 문장을 추가한다. 판정(min)·배지 규칙은 불변.

**Tech Stack:** 기존과 동일 (Preact, Pages Functions + D1, vitest, pnpm).

## Global Constraints

- pnpm, `frontend/`에서 `pnpm vitest run` / `pnpm typecheck` / `pnpm build`.
- **판정·배지 불변**: `adJudgeScore`(min)·`ORG_AD_SUSPECT_THRESHOLD`(40)·배지 로직은 건드리지 않는다. 새 수치는 보조 층이다.
- **동어반복 방지**: 제외 점수는 반드시 쏠림 규모(편수·조회수 점유)와 함께 표기한다 — "광고 판정을 빼니 깨끗하다" 단독 문장 금지.
- **대칭 적용**: 마커·데이터는 전 그룹 동일 규칙. 자동 요약 문장만 MiiWAN 한정(자사 심층 페이지).
- 가짜 수치 금지: 분모 0·데이터 없음이면 null, 문장·마커 미표시. 쿼리 실패는 기존 organicity와 같이 degrade(전체 응답 안 죽임).
- 숫자 하드코딩 금지(임계·등급), 카피는 투자사·경영진 독자(내부 용어 금지), 한국어 왜-중심 주석 톤.
- 참고 실측(2026-07-29, 검증용 기대값): miiwan 창 내 판정영상 122편·조회수 2,095,389 / likely_paid 14편·71.2% / 제외 시 뷰가중 ≈69.5.

---

### Task 1: API — 영상 단위 유료 판정 제외 집계

**Files:**
- Modify: `frontend/functions/api/miiwan-cohort.ts` (새 쿼리 + organicity 행 필드 4개)
- Modify: `frontend/src/lib/cohortHeadline.ts` (`OrgRow` 타입 확장)
- Test: `frontend/tests/functions/api_miiwan_cohort.test.ts`

**Interfaces:**
- Consumes: 기존 `orgWindow.buckets`(유기성 창 버킷), `ALL_KEYS`, `d1Query`, `isRef`.
- Produces: organicity 각 행에 추가 —
  `window_video_count: number`(창 내 판정영상 수) · `paid_video_count: number`(likely_paid 수) · `paid_view_share: number | null`(0~1, 소수 3자리) · `score_view_weighted_ex_paid: number | null`(소수 1자리). 데이터 없거나 쿼리 실패 시 count는 0, 나머지 null.

- [ ] **Step 1: 실패 테스트** — `api_miiwan_cohort.test.ts`에 영상 단위 픽스처 기반 케이스 추가. 기존 테스트의 D1 목 패턴을 따라 `debut_window_video_organicity` 쿼리 응답을 목으로 주입:

```ts
// 픽스처 의도: paid 1편이 조회수 대부분을 차지하고, 제외하면 점수가 크게 오른다.
// miiwan: [paid 80k뷰 score 30, organic 20k뷰 score 80] →
//   window_video_count 2, paid_video_count 1,
//   paid_view_share 0.8, score_view_weighted_ex_paid 80
// 전부 paid인 그룹 → ex_paid null (분모 0, 가짜 수치 금지)
```

기대 어서션: 위 값 + 영상 쿼리 실패 시 organicity 행은 살아 있고 새 필드가 count 0/null로 degrade.

- [ ] **Step 2: 실패 확인** — `pnpm vitest run tests/functions/api_miiwan_cohort.test.ts`.

- [ ] **Step 3: 구현** — `miiwan-cohort.ts`의 유기성 summary 쿼리 다음에 추가:

```ts
  // 영상 단위 유료 판정 제외 집계 — "조회수 점수가 낮은 이유가 소수 집행
  // 콘텐츠 쏠림인가"를 한눈에 보여주기 위한 보조 층. 판정(min)·배지는
  // 이 수치와 무관하게 유지된다(동어반복 방지: 화면은 반드시 쏠림 규모와
  // 함께 표기). 창은 summary 쿼리와 같은 버킷 — 화면마다 창이 다르면
  // 숫자끼리 대조가 안 된다.
  interface ExPaidRow {
    group_key: string; n: number; views: number | null;
    paid_n: number; paid_views: number | null;
    ex_wsum: number | null; ex_views: number | null;
  }
  const exPaidRows = await d1Query<ExPaidRow>(
    env.DB,
    `SELECT group_key,
            COUNT(*) AS n,
            SUM(view_count) AS views,
            SUM(CASE WHEN verdict = 'likely_paid' THEN 1 ELSE 0 END) AS paid_n,
            SUM(CASE WHEN verdict = 'likely_paid' THEN view_count ELSE 0 END) AS paid_views,
            SUM(CASE WHEN verdict != 'likely_paid' THEN organic_score * view_count ELSE 0 END) AS ex_wsum,
            SUM(CASE WHEN verdict != 'likely_paid' THEN view_count ELSE 0 END) AS ex_views
       FROM debut_window_video_organicity
      WHERE group_key IN (${ph}) AND window_bucket IN (${orgPh})
        AND organic_score IS NOT NULL AND view_count IS NOT NULL
      GROUP BY group_key`,
    [...ALL_KEYS, ...orgWindow.buckets],
  ).catch(() => [] as ExPaidRow[]);
  const exPaidBy = new Map(exPaidRows.map((r) => [r.group_key, r]));
```

organicity 행 매핑(기존 `.map((gk) => …)` 반환 객체)에 필드 추가:

```ts
        const ep = exPaidBy.get(gk);
        const epViews = ep?.views ?? 0;
        const epExViews = ep?.ex_views ?? 0;
        return {
          // …기존 필드…
          window_video_count: ep?.n ?? 0,
          paid_video_count: ep?.paid_n ?? 0,
          paid_view_share: ep && epViews > 0 && ep.paid_views != null
            ? Math.round((ep.paid_views / epViews) * 1000) / 1000 : null,
          score_view_weighted_ex_paid: ep && epExViews > 0 && ep.ex_wsum != null
            ? Math.round((ep.ex_wsum / epExViews) * 10) / 10 : null,
        };
```

- [ ] **Step 4: 프런트 타입** — `cohortHeadline.ts`의 `OrgRow`에 optional로 추가:

```ts
  /** 유기성 창 내 판정 영상 수 / 그중 유료 판정 수 (영상 단위 집계). */
  window_video_count?: number;
  paid_video_count?: number;
  /** 유료 판정 영상의 조회수 점유(0~1). 분모 0이면 null. */
  paid_view_share?: number | null;
  /** 유료 판정 영상 제외 조회수 가중 점수. 남는 조회수가 없으면 null. */
  score_view_weighted_ex_paid?: number | null;
```

- [ ] **Step 5: 통과 확인** — `pnpm vitest run && pnpm typecheck`.
- [ ] **Step 6: Commit** — `git commit -m "feat(cohort-api): 유료 판정 제외 조회수 점수·쏠림 규모 집계 추가"`

---

### Task 2: UI — 제외 점수 마커 + MiiWAN 자동 요약 한 줄

**Files:**
- Modify: `frontend/src/lib/cohortHeadline.ts` (`exPaidNote` 순수 함수)
- Modify: `frontend/src/components/MiiWANCohortReport.tsx` ⑤ 자연 유입 섹션
- Test: `frontend/tests/lib/cohortHeadline.test.ts`

**Interfaces:**
- Consumes: Task 1의 OrgRow 4개 필드, 기존 `clampPct`, `colorOf`, `CHIP`, `VERDICT_THRESHOLDS`.
- Produces: `exPaidNote(o: OrgRow | undefined | null): string | null` — 필드가 전부 있고 `paid_video_count > 0`일 때만 문장, 아니면 null.

- [ ] **Step 1: 실패 테스트** — `cohortHeadline.test.ts`:

```ts
describe("exPaidNote", () => {
  const base = { group_key: "miiwan", score: 74, video_count: 122, reference: false,
    score_view_weighted: 41.4, window_video_count: 122, paid_video_count: 14,
    paid_view_share: 0.712, score_view_weighted_ex_paid: 69.5 };
  test("유료 판정 편수·조회수 점유·제외 점수를 한 문장으로 만든다", () => {
    const note = exPaidNote(base as OrgRow);
    expect(note).toContain("14편");
    expect(note).toContain("71%");
    expect(note).toContain("69.5점");
  });
  test("유료 판정이 0편이거나 필드가 없으면 null", () => {
    expect(exPaidNote({ ...base, paid_video_count: 0 } as OrgRow)).toBeNull();
    expect(exPaidNote({ ...base, score_view_weighted_ex_paid: null } as OrgRow)).toBeNull();
    expect(exPaidNote(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** 후 **Step 3: 구현** — `cohortHeadline.ts`:

```ts
/**
 * 유료 판정 제외 요약 한 줄 — "조회수 점수가 낮은 원인이 소수 집행 콘텐츠
 * 쏠림"임을 드릴다운 없이 보여준다. 동어반복 방지를 위해 제외 점수는 반드시
 * 쏠림 규모(편수·점유)와 한 문장에 묶는다. 필드가 하나라도 없으면 null —
 * 문장을 지어내지 않는다.
 */
export function exPaidNote(o: OrgRow | undefined | null): string | null {
  if (!o) return null;
  const { window_video_count: total, paid_video_count: paid,
    paid_view_share: share, score_view_weighted_ex_paid: exScore } = o;
  if (!total || !paid || share == null || exScore == null) return null;
  return `유료 광고로 판정된 영상 ${paid}편(전체 ${total}편)이 조회수의 `
    + `${Math.round(share * 100)}%를 차지한다 — 이들을 제외한 나머지 `
    + `${total - paid}편의 조회수 기준 점수는 ${exScore}점이다.`;
}
```

- [ ] **Step 4: 컴포넌트 반영** — `MiiWANCohortReport.tsx` ⑤ 섹션:
  1. import에 `exPaidNote` 추가. 렌더 계산부에 `const miiwanExPaid = exPaidNote(data.organicity.find((o) => o.group_key === "miiwan"));`
  2. 섹션 리드(`SECTION_LEAD` 문단) **바로 아래**에 상시 한 줄(펼침 없음):

```tsx
          {miiwanExPaid && (
            <p class="mb-2 text-hint text-zinc-400">
              <strong class="text-zinc-300">MiiWAN 조회수 점수가 낮은 이유</strong>
              {" — "}{miiwanExPaid} 광고 노출이 소수 핵심 콘텐츠에 몰려 있고,
              나머지 카탈로그는 자연 소비에 가깝다는 뜻이다.
            </p>
          )}
```

  3. 각 막대 트랙(등급 밴드 div 안, 기준선·마커 형제로)에 **제외 점수 마커**(전 그룹 대칭, 세로 틱 — 채운 점·빈 점과 형태 분리):

```tsx
                    {o.score_view_weighted_ex_paid != null && (
                      <div class="absolute top-[-3px] bottom-[-3px] w-[2px] -translate-x-1/2 rounded"
                           title={`유료 판정 영상 제외 시 조회수 기준 ${o.score_view_weighted_ex_paid}점`}
                           style={{ left: `${clampPct(o.score_view_weighted_ex_paid)}%`,
                                    background: colorOf(o.group_key),
                                    opacity: o.group_key === "miiwan" ? 0.9 : 0.5 }} />
                    )}
```

  4. 캡션 문단에 한 문장 추가: `세로 틱은 유료 판정 영상을 빼고 다시 센 조회수 기준 점수다 — 빈 점과 틱이 멀수록 조회수 하락이 소수 광고성 영상 때문이라는 뜻이다.`

- [ ] **Step 5: 검증** — `pnpm vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 6: Commit** — `git commit -m "feat(cohort-ui): 유료 판정 제외 점수 상시 노출 — 트랙 틱 마커 + MiiWAN 요약 한 줄"`

---

### Task 3: 최종 검증
- [ ] `pnpm vitest run` + `pnpm typecheck` + `pnpm build` 전체 통과, 커밋 2개 확인. 푸시는 사용자 결정 후.

## Self-Review 결과
- 요구("열지 않고 한눈에") → 리드 아래 상시 문장 + 트랙 틱 마커로 충족. 판정·배지 불변, 동어반복 방지 문구 규칙 반영, null degrade 일관. Task 1 픽스처 기대값과 Task 2 문장 포맷 일치(`71%`·`69.5점`).
