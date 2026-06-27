import { useMemo } from "preact/hooks";
import {
  QUADRANT_LABEL,
  computeQuadrantLayout,
  type QuadrantInput,
  type QuadrantKey,
  type QuadrantPoint,
} from "../lib/breadthDepth";

// Quadrant accent tones — green=진성, amber=광고형(주의), sky=니치, muted=저조.
const QUADRANT_TONE: Record<QuadrantKey, string> = {
  strong: "text-emerald-400",
  ad_driven: "text-amber-400",
  niche: "text-sky-400",
  low: "text-zinc-500",
};

function Chip({ pt }: { pt: QuadrantPoint }) {
  return (
    <span
      class={
        "rounded px-1.5 py-0.5 text-[11px] border whitespace-nowrap " +
        (pt.caveat
          ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
          : "border-zinc-600 bg-zinc-800/70 text-zinc-200")
      }
      title={
        `인지도 ${Math.round(pt.x)} · 추정 적극코어 ~${pt.y.toLocaleString()}` +
        (pt.caveat ? " · 영상 카탈로그 organicity 주의(점수 미반영)" : "")
      }
    >
      {pt.name}
      {pt.caveat ? " ⚠" : ""}
    </span>
  );
}

function Cell({ label, tone, pts }: { label: string; tone: string; pts: QuadrantPoint[] }) {
  return (
    <div class="rounded-md border border-zinc-700/70 bg-zinc-900/40 p-2">
      <div class={"mb-1.5 text-[11px] font-semibold " + tone}>{label}</div>
      {pts.length === 0 ? (
        <span class="text-[11px] text-zinc-600">(없음)</span>
      ) : (
        <div class="flex flex-wrap gap-1">
          {pts.map((pt) => (
            <Chip key={pt.key} pt={pt} />
          ))}
        </div>
      )}
    </div>
  );
}

/** breadth(인지도) × depth(추정 적극코어) 2×2 사분면 그리드. 한 카테고리만 받는다
 *  (인지도가 카테고리-리더 상대값이라 교차 비교 불가). 점을 정밀 좌표로 찍는 대신
 *  카테고리 중앙값 기준 사분면별로 그룹을 칩으로 묶어 보여준다 — 합치지 않고 함께 읽기. */
export function BreadthDepthQuadrant({ points }: { points: QuadrantInput[] }) {
  const layout = useMemo(() => computeQuadrantLayout(points), [points]);

  // Group points by quadrant, each cell sorted by 인지도(x) desc → 코어(y) desc.
  const byQuadrant = useMemo(() => {
    const buckets: Record<QuadrantKey, QuadrantPoint[]> = {
      strong: [], ad_driven: [], niche: [], low: [],
    };
    for (const pt of layout.points) buckets[pt.quadrant].push(pt);
    for (const k of Object.keys(buckets) as QuadrantKey[]) {
      buckets[k].sort((a, b) => b.x - a.x || b.y - a.y);
    }
    return buckets;
  }, [layout]);

  if (!layout.plottable) {
    return (
      <div class="text-hint text-zinc-600 px-2 py-3">
        인지도·추정 코어팬 둘 다 집계된 그룹이 2개 미만 — 사분면 생략.
      </div>
    );
  }

  return (
    <div class="card p-3">
      <div class="mb-2 flex flex-wrap items-baseline gap-x-2">
        <span class="text-xs font-semibold text-zinc-300">넓이 × 깊이</span>
        <span class="text-hint text-zinc-500">
          인지도 × 추정 코어팬 — 합치지 않고 함께 읽기
        </span>
      </div>

      <div class="flex gap-1.5">
        {/* 세로축(깊이) 라벨 */}
        <div class="flex w-7 shrink-0 flex-col text-center text-[10px] leading-tight text-zinc-500">
          <div class="h-4" />
          <div class="flex flex-1 flex-col justify-around">
            <span>강한<br />코어</span>
            <span>약한<br />코어</span>
          </div>
        </div>

        <div class="flex-1">
          {/* 가로축(인지도) 헤더 */}
          <div class="mb-1 grid grid-cols-2 gap-1.5 text-[10px] text-zinc-500">
            <div class="text-center">← 낮은 인지도</div>
            <div class="text-center">높은 인지도 →</div>
          </div>
          {/* 2×2 셀: 상=강한코어, 하=약한코어 / 좌=낮은인지도, 우=높은인지도 */}
          <div class="grid grid-cols-2 gap-1.5">
            <Cell label={QUADRANT_LABEL.niche}     tone={QUADRANT_TONE.niche}     pts={byQuadrant.niche} />
            <Cell label={QUADRANT_LABEL.strong}    tone={QUADRANT_TONE.strong}    pts={byQuadrant.strong} />
            <Cell label={QUADRANT_LABEL.low}       tone={QUADRANT_TONE.low}       pts={byQuadrant.low} />
            <Cell label={QUADRANT_LABEL.ad_driven} tone={QUADRANT_TONE.ad_driven} pts={byQuadrant.ad_driven} />
          </div>
        </div>
      </div>

      <div class="mt-2 text-hint text-zinc-600">
        경계 = 카테고리 중앙값(상대 위치). 코어팬은 좋아요·댓글 추정(ground-truth 아님).
        <span class="text-orange-400/80"> ⚠</span> = 영상 카탈로그 organicity 주의(인지도 점수엔 미반영).
      </div>
    </div>
  );
}
