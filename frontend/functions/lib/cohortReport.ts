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
// 곡선에 함께 그리는 데뷔 전 구간 길이. 미완이는 데뷔 전부터 IP 팬덤을
// 쌓아온 팀이라 D-Day 부터만 그리면 "왜 출발선이 큰가"가 곡선에서 보이지
// 않고, 출발선이 작은 팀의 가파른 배수만 남는다. 표시 범위만 넓히는 값
// 이며 기준점(D0±BASE_WINDOW=100)·성장배수·순위는 건드리지 않는다.
export const PRE_DEBUT_DAYS = 30;
// 데뷔 전 기준값(D-PRE_DEBUT_DAYS) 탐색 폭. D0 쪽(±3)보다 넓은 이유 —
// 데뷔 전 구간은 대부분 백필 앵커로 채워지는데 그 앵커가 주 1회 간격이라
// ±3 이면 대상 그룹이 통째로 빠진다. 데뷔 전 배수는 "출발선이 왜 이만큼
// 인가"를 설명하는 보조 수치이므로 D0 기준값만큼 엄격할 필요가 없다.
export const PRE_BASE_WINDOW = 7;
// 곡선에서 제외하는 소스. backfill_estimate 는 앵커 사이를 추정으로 메운
// 값이라, 앵커가 없는 구간에서 실제로 없던 급등·출렁임을 만들어낸다.
// 곡선은 실측(live · backfill_exact)만 잇고 그 사이는 직선으로 둔다 —
// "측정이 드물었다"가 "완만했다"로 위장되는 것보다 낫다.
// 스코어카드의 기준값·도달값 탐색은 이 필터를 쓰지 않는다(est 배지로 공시).
export const ESTIMATE_SOURCE = "backfill_estimate";

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

/**
 * 곡선을 못 그린 이유. 두 원인은 화면에서 서로 다른 이야기다 —
 * `no_d0_baseline` 은 "데뷔 시점 수집이 비었다"(영구적, 백필로만 해소),
 * `empty_window` 는 "기준값은 있는데 D0~D+N 사이 스냅샷이 없다"(수집 공백).
 * 엔드포인트가 이걸 재계산하다 규칙이 어긋나지 않도록 여기서 함께 낸다.
 *
 * `empty_window` 도달 조건: fromDay = -PRE_DEBUT_DAYS 이고 base.day 는
 * D0±BASE_WINDOW(최대 D±3)에서만 잡히므로 base.day >= fromDay 는 항상 참이다.
 * 따라서 base.day <= asOfDay 이면 base 점 자신이 [fromDay, asOfDay] 안에 들어
 * out 이 비지 않는다. 이 분기가 나오려면 base.day > asOfDay 여야 하고,
 * 엔드포인트가 asOfDay 를 0 이상으로 clamp 하므로 실무에서는 asOfDay ∈
 * {0, 1, 2}(데뷔 극초반) 이면서 base 가 asOfDay 보다 뒤(예: D+2)에서 잡힌
 * 경우에만 도달 가능하다. 단 그 경우에도 데뷔 전 구간(D-30~D-1)에 점이
 * 하나라도 있으면 곡선이 서므로, 창을 넓힌 뒤로 이 분기는 전보다 더 드물다
 * — "데뷔 극초반 + 데뷔 전 스냅샷도 전무" 일 때만 남는다.
 */
export type CurveFailure = "no_d0_baseline" | "empty_window";
export type CurveResult =
  | { curve: CurvePoint[]; reason: null }
  | { curve: null; reason: CurveFailure };

