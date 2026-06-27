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
