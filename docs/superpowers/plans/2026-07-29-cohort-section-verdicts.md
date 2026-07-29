# 섹션별 MiiWAN 잘함/보완 자동 해석 + 헤드라인 보조 문장 정리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (사용자 피드백 2026-07-29) ① 헤드라인 카드의 보조 문장 3개 삭제 — 회색 지대 자기공시(organicNote)·경쟁 팀 유료 정황(paidSignalNote)·"규모가 큰 팀이 이기는 비교가 아니다" 문단. ② 대신 **각 지표 섹션(산점도·성장곡선·팀별 상세표·자연 유입 점수)마다 MiiWAN 기준 "잘하고 있는 점 / 보완할 점" 두 줄을 데이터에서 자동 산출해 상시 표기** — "종합 평가는 알겠는데 각 지표를 봤을 때 해석이 안 된다"를 해소.

**Architecture:** `SectionVerdict { good, weak }`를 반환하는 순수 함수 4개(산점도는 `cohortQuality.ts`, 나머지는 `cohortHeadline.ts` — 순환 import 방지)를 만들고, 공용 `VerdictLines` 소컴포넌트로 각 섹션 리드 아래 렌더. 자기공시(광고 몫 가능성)는 삭제되는 게 아니라 자연 유입 섹션의 '보완할 점'으로 **이동**한다(정직성 유지). 기존 `scatterNote`는 산점도 verdict에 흡수·대체.

**Tech Stack:** 기존과 동일 (Preact, vitest, pnpm).

## Global Constraints

- pnpm, `frontend/`에서 `pnpm vitest run` / `pnpm typecheck` / `pnpm build`.
- **결론 하드코딩 금지**: good/weak 문장의 모든 수치·순위·비교는 `CohortData`에서 파생. 데이터가 없으면 해당 줄 null(가짜 수치 금지).
- **자기공시 보존**: 자연 유입 섹션의 weak에는 판정 점수가 있는 한 반드시 "판정 점수 N점 ↔ 기준선(`ORG_AD_SUSPECT_THRESHOLD`) 관계 + 광고 영향 배제 어려움"이 들어간다 — 헤드라인에서 지운 문장의 내용이 여기로 이동.
- 임계·등급 숫자 하드코딩 금지(상수 보간). 카피는 투자사·경영진 독자, 내부 용어 금지, 한국어 왜-중심 주석 톤.
- 판정(min)·배지·기존 마커·exPaidNote 불변.
- 참고 실측(테스트 픽스처 검증용): miiwan 총 성장배수 ≈15.0×(중앙값 8.7×), 편수 점수 74.0(2위), 판정 41.4, 데뷔 후 배수 1.08×, 순증 +2,200명, 출발선 26,400(2위), 데뷔 전 배수 13.8×.

---

### Task 1: 헤드라인 보조 문장 3개 삭제

**Files:**
- Modify: `frontend/src/components/MiiWANCohortReport.tsx` (`:492-495` organicNote 렌더, paidSignalNote 렌더(같은 블록), `:506` 문단)
- Modify: `frontend/src/lib/cohortHeadline.ts` (`organicNote` 생성부 `:405-416`+`Headline` 타입 필드, `paidSignalLine` `:486-` 및 호출부)
- Test: `frontend/tests/lib/cohortHeadline.test.ts`

**Interfaces:**
- Produces: `Headline` 타입에서 `organicNote`·`paidSignalNote` 필드 제거. `PRE_EFFICIENCY_OUTLIER_RATIO` 등 paidSignalLine 전용 상수·헬퍼가 다른 곳에서 안 쓰이면 함께 제거(쓰이면 유지).

