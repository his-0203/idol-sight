import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { writeState } from "../router";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { ExportMenu } from "../components/ExportMenu";
import { ShareLink } from "../components/ShareLink";
import { HealthSpec } from "../components/HealthSpec";
import { colorOf, fillOf } from "../design/groups";
import { gradeClasses } from "../design/grades";
import { fmtScale, fmtTooltipCallback } from "../design/chart-defaults";

// Sort group entries by descending share — uses the latest market_share row
// per group_key when available, falling back to summary.yt_total_views so a
// group without a share row never disappears from the grid.
function sortByShare(
  entries: Array<[string, any]>,
  shareRows: Array<{ week_end: string; group_key: string; final: number }> | undefined,
): Array<[string, any]> {
  let latestByKey: Record<string, number> = {};
  if (shareRows && shareRows.length) {
    const latestWeek = [...new Set(shareRows.map((r) => r.week_end))].sort().pop();
    for (const r of shareRows) {
      if (r.week_end === latestWeek) latestByKey[r.group_key] = r.final ?? 0;
    }
  }
  return [...entries].sort(([ka, ga], [kb, gb]) => {
    const a = latestByKey[ka] ?? ga.summary?.yt_total_views ?? 0;
    const b = latestByKey[kb] ?? gb.summary?.yt_total_views ?? 0;
    return b - a;
  });
}

// Compute (currentWeekShare, previousWeekShare) per group_key from share.rows.
// Used to render the ▲/▼ delta chip on each card.
function shareDeltaByKey(
  shareRows: Array<{ week_end: string; group_key: string; final: number }> | undefined,
): Record<string, { current: number; prev: number | null }> {
  if (!shareRows || !shareRows.length) return {};
  const weeks = [...new Set(shareRows.map((r) => r.week_end))].sort();
  const current = weeks[weeks.length - 1];
  const prev = weeks.length >= 2 ? weeks[weeks.length - 2] : null;
  const out: Record<string, { current: number; prev: number | null }> = {};
  for (const r of shareRows) {
    const slot = out[r.group_key] ?? { current: 0, prev: null };
    if (r.week_end === current) slot.current = r.final ?? 0;
    if (prev && r.week_end === prev) slot.prev = r.final ?? 0;
    out[r.group_key] = slot;
  }
  return out;
}

