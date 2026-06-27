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
