// MelonChartHistory — V2.25 per-song melon trajectory with 일간/TOP100 탭.
//
// Data source: /api/melon/:key?type=daily|top100
//   daily : 멜론 일간차트(06 KST cron, /chart/day). 어제 KST의 24h 풀집계.
//   top100: 멜론 TOP100 차트(22 KST cron, /chart). 저녁 화력 결산 시점.
//
// Y-axis는 melon rank로 reverse 되어 rank 1이 위(상위). 차트인 안 한 날은
// 라인이 끊기도록 spanGaps:false. labels는 곡 series의 chart_date union을
// 정렬한 것.
//
// V2.25 chart 렌더 로직 단순화: useMemo+다중 effect 의존성을 제거하고
// data state 하나만 보고 chart를 destroy/recreate. 별도 unmount cleanup
// effect로 페이지 이탈 시에만 dispose. Preact 환경에서 useMemo 결과 ref
// 변화에 의한 재실행 잡음을 줄여 V2.24에서 일부 환경에서 캔버스 빈
// 상태로 노출되던 issue 회피.

import { useEffect, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { EmptyState } from "./EmptyState";

interface SongSeries {
  song_id: string;
  song_title: string;
  peak: number | null;
  avg: number | null;
  days_charted: number;
  last_rank: number | null;
  sources: string[];
  series: { date: string; rank: number; source: string }[];
}

interface MelonHistoryResp {
  group_key: string;
  type: "daily" | "top100";
  days: number;
  start: string | null;
  end: string | null;
  songs: SongSeries[];
  daily_summary: { date: string; peak: number; depth: number }[];
}

type ChartType = "daily" | "top100";

const DAY_OPTIONS = [
  { v: 7,  label: "7d" },
  { v: 30, label: "30d" },
  { v: 90, label: "90d" },
];

const TYPE_TABS: { v: ChartType; label: string; hint: string }[] = [
  { v: "daily",  label: "일간차트",
    hint: "06:00 KST · 24h 풀집계 · 산업 표준 단위" },
  { v: "top100", label: "TOP100 차트",
    hint: "22:00 KST · 직전 1h + 24h 가중 · 저녁 화력 정점" },
];

function colorOfSong(songId: string): string {
  let h = 0;
  for (let i = 0; i < songId.length; i++) h = (h * 31 + songId.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue} 65% 60%)`;
}

interface ChartViewModel {
  labels: string[];
  datasets: any[];
  kpis: {
    bestPeak: number | null;
    bestPeakSong: string | null;
    avgPeak: number | null;
    maxDepth: number | null;
    chartedDays: number;
  };
}

function buildViewModel(data: MelonHistoryResp): ChartViewModel | null {
  if (!data.songs.length) return null;
  const allDates = new Set<string>();
  for (const s of data.songs) for (const p of s.series) allDates.add(p.date);
  const labels = [...allDates].sort();
  if (!labels.length) return null;
  const dateIdx = new Map(labels.map((d, i) => [d, i]));

  const datasets = data.songs.map(s => {
    const points: (number | null)[] = labels.map(() => null);
    for (const p of s.series) {
      const i = dateIdx.get(p.date);
      if (i != null) points[i] = p.rank;
    }
    const color = colorOfSong(s.song_id);
    return {
      label: s.song_title,
      data: points,
      borderColor: color,
      backgroundColor: color,
      borderWidth: 1.8,
      pointRadius: 2.2,
      pointHoverRadius: 5,
      spanGaps: false,
      tension: 0.25,
    };
  });

  const peaks = data.songs.map(s => s.peak).filter((r): r is number => r != null);
  const bestPeak = peaks.length ? Math.min(...peaks) : null;
  const bestPeakSong = bestPeak != null
    ? data.songs.find(s => s.peak === bestPeak)?.song_title ?? null
    : null;
  const dailyPeaks = data.daily_summary.map(d => d.peak);
  const avgPeak = dailyPeaks.length
    ? +(dailyPeaks.reduce((a, b) => a + b, 0) / dailyPeaks.length).toFixed(1)
    : null;
  const maxDepth = data.daily_summary.length
    ? Math.max(...data.daily_summary.map(d => d.depth))
    : null;
  return {
    labels, datasets,
    kpis: { bestPeak, bestPeakSong, avgPeak, maxDepth,
            chartedDays: data.daily_summary.length },
  };
}

export function MelonChartHistory({ groupKey }: { groupKey: string }) {
  const [type, setType] = useState<ChartType>("daily");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<MelonHistoryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart  = useRef<Chart | null>(null);

  // Fetch on (groupKey, days, type) change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    api.melonHistory(groupKey, days, type)
      .then((d: MelonHistoryResp) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [groupKey, days, type]);

  // Build VM and (re)create chart whenever data changes.
  const vm = data ? buildViewModel(data) : null;

  useEffect(() => {
    if (chart.current) {
      chart.current.destroy();
      chart.current = null;
    }
    if (!canvas.current || !vm) return;

    chart.current = new Chart(canvas.current, {
      type: "line",
      data: { labels: vm.labels, datasets: vm.datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              color: "#a1a1aa", font: { size: 11 },
              boxWidth: 12, boxHeight: 12, padding: 8,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.dataset.label} · #${ctx.parsed.y}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#71717a", font: { size: 11 }, maxRotation: 0 },
            grid:  { color: "rgba(39,39,42,0.4)" },
          },
          y: {
            reverse: true, min: 1, max: 100,
            ticks: {
              color: "#71717a", font: { size: 11 }, stepSize: 20,
              callback: (v) => v === 1 ? "#1" : v === 100 ? "#100" : `#${v}`,
            },
            grid: { color: "rgba(39,39,42,0.4)" },
            title: {
              display: true, text: "Melon Rank (역축)",
              color: "#a1a1aa", font: { size: 11 },
            },
          },
        },
      },
    });
  }, [data]);

  // Unmount-only cleanup. (Re-create handled above on every data swap.)
  useEffect(() => () => {
    if (chart.current) {
      chart.current.destroy();
      chart.current = null;
    }
  }, []);

  const tab = TYPE_TABS.find(t => t.v === type) ?? TYPE_TABS[0]!;

  return (
    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-0.5">
          {TYPE_TABS.map(t => (
            <button
              key={t.v}
              type="button"
              onClick={() => setType(t.v)}
              class={"rounded-md px-3 py-1 text-xs font-medium transition-colors " +
                     (type === t.v
                       ? "bg-violet-500/20 text-violet-200"
                       : "text-zinc-400 hover:text-zinc-200")}
            >{t.label}</button>
          ))}
        </div>
        <div class="flex gap-1">
          {DAY_OPTIONS.map(o => (
            <button
              key={o.v}
              type="button"
              onClick={() => setDays(o.v)}
              class={"rounded-md border px-2 py-0.5 text-xs transition-colors " +
                     (days === o.v
                       ? "border-violet-500 bg-violet-500/10 text-violet-300"
                       : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
            >{o.label}</button>
          ))}
        </div>
      </div>
      <div class="text-xs text-zinc-500">{tab.hint}</div>

      {loading && (
        <div class="text-zinc-500 text-sm py-4">Loading…</div>
      )}

      {!loading && (!data || data.songs.length === 0) && (
        <EmptyState
          title={type === "top100"
            ? "멜론 TOP100 진입 이력 없음"
            : "멜론 일간차트 진입 이력 없음"}
          hint={`최근 ${days}일 기준. ${tab.hint}.`}
          icon="🎵"
        />
      )}

      {/* Canvas는 항상 DOM에 존재 — 데이터 도착 시 effect가 chart 생성.
          조건부 마운트 시 ref attach와 useEffect[data] 실행 사이 race로
          chart가 안 그려지던 V2.24 issue 회피 (DebutCurve.tsx와 동일 패턴). */}
      <div
        class="h-64 md:h-80"
        style={{ display: !loading && data && vm ? "block" : "none" }}
      >
        <canvas ref={canvas}></canvas>
      </div>

      {!loading && data && vm && (
        <>
          <div class="text-xs text-zinc-500">
            {data.start} → {data.end} · {vm.kpis.chartedDays}일 진입
          </div>

          <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
              <div class="text-xs uppercase tracking-wider text-zinc-500">최고 순위</div>
              <div class="mt-0.5 text-xl font-bold tabular-nums">
                {vm.kpis.bestPeak != null ? `#${vm.kpis.bestPeak}` : "—"}
              </div>
              {vm.kpis.bestPeakSong && (
                <div class="text-xs text-zinc-500 truncate">{vm.kpis.bestPeakSong}</div>
              )}
            </div>
            <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
              <div class="text-xs uppercase tracking-wider text-zinc-500">평균 Best</div>
              <div class="mt-0.5 text-xl font-bold tabular-nums">
                {vm.kpis.avgPeak ?? "—"}
              </div>
              <div class="text-xs text-zinc-500">일별 peak 평균</div>
            </div>
            <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
              <div class="text-xs uppercase tracking-wider text-zinc-500">최대 진입곡</div>
              <div class="mt-0.5 text-xl font-bold tabular-nums">
                {vm.kpis.maxDepth ?? "—"}
              </div>
              <div class="text-xs text-zinc-500">하루 최대 곡 수</div>
            </div>
            <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
              <div class="text-xs uppercase tracking-wider text-zinc-500">곡 수</div>
              <div class="mt-0.5 text-xl font-bold tabular-nums">{data.songs.length}</div>
              <div class="text-xs text-zinc-500">진입 곡 총수 ({days}d)</div>
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead><tr class="text-left text-zinc-500 border-b border-zinc-800">
                <th class="py-1.5">곡</th>
                <th class="text-right">Peak</th>
                <th class="text-right">Avg</th>
                <th class="text-right">차트인</th>
                <th class="text-right">최근</th>
                <th>소스</th>
              </tr></thead>
              <tbody>
                {data.songs.map(s => (
                  <tr key={s.song_id} class="border-b border-zinc-800/40">
                    <td class="py-1.5 max-w-xs truncate">
                      <span
                        class="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle"
                        style={{ background: colorOfSong(s.song_id) }}
                      />
                      {s.song_title}
                    </td>
                    <td class="text-right tabular-nums">{s.peak != null ? `#${s.peak}` : "—"}</td>
                    <td class="text-right tabular-nums">{s.avg ?? "—"}</td>
                    <td class="text-right tabular-nums">{s.days_charted}d</td>
                    <td class="text-right tabular-nums">
                      {s.last_rank != null
                        ? `#${s.last_rank}`
                        : <span class="text-zinc-500">— out</span>}
                    </td>
                    <td>
                      <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
                        {s.sources.length > 1 ? "union" : s.sources[0] ?? "—"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
