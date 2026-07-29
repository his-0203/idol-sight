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
