import { Sparkline } from "./Sparkline";

interface Broadcast { video_id: string; peak: number; last_at: string; }
export interface FanLoyalty {
  conversion_rate: number | null;
  peak_ccv_median: number | null;
  broadcast_count: number;
  subscribers: number | null;
  score: number | null;
  basis: "scored" | "low_confidence" | "insufficient";
  ccv_trend_pct: number | null;
  trend_basis: "rising" | "falling" | "flat" | "unknown";
  window_days: number;
  broadcasts: Broadcast[];
}

export function fmtPct(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

export function trendLabel(
  basis: FanLoyalty["trend_basis"],
  pct: number | null,
): string {
  if (basis === "unknown" || pct == null) return "추세 보류";
  if (basis === "flat") return "→ 유지";
  const sign = pct > 0 ? "+" : "";
  const arrow = basis === "rising" ? "▲" : "▼";
  return `${arrow} ${sign}${Math.round(pct * 100)}%`;
}

function scoreColor(score: number | null): string {
  if (score == null) return "text-zinc-500";
  if (score >= 88) return "text-emerald-400";
  if (score >= 70) return "text-lime-400";
  if (score >= 50) return "text-amber-400";
  return "text-red-400";
}


export function FanLoyaltyCard({ loyalty }: { loyalty: FanLoyalty }) {
  const { basis, score, conversion_rate, trend_basis, ccv_trend_pct,
          broadcast_count, window_days, broadcasts } = loyalty;

  return (
    <section class="rounded-lg border border-zinc-800 p-3">
      <div class="mb-1 flex items-baseline justify-between">
        <h3 class="text-sm font-semibold">팬 충성도 (라이브 전환율)</h3>
        <span class="text-hint text-zinc-500">최근 {window_days}일 · 방송 {broadcast_count}회</span>
      </div>

      {basis === "insufficient" ? (
        <div class="text-data text-zinc-500">라이브 데이터 축적 중</div>
      ) : (
        <div class="flex items-center gap-4">
          <div class="flex items-baseline gap-2">
            <span class={`text-2xl font-bold tabular-nums ${scoreColor(score)}`}>
              {score != null ? Math.round(score) : "—"}
            </span>
            <span class="text-data text-zinc-400">
              전환율 {fmtPct(conversion_rate)}
            </span>
          </div>
          <div class={
            trend_basis === "rising" ? "text-data text-emerald-400"
            : trend_basis === "falling" ? "text-data text-red-400"
            : "text-data text-zinc-500"
          }>
            {trendLabel(trend_basis, ccv_trend_pct)}
          </div>
          {broadcasts.length >= 2 && (
            <div class="ml-auto">
              <Sparkline points={broadcasts.map((b) => b.peak)} width={120} height={28} />
            </div>
          )}
        </div>
      )}

      {basis === "low_confidence" && (
        <div class="mt-1 text-hint text-amber-500/80">단발 방송 기준 — 신뢰도 낮음</div>
      )}
      <div class="mt-2 text-hint text-zinc-500">
        충성도 = 구독자 중 라이브 전환율(규모 무관). 절대 시청자 수와 별개.
      </div>
    </section>
  );
}
