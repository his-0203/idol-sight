import { formatKSTMonthDayWeekday } from "../lib/datetime";

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

/** Depth-bar width (0~100) for a peak relative to the set's max. Guards
 *  against a zero/negative max so an all-zero set renders empty bars. */
export function barWidthPct(peak: number, maxPeak: number): number {
  if (maxPeak <= 0) return 0;
  return (peak / maxPeak) * 100;
}

/** Index of the row whose peak is closest to `peakMedian` — the basis of
 *  the loyalty score. Returns null when there are fewer than 3 broadcasts
 *  (median coincides with the latest/only value, not worth marking) or no
 *  median is available. Ties resolve to the first (latest) row. */
export function medianRowIndex(
  broadcasts: Broadcast[],
  peakMedian: number | null,
): number | null {
  if (peakMedian == null || broadcasts.length < 3) return null;
  let best = 0;
  let bestDist = Infinity;
  broadcasts.forEach((b, i) => {
    const dist = Math.abs(b.peak - peakMedian);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
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
          broadcast_count, window_days, broadcasts, peak_ccv_median } = loyalty;

  // Ladder rows: newest on top. API hands us oldest→newest, so reverse.
  const rows = [...broadcasts].reverse();
  const maxPeak = rows.reduce((m, b) => Math.max(m, b.peak), 0);
  const medianIdx = medianRowIndex(rows, peak_ccv_median);

  return (
    <section class="rounded-lg border border-zinc-800 p-3">
      <div class="mb-1 flex items-baseline justify-between">
        <h3 class="text-sm font-semibold">팬 충성도 (라이브 전환율)</h3>
        <span class="text-hint text-zinc-500">최근 {window_days}일 · 방송 {broadcast_count}회</span>
      </div>

      {basis === "insufficient" ? (
        <div class="text-data text-zinc-500">라이브 데이터 축적 중</div>
      ) : (
        <>
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
          </div>

          {rows.length > 0 && (
            <div class="mt-3 border-t border-zinc-800/70 pt-2.5">
              <div class="mb-1.5 flex justify-between text-hint text-zinc-400">
                <span>방송별 최고 동시 시청자</span>
                <span>peak CCV</span>
              </div>
              {rows.map((b, i) => {
                const latest = i === 0;
                const isMedian = i === medianIdx;
                return (
                  <div
                    key={b.video_id}
                    class={`relative grid grid-cols-[60px_1fr_auto] items-center gap-2.5 rounded px-1 ${
                      latest ? "bg-teal-500/10" : ""
                    } ${isMedian ? "shadow-[inset_2px_0_0_rgba(161,161,170,0.55)]" : ""}`}
                    style="height:24px"
                  >
                    <span class="z-10 text-hint tabular-nums text-zinc-400">
                      {formatKSTMonthDayWeekday(b.last_at)}
                    </span>
                    <div class="relative h-3.5">
                      <div
                        class={`absolute left-0 top-0 h-full rounded-sm ${
                          latest ? "bg-teal-500/45" : "bg-teal-500/25"
                        }`}
                        style={`width:${barWidthPct(b.peak, maxPeak)}%`}
                      />
                    </div>
                    {isMedian && (
                      <span class="absolute right-[60px] top-1/2 z-10 -translate-y-1/2 text-[9px] text-zinc-400">
                        중앙값
                      </span>
                    )}
                    <span class={`z-10 min-w-[52px] text-right text-data tabular-nums ${
                      latest ? "font-semibold text-teal-300" : "text-zinc-200"
                    }`}>
                      {b.peak.toLocaleString()}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
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
