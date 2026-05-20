// MelonChartHistory — V2.26 per-song melon trajectory.
// 탭: 일간/TOP100 (chart_type) × Lookback/Release-anchored (anchor).
//
// Data source: /api/melon/:key?type=daily|top100&anchor=lookback|release
//   daily : 멜론 일간차트(06 KST cron, /chart/day). 어제 KST의 24h 풀집계.
//   top100: 멜론 TOP100 차트(22 KST cron, /chart). 저녁 화력 결산 시점.
//   lookback: 최근 N일 (오늘 기준 backward window).
//   release : 곡별 첫 차트인 날(release_date) + N일 — 발매 후 trajectory
//             가 90일 lookback에 잘리지 않도록.
//
// Y-axis는 melon rank로 reverse 되어 rank 1이 위(상위). 차트인 안 한 날은
// 라인이 끊기도록 spanGaps:false. labels:
//   lookback : 곡 series의 chart_date union (정렬)
//   release  : "D+0".."D+window-1" (모든 곡 공통 발매 후 일수 축)
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
  release_date: string | null;
  sources: string[];
  series: { date: string; day_offset: number;
            rank: number; source: string }[];
}

interface MelonHistoryResp {
  group_key: string;
  type: "daily" | "top100";
  anchor: "lookback" | "release";
  days: number | null;
  window: number | null;
  start: string | null;
  end: string | null;
  songs: SongSeries[];
  daily_summary: { date: string; peak: number; depth: number }[];
}

type ChartType = "daily" | "top100";
type Anchor = "lookback" | "release";

const DAY_OPTIONS = [
  { v: 7,  label: "7d" },
  { v: 30, label: "30d" },
  { v: 90, label: "90d" },
];

const WINDOW_OPTIONS = [
  { v: 30,  label: "30d" },
  { v: 60,  label: "60d" },
  { v: 90,  label: "90d" },
  { v: 180, label: "180d" },
];

const TYPE_TABS: { v: ChartType; label: string; hint: string }[] = [
  { v: "daily",  label: "일간차트",
    hint: "06:00 KST · 24h 풀집계 · 산업 표준 단위" },
  { v: "top100", label: "TOP100 차트",
    hint: "22:00 KST · 직전 1h + 24h 가중 · 저녁 화력 정점" },
];

const ANCHOR_TABS: { v: Anchor; label: string; hint: string }[] = [
  { v: "lookback", label: "최근",
    hint: "오늘 기준 backward window. 신곡 발매 직후 trajectory에 적합." },
  { v: "release",  label: "발매 후",
    hint: "곡별 첫 차트인 날부터 N일. 발매 시점이 오래된 곡도 초반 trajectory를 동일 축에서 비교." },
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
  isReleaseAxis: boolean;
  kpis: {
    bestPeak: number | null;
    bestPeakSong: string | null;
    avgPeak: number | null;
    maxDepth: number | null;
    chartedDays: number;
  };
}