- [ ] **Step 1**: 컴포넌트에서 ⓐ `head.organicNote`/`head.paidSignalNote` 렌더 블록(`:492-` 부근) 삭제 ⓑ `:506` "규모가 큰 팀이 이기는 비교가 아니다 — …" 문단 삭제 (주변 레이아웃 무결성 유지).
- [ ] **Step 2**: `cohortHeadline.ts`에서 `organicNote` 생성 로직·`paidSignalLine` 함수·`Headline` 타입 필드 제거. 관련 상수는 다른 사용처 grep 후 미사용이면 제거.
- [ ] **Step 3**: `pnpm vitest run` — organicNote/paidSignalLine 대상 테스트를 삭제·정리(의도 자체가 사라진 테스트는 지운다; 이동한 내용의 커버리지는 Task 2의 organicityVerdict 테스트가 이어받는다).
- [ ] **Step 4**: `pnpm vitest run && pnpm typecheck` 통과 → Commit: `git commit -m "refactor(cohort-ui): 헤드라인 보조 문장 3개 제거 — 해석은 섹션별 잘함/보완으로 이동(후속)"`

---

### Task 2: lib — SectionVerdict 순수 함수 4개

**Files:**
- Modify: `frontend/src/lib/cohortHeadline.ts` (`SectionVerdict` 타입 + `curveVerdict`/`scorecardVerdict`/`organicityVerdict`)
- Modify: `frontend/src/lib/cohortQuality.ts` (`qualityVerdict` — `scatterNote` 대체·삭제)
- Test: `frontend/tests/lib/cohortHeadline.test.ts`, `frontend/tests/lib/cohortQuality.test.ts`

**Interfaces:**
- Produces:
```ts
export interface SectionVerdict { good: string | null; weak: string | null }
// cohortQuality.ts
export function qualityVerdict(s: QualityScatter): SectionVerdict
// cohortHeadline.ts
export function curveVerdict(d: CohortData): SectionVerdict          // PRIMARY_METRIC 고정
export function scorecardVerdict(d: CohortData, metric: string): SectionVerdict
export function organicityVerdict(d: CohortData): SectionVerdict
```
- `scatterNote`는 삭제(내용은 qualityVerdict가 흡수). `THRESHOLD_NEAR_BAND`는 유지·재사용.

- [ ] **Step 1: 실패 테스트** — 픽스처는 기존 테스트의 CohortData/QualityScatter 헬퍼 재사용. 핵심 어서션(실측 근사 픽스처):
  - qualityVerdict: good에 총 성장배수·순위 포함, 1위면 강조 문장; weak — organic이 임계±`THRESHOLD_NEAR_BAND`면 "부근·배제 어려움", 임계 미만이면 명시, 그 밖에 1~2위면 배수 과대해석 주의; mine 없으면 both null.
  - curveVerdict: 순증>0이면 good에 fmtDelta + 정체 팀 수 대비, weak에 데뷔 후 배수·순위; 순증≤0이면 good null·weak에 감소 명시; 데이터 없으면 null.
  - scorecardVerdict: good에 출발선 순위·데뷔 전 배수 순위, weak에 데뷔 후 배수 순위+저베이스 각주 취지 한 구절; null-안전.
  - organicityVerdict: good에 편수 점수·순위(+70 이상이면 "자연 유입 우세 등급"), **weak에 판정 점수 vs `ORG_AD_SUSPECT_THRESHOLD` 관계 + "광고 영향을 배제하기 어렵다" 필수 포함**(자기공시 이동 보존 가드 테스트), 조회수 쏠림 언급; 점수 없으면 both null.
  - 공통: 어떤 숫자도 하드코딩 아님(픽스처 값 바꾸면 문장 숫자 따라감을 1케이스씩 확인).

- [ ] **Step 2: 실패 확인** 후 **Step 3: 구현** — 아래 코드 기준(문구 다듬기 허용, 데이터 파생·null 규칙은 불변):

