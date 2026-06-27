import { useMemo } from "preact/hooks";
import {
  QUADRANT_LABEL,
  computeScatterLayout,
  type QuadrantInput,
} from "../lib/breadthDepth";
import { colorOf } from "../design/groups";

// breadth(인지도) × depth(추정 적극코어) 산점도. 한 카테고리만 받는다(인지도가
// 카테고리-리더 상대값). 점 위치가 우위를 나타낸다 — 우상향일수록 인지·코어 모두
// 높다 → 같은 사분면 안에서도 서로간 우위가 위치로 읽힌다. 라벨은 우측 거터에
// de-collision + 리더선으로 정렬해 겹침 없이 모두 읽히게 한다.
export function BreadthDepthQuadrant({ points }: { points: QuadrantInput[] }) {
  const L = useMemo(() => computeScatterLayout(points), [points]);
  const { W, H, padL, padR, padT, padB } = L.geom;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x0 = padL, x1 = padL + plotW, y0 = padT, y1 = padT + plotH;
  const { xMedianPx: mx, yMedianPx: my } = L;

  if (!L.plottable) {
    return (
      <div class="text-hint text-zinc-600 px-2 py-3">
        인지도·추정 코어팬 둘 다 집계된 그룹이 2개 미만 — 포지셔닝 맵 생략.
      </div>
    );
  }

  return (
    <div class="card p-3 max-w-[600px]">
      <div class="mb-1 flex flex-wrap items-baseline gap-x-2">
        <span class="text-xs font-semibold text-zinc-300">넓이 × 깊이 포지셔닝</span>
        <span class="text-hint text-zinc-500">위치 = 우위 · 우상향일수록 인지·코어 모두 높음</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} class="w-full" role="img"
           aria-label="인지도 대 추정 코어팬 산점도 — 위치가 그룹 간 우위">
        {/* 4구역 배경 틴트 */}
        <rect x={x0} y={y0} width={mx - x0} height={my - y0} fill="rgba(56,189,248,0.06)" />
        <rect x={mx} y={y0} width={x1 - mx} height={my - y0} fill="rgba(52,211,153,0.07)" />
        <rect x={x0} y={my} width={mx - x0} height={y1 - my} fill="rgba(63,63,70,0.18)" />
        <rect x={mx} y={my} width={x1 - mx} height={y1 - my} fill="rgba(251,191,36,0.06)" />
        {/* 플롯 테두리 + 중앙값 십자선 */}
        <rect x={x0} y={y0} width={plotW} height={plotH} fill="none" stroke="#27272a" />
        <line x1={mx} y1={y0} x2={mx} y2={y1} stroke="#3f3f46" stroke-dasharray="3 3" />
        <line x1={x0} y1={my} x2={x1} y2={my} stroke="#3f3f46" stroke-dasharray="3 3" />
        {/* 사분면 코너 라벨 */}
        <text x={x1 - 4} y={y0 + 11} text-anchor="end" class="fill-zinc-600" font-size="8.5">{QUADRANT_LABEL.strong}</text>
        <text x={x1 - 4} y={y1 - 4} text-anchor="end" class="fill-zinc-600" font-size="8.5">{QUADRANT_LABEL.ad_driven}</text>
        <text x={x0 + 4} y={y0 + 11} text-anchor="start" class="fill-zinc-600" font-size="8.5">{QUADRANT_LABEL.niche}</text>
        <text x={x0 + 4} y={y1 - 4} text-anchor="start" class="fill-zinc-600" font-size="8.5">{QUADRANT_LABEL.low}</text>
        {/* 축 힌트 */}
        <text x={(x0 + x1) / 2} y={H - 4} text-anchor="middle" class="fill-zinc-500" font-size="8.5">인지도(넓이) →</text>
        <text x={10} y={(y0 + y1) / 2} text-anchor="middle" class="fill-zinc-500" font-size="8.5"
              transform={`rotate(-90 10 ${(y0 + y1) / 2})`}>추정 코어(깊이) ↑</text>
        {/* 리더선 + 라벨 (우측 거터) */}
        {L.labels.map((lb) => (
          <line key={`ln-${lb.key}`} x1={lb.cx} y1={lb.cy} x2={lb.lx - 3} y2={lb.ly}
                stroke="#3f3f46" stroke-width={0.75} />
        ))}
        {L.labels.map((lb) => {
          const cav = points.find((p) => p.key === lb.key)?.caveat;
          return (
            <text key={`tx-${lb.key}`} x={lb.lx} y={lb.ly + 3} text-anchor="start"
                  class={cav ? "fill-amber-400" : "fill-zinc-300"} font-size="9.5">
              {cav ? "⚠ " : ""}{lb.name}
            </text>
          );
        })}
        {/* 점 — 그룹 키컬러, caveat는 빨강 링 */}
        {L.dots.map((d) => (
          <g key={`dot-${d.key}`}>
            {d.caveat && <circle cx={d.cx} cy={d.cy} r={6.5} fill="none" stroke="#ef4444" stroke-width={1.3} />}
            <circle cx={d.cx} cy={d.cy} r={4.5} fill={colorOf(d.key)} fill-opacity={0.95} stroke="#09090b" stroke-width={0.8} />
          </g>
        ))}
      </svg>
      <div class="mt-1 text-hint text-zinc-600">
        십자선 = 카테고리 중앙값. 코어팬은 좋아요·댓글 추정(ground-truth 아님)·세로 log축.
        <span class="text-amber-400/80"> ⚠</span> = 영상 카탈로그 organicity 주의(인지도 점수엔 미반영).
      </div>
    </div>
  );
}