function buildViewModel(
  data: MelonHistoryResp,
  windowSize: number,
): ChartViewModel | null {
  if (!data.songs.length) return null;
  const isReleaseAxis = data.anchor === "release";

  let labels: string[];
  let valueAt: (s: SongSeries) => (number | null)[];
  // For release axis we also track date-per-(song, offset) so tooltip can
  // show the absolute date alongside D+N.
  let absDateAt: Map<string, Map<number, string>> | null = null;

  if (isReleaseAxis) {
    const max = Math.min(
      windowSize - 1,
      data.songs.reduce(
        (m, s) => Math.max(m, ...s.series.map(p => p.day_offset)),
        0,
      ),
    );
    labels = Array.from({ length: max + 1 }, (_, i) => `D+${i}`);
    absDateAt = new Map();
    valueAt = (s) => {
      const points: (number | null)[] = labels.map(() => null);
      const dateMap = new Map<number, string>();
      for (const p of s.series) {
        if (p.day_offset >= 0 && p.day_offset <= max) {
          const cur = points[p.day_offset];
          if (cur == null || p.rank < cur) {
            points[p.day_offset] = p.rank;
            dateMap.set(p.day_offset, p.date);
          }
        }
      }
      absDateAt!.set(s.song_id, dateMap);
      return points;
    };
  } else {
    const allDates = new Set<string>();
    for (const s of data.songs) for (const p of s.series) allDates.add(p.date);
    labels = [...allDates].sort();
    if (!labels.length) return null;
    const dateIdx = new Map(labels.map((d, i) => [d, i]));
    valueAt = (s) => {
      const points: (number | null)[] = labels.map(() => null);
      for (const p of s.series) {
        const i = dateIdx.get(p.date);
        if (i != null) points[i] = p.rank;
      }
      return points;
    };
  }

  const datasets = data.songs.map(s => {
    const color = colorOfSong(s.song_id);
    return {
      label: s.song_title,
      data: valueAt(s),
      borderColor: color,
      backgroundColor: color,
      borderWidth: 1.8,
      pointRadius: 2.2,
      pointHoverRadius: 5,
      spanGaps: false,
      tension: 0.25,
      meta_song_id: s.song_id,
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
    labels, datasets, isReleaseAxis,
    kpis: { bestPeak, bestPeakSong, avgPeak, maxDepth,
            chartedDays: data.daily_summary.length },
  };
}

export function MelonChartHistory({ groupKey }: { groupKey: string }) {
  const [type, setType]   = useState<ChartType>("daily");
  const [anchor, setAnchor] = useState<Anchor>("lookback");
  const [days, setDays]   = useState(30);
  const [windowSize, setWindow] = useState(90);
  const [data, setData] = useState<MelonHistoryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart  = useRef<Chart | null>(null);

  // Fetch on (groupKey, days, type, anchor, windowSize) change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    api.melonHistory(groupKey, { days, type, anchor, window: windowSize })
      .then((d: MelonHistoryResp) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [groupKey, days, type, anchor, windowSize]);

  // Build VM and (re)create chart whenever data changes.
  const vm = data ? buildViewModel(data, windowSize) : null;

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
              title: (items) => {
                if (!items.length) return "";
                const it = items[0]!;
                if (vm.isReleaseAxis) {
                  // Pull absolute date from dataset.meta hooks via parsed point.
                  const songId = (it.dataset as any).meta_song_id;
                  const song = data?.songs.find(s => s.song_id === songId);
                  const offset = it.dataIndex;
                  const abs = song?.series.find(p => p.day_offset === offset)?.date;
                  return abs ? `D+${offset} · ${abs}` : `D+${offset}`;
                }
                return String(it.label ?? "");
              },
              label: (ctx) => `${ctx.dataset.label} · #${ctx.parsed.y}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: "#71717a", font: { size: 11 }, maxRotation: 0 },
            grid:  { color: "rgba(39,39,42,0.4)" },
            title: vm.isReleaseAxis ? {
              display: true, text: "발매 후 일수 (Days since chart entry)",
              color: "#a1a1aa", font: { size: 11 },
            } : { display: false, text: "" },
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
  const aTab = ANCHOR_TABS.find(t => t.v === anchor) ?? ANCHOR_TABS[0]!;

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
        <div class="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-0.5">
          {ANCHOR_TABS.map(t => (
            <button
              key={t.v}
              type="button"
              onClick={() => setAnchor(t.v)}
              class={"rounded-md px-3 py-1 text-xs font-medium transition-colors " +
                     (anchor === t.v
                       ? "bg-sky-500/20 text-sky-200"
                       : "text-zinc-400 hover:text-zinc-200")}
            >{t.label}</button>
          ))}
        </div>
        <div class="flex gap-1">
          {(anchor === "release" ? WINDOW_OPTIONS : DAY_OPTIONS).map(o => (
            <button
              key={o.v}
              type="button"
              onClick={() => anchor === "release" ? setWindow(o.v) : setDays(o.v)}
              class={"rounded-md border px-2 py-0.5 text-xs transition-colors " +
                     ((anchor === "release" ? windowSize === o.v : days === o.v)
                       ? "border-violet-500 bg-violet-500/10 text-violet-300"
                       : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
            >{o.label}</button>
          ))}
        </div>
      </div>
      <div class="text-xs text-zinc-500">
        {tab.hint} · <span class="text-zinc-400">{aTab.hint}</span>
      </div>

      {loading && (
        <div class="text-zinc-500 text-sm py-4">Loading…</div>
      )}

      {!loading && (!data || data.songs.length === 0) && (
        <EmptyState
          title={type === "top100"
            ? "멜론 TOP100 진입 이력 없음"
            : "멜론 일간차트 진입 이력 없음"}
          hint={anchor === "release"
            ? `발매 후 ${windowSize}일 기준. ${tab.hint}.`
            : `최근 ${days}일 기준. ${tab.hint}.`}
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
            {anchor === "release"
              ? `곡별 발매 후 0~${windowSize}일 · ${data.songs.length}곡`
              : `${data.start} → ${data.end} · ${vm.kpis.chartedDays}일 진입`}
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
              <div class="text-xs text-zinc-500">
                {anchor === "release" ? `진입 곡 총수` : `진입 곡 총수 (${days}d)`}
              </div>
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead><tr class="text-left text-zinc-500 border-b border-zinc-800">
                <th class="py-1.5">곡</th>
                <th class="text-right">Peak</th>
                <th class="text-right">Avg</th>
                <th class="text-right">차트인</th>
                <th class="text-right">{anchor === "release" ? "발매일" : "최근"}</th>
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
                      {anchor === "release"
                        ? (s.release_date ?? "—")
                        : (s.last_rank != null
                            ? `#${s.last_rank}`
                            : <span class="text-zinc-500">— out</span>)}
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