```ts
// ── cohortQuality.ts ──  (scatterNote 삭제, 아래로 대체)
export interface SectionVerdict { good: string | null; weak: string | null }

/** 내림차순 1-based 순위. */
function rankDescOf(mine: number, others: number[]): number {
  return others.filter((v) => v > mine).length + 1;
}

/**
 * 산점도의 MiiWAN 읽기 — 그림만으로는 "왼쪽=뒤처짐" 오독이 흔해(기존
 * scatterNote의 문제의식) 잘함/보완 두 줄로 나눠 자동 서술한다.
 * 결론을 손으로 적지 않는다 — 좌표·순위·임계 근접은 전부 데이터에서.
 */
export function qualityVerdict(s: QualityScatter): SectionVerdict {
  const mine = s.points.find((p) => p.group_key === "miiwan");
  if (!mine) return { good: null, weak: null };
  const peers = s.points.filter((p) => !p.reference);
  const growthRank = rankDescOf(mine.growth, peers.filter((p) => p !== mine).map((p) => p.growth));
  const scaleRank = rankDescOf(mine.scale, peers.filter((p) => p !== mine).map((p) => p.scale));
  const good = `총 성장 배수 ${fmtMultiple(mine.growth)}로 ${peers.length}팀 중 ${growthRank}위`
    + (growthRank === 1 ? " — 데뷔 전 준비 기간부터 지금까지 가장 빠르게 팬덤을 키웠다" : "")
    + `. 원 크기(현재 팬 규모)로는 ${scaleRank}위다.`;
  const gap = mine.organic - s.threshold;
  let weak: string | null;
  if (gap < 0) {
    weak = `자연 유입 점수 ${mine.organic}점은 광고 과다 기준선(${s.threshold}점) 아래다.`;
  } else if (gap <= THRESHOLD_NEAR_BAND) {
    weak = `자연 유입 점수 ${mine.organic}점은 광고 과다 기준선(${s.threshold}점) 부근이라`
      + " 광고 영향이 없다고 확정하기 어렵다.";
  } else if (growthRank <= 2) {
    weak = "총 성장 배수는 데뷔 전 출발점이 작을수록 크게 나온다 — 배수 순위를 그대로 실력 순위로 읽지 않는다.";
  } else {
    weak = null;
  }
  return { good, weak };
}

// ── cohortHeadline.ts ──
import type { SectionVerdict } from "./cohortQuality";  // 또는 타입을 여기 정의하고 quality가 import — 순환 없게 한 방향만.

/** 성장곡선의 MiiWAN 읽기 — 곡선은 기울기만 보이고 "그래서 우리는?"이 없다. */
export function curveVerdict(d: CohortData): SectionVerdict {
  const rows = d.scorecard[PRIMARY_METRIC]?.rows ?? [];
  const mine = rows.find((r) => r.group_key === "miiwan");
  if (!mine || mine.growth_multiple == null) return { good: null, weak: null };
  const delta = mine.value_at_day != null && mine.base_value != null
    ? mine.value_at_day - mine.base_value : null;
  const stalled = rows.filter((r) =>
    !r.reference && r.group_key !== "miiwan" && r.growth_multiple != null && r.growth_multiple <= 1).length;
  const unit = METRIC_UNITS[PRIMARY_METRIC] ?? "";
  let good: string | null = null;
  let weak: string | null;
  if (delta != null && delta > 0) {
    good = `데뷔 후에도 ${METRIC_LABELS[PRIMARY_METRIC]}가 ${fmtDelta(delta, unit)} 늘며 증가를 유지하고 있다`
      + (stalled > 0 ? ` — 데뷔 후 늘지 않은 ${stalled}팀과 대비된다.` : ".");
    weak = `다만 증가 폭은 ${fmtMultiple(mine.growth_multiple)}로 완만하다 — 곡선의 기울기만 보면 하위권이다.`;
  } else {
    weak = delta != null
      ? `데뷔 후 ${METRIC_LABELS[PRIMARY_METRIC]}가 ${fmtDelta(delta, unit)} — 증가가 멈춰 있다.`
      : `데뷔 후 증가 폭 ${fmtMultiple(mine.growth_multiple)} — 곡선의 기울기만 보면 하위권이다.`;
  }
  return { good, weak };
}

/** 팀별 상세표의 MiiWAN 읽기 — 표의 5개 숫자 중 무엇이 강점이고 무엇이 약점인지. */
export function scorecardVerdict(d: CohortData, metric: string): SectionVerdict {
  const sc = d.scorecard[metric];
  const rows = sc?.rows ?? [];
  const mine = rows.find((r) => r.group_key === "miiwan");
  if (!mine) return { good: null, weak: null };
  const peers = rows.filter((r) => !r.reference && r.group_key !== "miiwan");
  const baseRank = mine.base_value != null
    ? peers.filter((r) => (r.base_value ?? -1) > mine.base_value!).length + 1 : null;
  const baseN = rows.filter((r) => !r.reference && r.base_value != null).length;
  const preRank = mine.pre_multiple != null
    ? peers.filter((r) => (r.pre_multiple ?? -1) > mine.pre_multiple!).length + 1 : null;
  const good = baseRank != null && preRank != null
    ? `출발선(데뷔일 값)은 ${baseN}팀 중 ${baseRank}위, 데뷔 전 성장 배수 ${fmtMultiple(mine.pre_multiple)}는 ${preRank}위`
      + (preRank === 1 ? " — 데뷔 전에 이미 팬덤을 쌓아둔 팀이다." : ".")
    : null;
  const weak = mine.growth_multiple != null && sc?.miiwan_rank != null && sc.cohort_size >= 2
    ? `데뷔 후 성장 배수 ${fmtMultiple(mine.growth_multiple)}는 ${sc.cohort_size}팀 중 ${sc.miiwan_rank}위다`
      + " — 출발선이 큰 만큼 배수는 구조적으로 작게 나오니, 늘어난 사람 수와 같이 읽는다."
    : null;
  return { good, weak };
}

/** 자연 유입 섹션의 MiiWAN 읽기 — 헤드라인에서 뺀 자기공시가 여기로 온다. */
export function organicityVerdict(d: CohortData): SectionVerdict {
  const o = d.organicity.find((x) => x.group_key === "miiwan");
  if (!o || o.score == null) return { good: null, weak: null };
  const scoredPeers = d.organicity.filter((x) =>
    !x.reference && x.group_key !== "miiwan" && x.score != null);
  const rank = scoredPeers.filter((x) => x.score! > o.score!).length + 1;
  const n = scoredPeers.length + 1;
  const good = `영상 편수 기준 ${o.score}점으로 판정 가능한 ${n}팀 중 ${rank}위`
    + (o.score >= VERDICT_THRESHOLDS.organic ? " — 자연 유입 우세 등급이다." : " — 콘텐츠 대부분은 자연 소비되고 있다.");
  const judge = adJudgeScore(o);
  let weak: string | null = null;
  if (judge != null && judge < VERDICT_THRESHOLDS.organic) {
    const nearLine = judge - ORG_AD_SUSPECT_THRESHOLD;
    weak = `판정 점수(편수·조회수 중 낮은 쪽) ${judge}점은 광고 과다 기준선(${ORG_AD_SUSPECT_THRESHOLD}점) `
      + (nearLine < 0 ? "아래라" : nearLine <= 10 ? "부근이라" : "위지만 자연 유입 우세(70점)에는 못 미쳐")
      + " 우리 성장에도 광고 영향을 배제하기 어렵다 — 조회수가 소수 광고성 영상에 쏠린 것이 원인이다.";
  }
  return { good, weak };
}
```
(주의: `organicityVerdict`의 "자연 유입 우세(70점)" 부분도 `VERDICT_THRESHOLDS.organic` 보간으로 쓸 것 — 리터럴 70 금지.)

