// MelonChartHistory — V2.23 per-song melon TOP 100 trajectory.
//
// Data source: /api/melon/:key (reads migration 0058 melon_chart_entries,
// populated daily by the melon-chart workflow at 06:00 KST). One line per
// distinct song, Y-axis is the melon rank with the scale REVERSED so
// rank 1 sits at the top of the canvas (matches reader intuition for
// "higher = better"). Chart-out days render as line breaks via
// spanGaps:false — the line ends where the song fell out of TOP 100.
//
// Empty-state policy: groups not yet on TOP 100 (most pre-debut groups,
// including MiiWAN as of writing) get an EmptyState card instead of an
// empty chart canvas. PLAVE is currently the only consistent group with
// data (see project_idol_sight memory).

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
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
  days: number;
  start: string | null;
  end: string | null;
  songs: SongSeries[];
  daily_summary: { date: string; peak: number; depth: number }[];
}

// Stable per-song color derived from song_id. We don't reuse the group
// palette because all songs belong to the same group and would collide.
// Hash → hue keeps colors deterministic across reloads.
function colorOfSong(songId: string): string {
  let h = 0;
  for (let i = 0; i < songId.length; i++) h = (h * 31 + songId.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue} 65% 60%)`;
}

const DAY_OPTIONS = [
  { v: 7,  label: "7d" },
  { v: 30, label: "30d" },
  { v: 90, label: "90d" },
];

export function MelonChartHistory({ groupKey }: { groupKey: string }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<MelonHistoryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart  = useRef<Chart | null>(null);

  useEffect(() => {
    setLoading(true);
    setData(null);
    api.melonHistory(groupKey, days)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [groupKey, days]);

  // Build the date axis as the UNION of every song's chart-in dates so
  // a song that dropped out mid-window leaves a real gap (null) at the
  // missing day rather than collapsing the x-axis around its sparse
  // points. Sorted ISO date strings.
  const { labels, datasets, kpis } = useMemo(() => {
    if (!data || !data.songs.length) {
      return { labels: [] as string[], datasets: [] as any[], kpis: null };
    }
    const allDates = new Set<string>();
    for (const s of data.songs) for (const p of s.series) allDates.add(p.date);
    const labels = [...allDates].sort();
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

    // KPIs derived from the API payload (avoids re-summing here).
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
    const chartedDays = data.daily_summary.length;
    return {
      labels, datasets,
      kpis: { bestPeak, bestPeakSong, avgPeak, maxDepth, chartedDays },
    };
  }, [data]);

  useEffect(() => {
    if (!canvas.current || !datasets.length) {
      chart.current?.destroy();
      chart.current = null;
      return;
    }
    chart.current?.destroy();
    chart.current = new Chart(canvas.current, {
      type: "line",
      data: { labels, datasets },
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
              // ctx.parsed.y is the rank; show as "#N" to match the axis.
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
    return () => { chart.current?.destroy(); chart.current = null; };
  }, [labels, datasets]);

  if (loading) {
    return <div class="text-zinc-500 text-sm py-4">Loading…</div>;
  }
  if (!data || data.songs.length === 0) {
    return (
      <EmptyState
        title="멜론 TOP 100 진입 이력 없음"
        hint={`최근 ${days}일 기준. 차트 진입 시 일 1회(06:00 KST) 자동 누적.`}
        icon="🎵"
      />
    );
  }

  return (
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2 text-xs">
        <div class="text-zinc-500">
          {data.start} → {data.end} · {kpis?.chartedDays}일 진입
        </div>
        <div class="flex gap-1">
          {DAY_OPTIONS.map(o => (
            <button
              key={o.v}
              type="button"
              onClick={() => setDays(o.v)}
              class={"rounded-md border px-2 py-0.5 transition-colors " +
                     (days === o.v
                       ? "border-violet-500 bg-violet-500/10 text-violet-300"
                       : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
            >{o.label}</button>
          ))}
        </div>
      </div>

      {kpis && (
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
            <div class="text-xs uppercase tracking-wider text-zinc-500">최고 순위</div>
            <div class="mt-0.5 text-xl font-bold tabular-nums">
              {kpis.bestPeak != null ? `#${kpis.bestPeak}` : "—"}
            </div>
            {kpis.bestPeakSong && (
              <div class="text-xs text-zinc-500 truncate">{kpis.bestPeakSong}</div>
            )}
          </div>
          <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
            <div class="text-xs uppercase tracking-wider text-zinc-500">평균 Best</div>
            <div class="mt-0.5 text-xl font-bold tabular-nums">
              {kpis.avgPeak ?? "—"}
            </div>
            <div class="text-xs text-zinc-500">daily peak 평균</div>
          </div>
          <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
            <div class="text-xs uppercase tracking-wider text-zinc-500">최대 진입곡</div>
            <div class="mt-0.5 text-xl font-bold tabular-nums">
              {kpis.maxDepth ?? "—"}
            </div>
            <div class="text-xs text-zinc-500">하루 최대 곡 수</div>
          </div>
          <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
            <div class="text-xs uppercase tracking-wider text-zinc-500">곡 수</div>
            <div class="mt-0.5 text-xl font-bold tabular-nums">{data.songs.length}</div>
            <div class="text-xs text-zinc-500">진입 곡 총수 ({days}d)</div>
          </div>
        </div>
      )}

      <div class="h-64 md:h-80"><canvas ref={canvas}></canvas></div>

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
    </div>
  );
}
