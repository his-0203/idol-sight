// frontend/src/components/GrowthTrajectoryPanel.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

interface Pillar {
  key: string;
  /** Raw floats retained from worker contract for future tooltip use; not currently rendered in UI. */
  level: number | null;
  wow_growth: number | null;
  slope_4w: number | null;
  accel: number;
  direction: string;   // climbing | plateau | declining | unknown
  accel_dir: string;   // accelerating | flat | decelerating
}
interface Trajectory {
  status: string;       // ok | insufficient_history | no_data
  computed_at?: string;
  history_days?: number;
  posture_label?: string | null;
  weakest_pillar?: string | null;
  pillars?: Pillar[];
}

const PILLAR_LABEL: Record<string, string> = {
  reach: "도달 성장", engagement: "호응 품질",
  community: "커뮤니티 모멘텀", sentiment: "여론",
};
const DIR_ARROW: Record<string, string> = {
  climbing: "↗", plateau: "→", declining: "↘", unknown: "·",
};
const DIR_COLOR: Record<string, string> = {
  climbing: "#22c55e", plateau: "#a1a1aa", declining: "#ef4444", unknown: "#71717a",
};
const ACCEL_LABEL: Record<string, string> = {
  accelerating: "가속", flat: "—", decelerating: "감속",
};

function fmtWoW(p: Pillar): string {
  if (p.wow_growth === null) return "—";
  if (p.key === "engagement") return `ER ${(p.wow_growth * 100).toFixed(2)}%p`;
  // sentiment: wow_growth is raw negative_ratio delta (negative = healthier).
  // Arrow already conveys health direction; show the raw %p change as
  // "부정 여론 변화" so a negative number with a green arrow is legible.
  if (p.key === "sentiment") return `부정 ${(p.wow_growth * 100).toFixed(1)}%p`;
  return `${p.wow_growth >= 0 ? "+" : ""}${(p.wow_growth * 100).toFixed(0)}%/주`;
}

export function GrowthTrajectoryPanel({ groupKey }: { groupKey: string }) {
  const [data, setData] = useState<Trajectory | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.growthTrajectory<Trajectory>(groupKey)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData({ status: "no_data" }); });
    return () => { cancelled = true; };
  }, [groupKey]);

  if (!data) return <div class="text-zinc-500 text-sm">Loading…</div>;

  if (data.status === "no_data") {
    return (
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
        아직 성장 궤적 데이터가 없습니다. (다음 집계 cron 이후 표시)
      </div>
    );
  }
  if (data.status === "insufficient_history") {
    return (
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
        데이터 축적 중 ({data.history_days ?? 0}일 / 최소 14일). 궤적은 14일 이상부터 표시됩니다.
      </div>
    );
  }
  if (data.status !== "ok") {
    return (
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
        아직 성장 궤적 데이터가 없습니다. (다음 집계 cron 이후 표시)
      </div>
    );
  }

  const pillars = data.pillars ?? [];
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div class="mb-3 flex items-baseline justify-between">
        <h3 class="section-title">성장 궤적</h3>
        <span class="text-lg font-semibold text-zinc-100">{data.posture_label ?? "—"}</span>
      </div>
      <div class="space-y-2">
        {pillars.map((p) => (
          <div key={p.key} class="flex items-center gap-3 text-sm">
            <span class="w-28 shrink-0 text-zinc-300">{PILLAR_LABEL[p.key] ?? p.key}</span>
            <span class="w-28 shrink-0 tabular-nums text-zinc-400">{fmtWoW(p)}</span>
            <span class="w-6 shrink-0 text-center" style={{ color: DIR_COLOR[p.direction] }}>
              {DIR_ARROW[p.direction] ?? "·"}
            </span>
            <span class="text-zinc-500">{ACCEL_LABEL[p.accel_dir] ?? "—"}</span>
            {data.weakest_pillar === p.key && (
              <span class="ml-auto rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-200">
                ⚠ 가장 약한 궤적
              </span>
            )}
          </div>
        ))}
      </div>
      <p class="mt-3 text-[11px] leading-relaxed text-zinc-500">
        자기 과거 대비(WoW + 4주 추세 + 가속) · 등급 아닌 방향 사실 · 여론 화살표=건강방향(↗=부정여론 감소) · 휴리스틱 추정(ground-truth 아님, 인간 검증 필요).
      </p>
    </div>
  );
}