export function indexCurve(
  points: Map<number, AlignedValue>,
  asOfDay: number,
): CurveResult {
  const base = baseValueAt(points, 0, BASE_WINDOW);
  if (!base || base.value <= 0) return { curve: null, reason: "no_d0_baseline" };
  // 곡선 표시 구간 = 데뷔 PRE_DEBUT_DAYS 일 전부터 asOfDay 까지. 데뷔 전 점은
  // 기준값(D0=100)으로 나뉘어 100 미만에 자연스럽게 깔리고, 그 기울기가
  // "출발선이 왜 이만큼인가"를 곡선 안에서 설명한다.
  // 실제 시작점은 그 구간에 스냅샷이 있는 날 — 없는 날을 합성해 끼워넣지
  // 않는다(가짜 수치 금지). 데뷔 전 수집이 없는 팀은 그냥 늦게 시작한다.
  const fromDay = -PRE_DEBUT_DAYS;
  const out: CurvePoint[] = [];
  for (const [day, p] of points) {
    if (day < fromDay || day > asOfDay) continue;
    out.push({
      day,
      index: Math.round((p.value / base.value) * 1000) / 10, // 소수 1자리
      source: p.source,
    });
  }
  // 창 안에 남는 점이 하나도 없으면 곡선이 아니라 "없음" — 빈 데이터셋을
  // 내보내 차트에 유령 계열을 만들지 않는다.
  if (!out.length) return { curve: null, reason: "empty_window" };
  out.sort((a, b) => a.day - b.day);
  return { curve: out, reason: null };
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

/** 추정 보간값을 걷어낸 실측 점만 남긴 사본 (원본은 그대로 둔다). */
export function measuredOnly(
  points: Map<number, AlignedValue>,
): Map<number, AlignedValue> {
  return new Map(
    [...points].filter(([, p]) => p.source !== ESTIMATE_SOURCE),
  );
}

/**
 * 데뷔 전 배수 = 데뷔일 값 ÷ D-PRE_DEBUT_DAYS 값.
 * 데뷔 후 배수(growthMultiple)와 짝으로 읽어야 "출발선이 큰 팀은 데뷔 전에
 * 이미 쌓았다"와 "데뷔 직전에 급히 채웠다"가 구분된다.
 */
export function preMultiple(
  points: Map<number, AlignedValue>,
  preDebutDays = PRE_DEBUT_DAYS,
): number | null {
  const from = baseValueAt(points, -preDebutDays, PRE_BASE_WINDOW);
  const to = baseValueAt(points, 0, BASE_WINDOW);
  if (!from || from.value <= 0 || !to) return null;
  return to.value / from.value;
}

/**
 * 목표일에 가장 가까운 날. 동률이면 이른 날 (baseValueAt 과 같은 규칙 —
 * 두 탐색이 서로 다른 날을 고르면 같은 표 안에서 근거가 어긋난다).
 */
function nearestDay(days: number[], target: number, window: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const d of days) {
    const dist = Math.abs(d - target);
    if (dist > window) continue;
    if (dist < bestDist || (dist === bestDist && best !== null && d < best)) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * 구독 획득 효율 = 구간 구독자 증분 ÷ (구간 조회수 증분 / 1000).
 * "조회수 1,000회당 늘어난 구독자" — 영상 노출 없이 구독자만 늘면 값이 튄다.
 *
 * 구독자와 조회수를 **같은 날짜 쌍**에서 집는 것이 핵심이다. 각각 최근접
 * 날을 따로 고르면 구독자는 D-1, 조회수는 D-6 처럼 구간이 어긋나 비율이
 * 임의로 부풀거나 꺼진다. 그래서 두 지표가 모두 있는 날만 후보로 두고
 * 그 안에서 양 끝을 고른다. 호출부는 실측 점만 넘긴다(measuredOnly).
 *
 * 조회수 증분이 0 이하거나(수집 공백·정정) 쌍을 못 찾으면 null — 분모가
 * 0 에 가까울 때 나오는 무한대급 값을 지표처럼 보여주지 않는다.
 */
export function subsPer1kViews(
  subs: Map<number, AlignedValue>,
  views: Map<number, AlignedValue>,
  fromDay: number,
  fromWindow: number,
  toDay: number,
  toWindow: number,
): number | null {
  const common = [...subs.keys()].filter((d) => views.has(d));
  const a = nearestDay(common, fromDay, fromWindow);
  const b = nearestDay(common, toDay, toWindow);
  if (a == null || b == null) return null;
  // 두 탐색 폭이 겹치면(짧은 구간·넓은 창) 같은 날이나 뒤집힌 순서가 나올 수
  // 있다. 뒤집힌 구간은 증분의 부호가 통째로 반대라 "조회수가 줄었다"로
  // 읽히고, 아래 dViews > 0 가드에 우연히 걸려 조용히 null 이 되기도 한다 —
  // 그 우연에 기대지 않고 구간 자체를 여기서 명시적으로 거른다.
  if (a >= b) return null;
  const dViews = views.get(b)!.value - views.get(a)!.value;
  if (!(dViews > 0)) return null;
  const dSubs = subs.get(b)!.value - subs.get(a)!.value;
  return dSubs / (dViews / 1000);
}