export function MarketOverview() {
  const [market, setMarket] = useState<any>(null);
  const [share, setShare] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [excludePlave, setExcludePlave] = useState(false);
  const shareCanvas = useRef<HTMLCanvasElement | null>(null);
  const shareChart = useRef<Chart | null>(null);

  useEffect(() => {
    api.market().then(setMarket);
    api.marketShare(13).then(setShare);
    api.meta().then(setMeta);
  }, []);

  // Market share trend (line, color = group). We dropped the stacked-area
  // + log-scale combo because stacking + log is mathematically meaningless
  // (you cannot add log values), and a line per group reads more cleanly
  // on a small chart.
  useEffect(() => {
    if (!share || !shareCanvas.current) return;
    const ctx = shareCanvas.current;
    const weeks = Array.from(new Set<string>(share.rows.map((r: any) => r.week_end))).sort();
    const groupKeys = Array.from(new Set<string>(share.rows.map((r: any) => r.group_key)));
    const filtered = excludePlave ? groupKeys.filter((k) => k !== "plave") : groupKeys;
    const datasets = filtered.map((k) => ({
      label: k,
      data: weeks.map((w) => {
        const row = share.rows.find((r: any) => r.week_end === w && r.group_key === k);
        return row?.final ?? 0;
      }),
      borderColor: colorOf(k),
      backgroundColor: fillOf(k, 0.15),
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.25,
      fill: false,
    }));
    shareChart.current?.destroy();
    shareChart.current = new Chart(ctx, {
      type: "line",
      data: { labels: weeks, datasets },
      options: {
        scales: {
          y: {
            title: { display: true, text: "점유율 (%)" },
            ticks: { callback: (v) => fmtScale(v as number) },
          },
          x: { title: { display: true, text: "주차" } },
        },
        plugins: {
          legend: { position: "bottom" },
          tooltip: { callbacks: { label: fmtTooltipCallback() } },
        },
      },
    });
  }, [share, excludePlave]);

  const sortedEntries = useMemo(
    () => (market ? sortByShare(Object.entries(market.groups), share?.rows) : []),
    [market, share],
  );
  const deltas = useMemo(() => shareDeltaByKey(share?.rows), [share]);

  if (!market) return <div class="p-4 text-zinc-500">Loading…</div>;

  return (
    <div class="space-y-6">
      {/* freshness banner */}
      <div class="flex flex-wrap items-center gap-2">
        {meta && (
          <FreshnessBadge label="전체"
            lastSuccessAt={meta.global_last_success_at}
            intervalH={1} />
        )}
        <div class="ml-auto flex items-center gap-1">
          <ShareLink />
        </div>
      </div>

      {/* group cards — all eight cards share the SAME scale (grade letter
          primary, absolute values demoted to small supporting label).
          Tiered visual weight: rank 1~3 = display, 4~6 = base, 7~8 = muted.
          ▲/▼ chip surfaces week-over-week share movement so the operator
          knows which groups are gaining/losing without scrolling to SOV. */}
      <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
        {sortedEntries.map(([key, g]: any, i: number) => {
          const hs = g.health_score;
          const grade = hs?.grade ?? "PRE";
          const total = hs?.total;
          const fallback = g.summary?.yt_subscribers ?? g.summary?.yt_total_views ?? null;
          const d = deltas[key];
          const dpp = d && d.prev != null ? d.current - d.prev : null;
          const tier = i < 3 ? "primary" : i < 6 ? "base" : "muted";
          return (
            <button
              key={key}
              onClick={() => writeState({ tab: "content", group: key })}
              class={
                "card border-l-4 p-3 text-left transition-colors hover:border-brand " +
                (i === 0 ? "md:col-span-2 " : "") +
                (tier === "muted" ? "opacity-80 " : "")
              }
              style={{ borderLeftColor: colorOf(key) }}
              aria-label={`${g.name} 상세 보기`}
            >
              <div class="flex items-baseline justify-between gap-2">
                <div class="font-semibold">{g.name}</div>
                {dpp != null && (
                  <span
                    class={
                      "rounded-chip border px-1.5 text-hint tabular-nums " +
                      (dpp > 0.05
                        ? "border-emerald-500/40 text-emerald-400"
                        : dpp < -0.05
                        ? "border-red-500/40 text-red-400"
                        : "border-zinc-700 text-zinc-500")
                    }
                  >
                    {dpp > 0 ? "▲" : dpp < 0 ? "▼" : "·"} {Math.abs(dpp).toFixed(1)}pp
                  </span>
                )}
              </div>
              <div class="text-hint text-zinc-500">{g.name_kr}</div>
              <div class={`mt-2 flex items-baseline gap-2 ${tier === "primary" ? "text-3xl" : tier === "base" ? "text-2xl" : "text-xl"}`}>
                <span class={`rounded-chip border px-2 font-bold ${gradeClasses(grade)}`}>
                  {grade}
                </span>
                <span class="text-hint text-zinc-500 tabular-nums">
                  {total != null
                    ? `${total}점`
                    : fallback != null
                    ? `${fmt(fallback)} 구독`
                    : "집계 대기"}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* SOV (Share of Voice) — line chart for ≥2 weeks, bar fallback for 1 week.
          Renamed from "Market Share" in V2: the 8-group cohort isn't a real
          market with a defined denominator (Circle Chart, etc.), so the
          honest label is Share of Voice. The SOV mix is now percentile-rank
          weighted across yt_views (30%) / community (25%) / news (20%) /
          subscribers (15%) / twitter (10%) instead of raw-summing different
          unit signals. */}
      {(() => {
        const distinctWeeks = share
          ? Array.from(new Set<string>(share.rows.map((r: any) => r.week_end)))
          : [];
        const hasTrend = distinctWeeks.length >= 2;
        return (
          <section class="card">
            <div class="mb-2 flex flex-wrap items-center gap-2 text-data">
              <h3 class="section-title">
                Share of Voice {hasTrend ? "Trend (13주)" : "(현재 주)"}
              </h3>
              <span class="text-hint text-zinc-500">
                코호트 percentile 가중합 — yt 30% / 커뮤 25% / 뉴스 20% / 구독 15% / 트윗 10%
              </span>
              <HealthSpec />
              {hasTrend && (
                <label class="ml-auto flex items-center gap-1 text-hint text-zinc-400">
                  <input type="checkbox" checked={excludePlave}
                         onChange={(e: any) => setExcludePlave(e.currentTarget.checked)} />
                  PLAVE 제외
                </label>
              )}
              <ExportMenu canvas={shareCanvas.current ?? undefined}
                           rows={share?.rows ?? []}
                           filenameBase="share-of-voice" />
            </div>
            {hasTrend ? (
              <div class="h-48 md:h-72"><canvas ref={shareCanvas}></canvas></div>
            ) : share && share.rows.length > 0 ? (
              <>
                <div class="mb-2 text-hint text-zinc-500">
                  추이 그래프는 데이터 2주 이상 누적 시 활성화됩니다 (현재 1주차).
                  지금은 이번 주 점유율만 표시.
                </div>
                <ul class="space-y-1.5">
                  {[...share.rows].sort((a: any, b: any) => b.final - a.final).map((r: any) => (
                    <li key={r.group_key} class="flex items-center gap-2 text-data">
                      <span class="w-20 shrink-0 truncate"
                            style={{ color: colorOf(r.group_key) }}>
                        {(market.groups[r.group_key]?.name) ?? r.group_key.toUpperCase()}
                      </span>
                      <div class="relative h-2 flex-1 overflow-hidden rounded bg-zinc-800/60">
                        <div class="absolute inset-y-0 left-0"
                             style={{
                               width: `${Math.min(r.final, 100)}%`,
                               background: colorOf(r.group_key),
                             }} />
                      </div>
                      <span class="w-14 shrink-0 text-right tabular-nums">
                        {r.final.toFixed(1)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div class="text-hint text-zinc-500">아직 점유율 데이터가 없습니다.</div>
            )}
          </section>
        );
      })()}
    </div>
  );
}
