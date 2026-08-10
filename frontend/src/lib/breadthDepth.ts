// Pure geometry for the breadth(인지도) × 관여 팬 규모 2D quadrant.
// Awareness is category-leader-relative, so callers MUST pass one category's
// groups at a time — never mix K-POP and 서브컬처 on one crosshair.
//
// The crosshair sits at the category MEDIAN of each axis (relative position;
// honest for the small N per category). Classification uses raw y; the SVG
// layer positions y on a log1p scale so a 0-fan group is still plottable.
//
// y = est_engaged_fans(adj-first) — 2026-08-10 3-렌즈 패널 판정으로
// est_active_core(댓글 상위 5편, 비리더 9~55명)에서 교체: 그 범위는 추정
// 노이즈와 구분이 안 돼(±수 명이 사분면을 뒤집음) 판정 축 부적합. 관여 팬
// (좋아요 상위 5편, 76~22k)은 같은 "팬덤 규모" 개념이면서 변별력이 있고,
// 시장 개요 표의 "추정 관여 팬" 컬럼과 같은 값이라 화면 간 불일치도 없다.

export interface QuadrantInput {
  key: string;
  name: string;
  x: number;       // awareness score 0–100
  y: number;       // est_engaged_fans, adj-first (count >= 0)
  caveat: boolean; // organicity caution → ⚠ marker
}

export type QuadrantKey = "strong" | "ad_driven" | "niche" | "low";

// 명칭은 판결어가 아니라 전략 과제를 말한다(2026-08-10 패널): 실명 경쟁사가
// 찍히는 투자자 화면에서 "광고형"·"저조" 같은 낙인은 커뮤니케이션 리스크.
export const QUADRANT_LABEL: Record<QuadrantKey, string> = {
  strong:    "진성 강세",   // 고인지·두터운 팬덤
  ad_driven: "인지 선행",   // 고인지·얇은 팬덤 (도달≫전환 — 코어 전환 과제)
  niche:     "니치 충성",   // 저인지·두터운 팬덤 (도달 확장 과제)
  low:       "초기 단계",   // 양축 형성 전
};

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export interface QuadrantPoint extends QuadrantInput {
  quadrant: QuadrantKey;
  /** 어느 한 축이라도 중앙값 ±10% 이내 — 사분면 판정이 노이즈로 뒤집힐 수
      있는 경계권. 판정 문구는 이 플래그를 보고 단정을 유보해야 한다. */
  nearBoundary: boolean;
}

export interface QuadrantLayout {
  points: QuadrantPoint[];
  xMedian: number;
  yMedian: number;
  plottable: boolean; // false when < 2 finite points → caller shows a note
}

const BOUNDARY_BAND = 0.10;

function classify(x: number, y: number, xMed: number, yMed: number): QuadrantKey {
  const right = x >= xMed;
  const top = y >= yMed;
  if (right && top) return "strong";
  if (right && !top) return "ad_driven";
  if (!right && top) return "niche";
  return "low";
}

function nearMedian(v: number, med: number): boolean {
  if (med === 0) return v === 0;
  return Math.abs(v - med) <= BOUNDARY_BAND * Math.abs(med);
}

export function computeQuadrantLayout(input: QuadrantInput[]): QuadrantLayout {
  const valid = input.filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
  if (valid.length < 2) {
    return {
      points: valid.map((pt) => ({
        ...pt, quadrant: "low" as QuadrantKey, nearBoundary: false,
      })),
      xMedian: 0, yMedian: 0, plottable: false,
    };
  }
  const xMedian = median(valid.map((pt) => pt.x));
  const yMedian = median(valid.map((pt) => pt.y));
  const points = valid.map((pt) => ({
    ...pt,
    quadrant: classify(pt.x, pt.y, xMedian, yMedian),
    nearBoundary: nearMedian(pt.x, xMedian) || nearMedian(pt.y, yMedian),
  }));
  return { points, xMedian, yMedian, plottable: true };
}

// ── 읽히는 산점도(포지셔닝 맵) ────────────────────────────────────────────
// 위치가 우위를 나타낸다: 우상향일수록 인지(x)·코어(y) 모두 높다 → 같은 사분면
// 안에서도 서로간 우위가 위치로 보인다. 라벨이 겹쳐 못 읽히던 문제는 라벨을
// 우측 거터에 세로 de-collision + 리더선으로 정렬해 해결한다.

