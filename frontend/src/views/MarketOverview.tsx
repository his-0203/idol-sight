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
import { colorOf, fillOf } from "../design/groups";
import { gradeClasses } from "../design/grades";
import { fmtScale, fmtTooltipCallback } from "../design/chart-defaults";

const INSIGHTS_PREVIEW_LIMIT = 2;

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

export function MarketOverview() {
  const [market, setMarket] = useState<any>(null);
  const [share, setShare] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [excludePlave, setExcludePlave] = useState(false);
  const shareCanvas = useRef<HTMLCanvasElement | null>(null);
  const shareChart = useRef<Chart | null>(null);
  const ytCanvas = useRef<HTMLCanvasElement | null>(null);
  const ytChart = useRef<Chart | null>(null);

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

  // YT views bar — colored per group (same hue as the cards).
  useEffect(() => {
    if (!market || !ytCanvas.current) return;
    const ctx = ytCanvas.current;
    const entries = sortByShare(Object.entries(market.groups), share?.rows);
    ytChart.current?.destroy();
    ytChart.current = new Chart(ctx, {
      type: "bar",
      data: {
        labels: entries.map(([_, g]) => g.name),
        datasets: [{
          label: "YT 총 조회수",
          data: entries.map(([_, g]) => g.summary?.yt_total_views ?? 0),
          backgroundColor: entries.map(([k]) => fillOf(k, 0.85)),
          borderColor: entries.map(([k]) => colorOf(k)),
          borderWidth: 1,
        }],
      },
      options: {
        scales: { y: { ticks: { callback: (v) => fmtScale(v as number) } } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: fmtTooltipCallback() } },
        },
      },
    });
  }, [market, share]);

  if (!market) return <div class="p-4 text-zinc-500">Loading…</div>;

  const sortedEntries = sortByShare(Object.entries(market.groups), share?.rows);
  const insights = market.market_insights ?? [];
  const insightsPreview = insights.slice(0, INSIGHTS_PREVIEW_LIMIT);

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

      {/* group cards — sorted by share desc, leader spans 2 cols on md+ */}
      <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
        {sortedEntries.map(([key, g]: any, i: number) => {
          const hs = g.health_score;
          const hasGrade = hs?.grade != null;
          const total = hs?.total;
          // Raw KPI fallback for groups without a health score (PRE-debut etc.)
          const fallback = g.summary?.yt_subscribers ?? g.summary?.yt_total_views ?? null;
          return (
            <button
              key={key}
              onClick={() => writeState({ tab: "content", group: key })}
              class={
                "card border-l-4 p-3 text-left transition-colors hover:border-brand " +
                (i === 0 ? "md:col-span-2" : "")
              }
              style={{ borderLeftColor: colorOf(key) }}
              aria-label={`${g.name} 상세 보기`}
            >
              <div class="flex items-baseline justify-between gap-2">
                <div class="font-semibold">{g.name}</div>
                {hasGrade ? (
                  <span class={`rounded-chip border px-1.5 text-hint ${gradeClasses(hs.grade)}`}>
                    {hs.grade}
                  </span>
                ) : (
                  <span class="text-hint text-zinc-500">집계 대기</span>
                )}
              </div>
              <div class="text-hint text-zinc-500">{g.name_kr}</div>
              <div class="mt-2 text-3xl font-bold tabular-nums">
                {total != null ? total : (fallback != null ? fmt(fallback) : "—")}
              </div>
              {total == null && fallback != null && (
                <div class="text-hint text-zinc-500">구독자 (점수 미산출)</div>
              )}
            </button>
          );
        })}
      </div>

      {/* market share chart */}
      <section class="card">
        <div class="mb-2 flex flex-wrap items-center gap-2 text-data">
          <h3 class="section-title">Market Share Trend (13주)</h3>
          <HealthSpec />
          <label class="ml-auto flex items-center gap-1 text-hint text-zinc-400">
            <input type="checkbox" checked={excludePlave}
                   onChange={(e: any) => setExcludePlave(e.currentTarget.checked)} />
            PLAVE 제외
          </label>
          <ExportMenu canvas={shareCanvas.current ?? undefined}
                       rows={share?.rows ?? []}
                       filenameBase="market-share" />
        </div>
        <div class="h-48 md:h-72"><canvas ref={shareCanvas}></canvas></div>
      </section>

      {/* YT views bar */}
      <section class="card">
        <div class="mb-2 flex items-center text-data">
          <h3 class="section-title">YouTube 총 조회수</h3>
          <ExportMenu canvas={ytCanvas.current ?? undefined}
                       filenameBase="yt-views" />
        </div>
        <div class="h-48 md:h-60"><canvas ref={ytCanvas}></canvas></div>
      </section>

      {/* market insights — capped to 2; "more" jumps to /insights */}
      {insightsPreview.length > 0 && (
        <section class="card">
          <div class="mb-2 flex items-center justify-between gap-2">
            <h3 class="section-title">시장 인사이트</h3>
            {insights.length > INSIGHTS_PREVIEW_LIMIT && (
              <button
                class="text-hint text-zinc-400 hover:text-zinc-200 hover:underline"
                onClick={() => writeState({ tab: "insights" })}
              >더 보기 →</button>
            )}
          </div>
          <ul class="space-y-2 text-data">
            {insightsPreview.map((i: any) => (
              <li key={i.id} class="rounded-card border border-zinc-800/60 p-2">
                <div class="font-semibold">{i.title}</div>
                <div class="text-hint text-zinc-400">{i.body}</div>
                <SourceRef refs={i.source_refs ?? []} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
