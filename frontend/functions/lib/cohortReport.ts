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