export interface ScatterGeom { W: number; H: number; padL: number; padR: number; padT: number; padB: number }
// padR은 라벨 거터(우측), padL은 y 눈금 숫자 자리. plotW = W - padL - padR.
export const SCATTER_GEOM: ScatterGeom = { W: 420, H: 300, padL: 44, padR: 104, padT: 16, padB: 30 };

export interface ScatterDot { key: string; name: string; caveat: boolean; quadrant: QuadrantKey; cx: number; cy: number }
export interface ScatterLabel { key: string; name: string; cx: number; cy: number; lx: number; ly: number }
export interface ScatterTick { value: number; px: number }
export interface ScatterLayout {
  dots: ScatterDot[];
  labels: ScatterLabel[];
  xMedianPx: number;
  yMedianPx: number;
  /** 십자선 원값 — 화면에 기준값을 명시하기 위해 노출. */
  xMedian: number;
  yMedian: number;
  /** y(log1p) 눈금: 10^k (데이터 범위 내). "숫자가 보이는 축" 요건. */
  yTicks: ScatterTick[];
  /** x(선형 0~100) 눈금. */
  xTicks: ScatterTick[];
  plottable: boolean;
  geom: ScatterGeom;
}

const log1p = (v: number) => Math.log1p(Math.max(0, v));

/** 라벨 세로 위치 de-collision: cy 오름차순으로 최소간격 보장 후 [top,bottom] 클램프.
 *  반환은 입력(index) 순서. 위치는 흔들되 점-라벨 매칭(리더선)은 유지. */
export function declutterLabels(cys: number[], minGap: number, top: number, bottom: number): number[] {
  const order = cys.map((cy, i) => ({ i, cy })).sort((a, b) => a.cy - b.cy);
  const out = new Array<number>(cys.length);
  let last = -Infinity;
  for (const o of order) { const y = Math.max(o.cy, last + minGap); out[o.i] = y; last = y; }
  const lastI = order[order.length - 1]?.i;
  if (lastI != null && out[lastI]! > bottom) {
    const shift = out[lastI]! - bottom;
    for (const o of order) out[o.i]! -= shift;          // 아래 넘침 → 전체 위로
  }
  const firstI = order[0]?.i;
  if (firstI != null && out[firstI]! < top) {
    let l = top - minGap;
    for (const o of order) { const y = Math.max(out[o.i]!, l + minGap); out[o.i] = y; l = y; } // 위 넘침 → 아래로 재분산
  }
  return out;
}

/** 산점도 좌표 + 거터 라벨 위치. 분류·중앙값은 computeQuadrantLayout 재사용. */
export function computeScatterLayout(input: QuadrantInput[], geom: ScatterGeom = SCATTER_GEOM): ScatterLayout {
  const base = computeQuadrantLayout(input);
  const { W, H, padL, padR, padT, padB } = geom;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxY = Math.max(...base.points.map((p) => p.y), 1);
  const sx = (x: number) => padL + (Math.max(0, Math.min(100, x)) / 100) * plotW;
  const sy = (y: number) => padT + plotH - (log1p(y) / (log1p(maxY) || 1)) * plotH;

  const dots: ScatterDot[] = base.points.map((p) => ({
    key: p.key, name: p.name, caveat: p.caveat, quadrant: p.quadrant, cx: sx(p.x), cy: sy(p.y),
  }));

  const labelX = W - padR + 8;
  const lys = declutterLabels(dots.map((d) => d.cy), 14, padT + 6, padT + plotH - 2);
  const labels: ScatterLabel[] = dots.map((d, i) => ({
    key: d.key, name: d.name, cx: d.cx, cy: d.cy, lx: labelX, ly: lys[i]!,
  }));

  // y 눈금 = 데이터 범위 내 10의 거듭제곱 (log 축을 숫자로 읽게 하는 장치).
  const yTicks: ScatterTick[] = [];
  for (let v = 10; v <= maxY; v *= 10) yTicks.push({ value: v, px: sy(v) });
  const xTicks: ScatterTick[] = [0, 50, 100].map((v) => ({ value: v, px: sx(v) }));

  return {
    dots, labels,
    xMedianPx: sx(base.xMedian),
    yMedianPx: sy(base.yMedian),
    xMedian: base.xMedian,
    yMedian: base.yMedian,
    yTicks, xTicks,
    plottable: base.plottable,
    geom,
  };
}