- [ ] **Step 4**: `scatterNote` 삭제에 따른 기존 테스트 정리(의도가 qualityVerdict로 이동한 케이스는 옮겨 재작성). `pnpm vitest run && pnpm typecheck`.
- [ ] **Step 5**: Commit: `git commit -m "feat(cohort-lib): 섹션별 MiiWAN 잘함/보완 자동 산출 4종 — scatterNote 흡수·자기공시 이동"`

---

### Task 3: UI — VerdictLines 배치 4곳

**Files:**
- Modify: `frontend/src/components/MiiWANCohortReport.tsx`

**Interfaces:**
- Consumes: Task 2의 4개 함수·`SectionVerdict`.

- [ ] **Step 1**: 파일 스코프에 공용 렌더러(헤드라인 강점/보완 블록의 기존 색 관례를 확인해 동일 톤 — 대비되는 두 색, 예: emerald/amber 계열):

```tsx
/** 섹션별 MiiWAN 읽기 — 그림·표만으로는 자사 위치가 안 읽힌다는 피드백(07-29).
    문장은 전부 lib에서 데이터로 산출 — 결론 하드코딩 금지. */
function VerdictLines({ v }: { v: SectionVerdict }) {
  if (!v.good && !v.weak) return null;
  return (
    <div class="mt-2 space-y-1 text-sm leading-relaxed">
      {v.good && (
        <p class="text-zinc-300">
          <strong class="text-emerald-400">잘하고 있는 점</strong>
          <span class="text-zinc-600"> — </span>{v.good}
        </p>
      )}
      {v.weak && (
        <p class="text-zinc-300">
          <strong class="text-amber-400">보완할 점</strong>
          <span class="text-zinc-600"> — </span>{v.weak}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2**: 렌더 계산부에서 4개 verdict 산출(기존 `quality` 변수 재사용 — 캔버스와 같은 결과를 봐야 자기모순이 없다):

```ts
  const qVerdict = qualityVerdict(quality);
  const cVerdict = curveVerdict(data);
  const sVerdict = scorecardVerdict(data, metric);
  const oVerdict = organicityVerdict(data);
