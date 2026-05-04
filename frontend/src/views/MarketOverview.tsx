import { useEffect, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { writeState } from "../router";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { ExportMenu } from "../components/ExportMenu";
import { ShareLink } from "../components/ShareLink";
import { HealthSpec } from "../components/HealthSpec";
import { SourceRef } from "../components/SourceRef";

const GRADE_COLORS: Record<string, string> = {
  S: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
  A: "text-blue-400    border-blue-500/40    bg-blue-500/10",
  B: "text-violet-400  border-violet-500/40  bg-violet-500/10",
  C: "text-amber-400   border-amber-500/40   bg-amber-500/10",
  D: "text-red-400     border-red-500/40     bg-red-500/10",
  PRE: "text-zinc-400  border-zinc-500/40    bg-zinc-500/10",
};

export function MarketOverview() {
  const [market, setMarket] = useState<any>(null);
  const [share, setShare] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [excludePlave, setExcludePlave] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const shareCanvas = useRef<HTMLCanvasElement | null>(null);
  const shareChart = useRef<Chart | null>(null);
  const ytCanvas = useRef<HTMLCanvasElement | null>(null);
  const ytChart = useRef<Chart | null>(null);

  useEffect(() => {
    api.market().then(setMarket);
    api.marketShare(13).then(setShare);
    api.meta().then(setMeta);
  }, []);

  // Market share trend (stacked area)
  useEffect(() => {
    if (!share || !shareCanvas.current) return;
    const ctx = shareCanvas.current;
    const weeks = Array.from(new Set<string>(share.rows.map((r: any) => r.week_end))).sort();
    const groupKeys = Array.from(new Set<string>(share.rows.map((r: any) => r.group_key)));
    const filtered = excludePlave ? groupKeys.filter((k) => k !== "plave") : groupKeys;
    const datasets = filtered.map((k, i) => ({
      label: k,
      data: weeks.map((w) => {
        const row = share.rows.find((r: any) => r.week_end === w && r.group_key === k);
        return row?.final ?? 0;
      }),
      backgroundColor: `hsl(${(i * 47) % 360},65%,55%)`,
      borderWidth: 0,
      fill: true,
    }));
    shareChart.current?.destroy();
    shareChart.current = new Chart(ctx, {
      type: "line",
      data: { labels: weeks, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          y: { stacked: true, type: logScale ? "logarithmic" : "linear",
               title: { display: true, text: "share %" } },
          x: { stacked: true },
        },
        plugins: { legend: { position: "bottom" } },
      },
    });
  }, [share, excludePlave, logScale]);

  // YT views bar
  useEffect(() => {
    if (!market || !ytCanvas.current) return;
    const ctx = ytCanvas.current;
    const groups = Object.entries(market.groups);
    ytChart.current?.destroy();
    ytChart.current = new Chart(ctx, {
      type: "bar",
      data: {
        labels: groups.map(([_, g]: any) => g.name),
        datasets: [{
          label: "yt_total_views",
          data: groups.map(([_, g]: any) => g.summary?.yt_total_views ?? 0),
          backgroundColor: "rgb(139 92 246 / 0.6)",
        }],
      },
      options: { responsive: true, maintainAspectRatio: false,
                 plugins: { legend: { display: false } } },
    });
  }, [market]);

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

      {/* group cards */}
      <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
        {Object.entries(market.groups).map(([key, g]: any) => (
          <button
            key={key}
            onClick={() => writeState({ tab: "content", group: key })}
            class="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-left hover:border-violet-500/50"
          >
            <div class="flex items-baseline justify-between">
              <div class="font-semibold">{g.name}</div>
              <span class={`rounded border px-1.5 text-xs ${GRADE_COLORS[g.health_score?.grade ?? "PRE"]}`}>
                {g.health_score?.grade ?? "PRE"}
              </span>
            </div>
            <div class="text-xs text-zinc-500">{g.name_kr}</div>
            <div class="mt-2 text-xl font-bold">
              {g.health_score?.total ?? "—"}
            </div>
            <div class="text-[10px] text-zinc-500">
              YT {fmt(g.summary?.yt_total_views ?? 0)} · DC {fmt(g.summary?.dc_total_posts ?? 0)} · News {g.summary?.naver_total_news ?? 0}
            </div>
          </button>
        ))}
      </div>

      {/* market share chart */}
      <section class="rounded-lg border border-zinc-800 p-3">
        <div class="mb-2 flex items-center gap-2 text-sm">
          <h3 class="font-semibold">Market Share Trend (13주)</h3>
          <HealthSpec />
          <label class="ml-auto flex items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" checked={excludePlave}
                   onChange={(e: any) => setExcludePlave(e.currentTarget.checked)} />
            PLAVE 제외
          </label>
          <label class="flex items-center gap-1 text-xs text-zinc-400">
            <input type="checkbox" checked={logScale}
                   onChange={(e: any) => setLogScale(e.currentTarget.checked)} />
            로그 스케일
          </label>
          <ExportMenu canvas={shareCanvas.current ?? undefined}
                       rows={share?.rows ?? []}
                       filenameBase="market-share" />
        </div>
        <div class="h-72"><canvas ref={shareCanvas}></canvas></div>
      </section>

      {/* YT views bar */}
      <section class="rounded-lg border border-zinc-800 p-3">
        <div class="mb-2 flex items-center text-sm">
          <h3 class="font-semibold">YouTube Total Views</h3>
          <ExportMenu canvas={ytCanvas.current ?? undefined}
                       filenameBase="yt-views" />
        </div>
        <div class="h-60"><canvas ref={ytCanvas}></canvas></div>
      </section>

      {/* market insights */}
      {market.market_insights?.length > 0 && (
        <section class="rounded-lg border border-zinc-800 p-3">
          <h3 class="mb-2 text-sm font-semibold">Market Insights</h3>
          <ul class="space-y-2 text-sm">
            {market.market_insights.map((i: any) => (
              <li key={i.id} class="rounded border border-zinc-800/60 p-2">
                <div class="font-semibold">{i.title}</div>
                <div class="text-xs text-zinc-400">{i.body}</div>
                <SourceRef refs={i.source_refs ?? []} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