```

- [ ] **Step 3**: 배치 — ② 산점도: 기존 `qNote`(scatterNote) 문단을 `<VerdictLines v={qVerdict} />`로 교체(qNote 관련 변수 제거). ③ 성장곡선: 곡선 패널 아래(흐린 선 각주 위)에 `<VerdictLines v={cVerdict} />`. ④ 팀별 상세: SECTION_LEAD 문단 아래 `<VerdictLines v={sVerdict} />`. ⑤ 자연 유입: 기존 miiwanExPaid 문단 **아래**에 `<VerdictLines v={oVerdict} />` (exPaid 문단과 숫자 중복 없게 — oVerdict는 제외 점수를 언급하지 않는다).
- [ ] **Step 4**: `pnpm vitest run && pnpm typecheck && pnpm build`.
- [ ] **Step 5**: Commit: `git commit -m "feat(cohort-ui): 지표 섹션마다 MiiWAN 잘함/보완 두 줄 상시 표기"`

---

### Task 4: 최종 검증
- [ ] `pnpm vitest run` + `pnpm typecheck` + `pnpm build` 통과, 커밋 3개 확인. 푸시는 사용자 결정 후.

## Self-Review 결과
- 삭제 3건(요청 원문 그대로) → Task 1. 섹션별 해석 → Task 2+3. 자기공시는 organicityVerdict.weak로 이동(가드 테스트 명시) — 정직성 원칙 유지.
- 타입 `SectionVerdict` 정의 위치는 순환 import가 없는 한 방향으로(Task 2 Step 3 주석). qualityVerdict는 `fmtMultiple`(cohortHeadline import 기존 존재)·`THRESHOLD_NEAR_BAND`(자체) 사용 — 기존 import 방향(quality→headline)과 일치.
- curveVerdict의 "하위권" 문구는 miiwan_rank가 있으면 순위로 대체 가능 — 구현 시 `sc.miiwan_rank` 활용해 `${rank}위`로 쓰는 것 허용(하드코딩 아님).
