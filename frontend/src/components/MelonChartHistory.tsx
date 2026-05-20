// MelonChartHistory — V2.27 per-song melon trajectory.
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
//
// V2.27: 18곡 PLAVE 같은 다곡 그룹 가독성 개선 —
//   - chart.js bottom legend 제거 (혼잡)
//   - 우측 패널: 검색창 + 스크롤 가능한 음원 리스트. 클릭=visibility 토글
//   - 음원명 hover 시 해당 라인 외 opacity 20%로 dim.
//   - 동일 hover 효과를 우측 패널과 하단 테이블 행 모두에 적용.
//   - hiddenIds 상태가 chart 재생성에서도 살아남도록 effect에서 reapply.
//
// V2.27.1 bugfix — 점(point/dot)이 hover dim에 반응 안 하던 문제.
//   Root cause: chart.js v4 LineController는 initialize() 단계에서
//   `enableOptionSharing = true`를 켠다. 그 결과 PointElement 옵션들은
//   첫 update에서 `controller._sharedOptions`에 lazily 캐시되어
//   chart destroy 전까지 invalidate 되지 않는다. `chart.update('none')`은
//   `_cachedDataOpts`만 비울 뿐 `_sharedOptions`는 손대지 않으므로,
//   dataset.pointBackgroundColor / pointRadius / pointBorderColor를
//   mutate해도 매 draw마다 동일한 캐시된 옵션 객체가 재사용되어 화면에
//   반영되지 않는다. LineElement(보더/배경)는 `enableOptionSharing`이
//   index=undefined 경로라서 sharedOptions를 안 타고 매번 새로 resolve
//   되기 때문에 dim이 잘 동작했고, 그래서 "선만 dim, 점은 안 dim"이
//   비대칭으로 나타났다.
//   Fix: point 관련 옵션들을 scriptable(함수)로 정의한다. chart.js
//   `resolveNamedOptions`는 옵션 중 하나라도 함수면 `$shared=false`로
//   판정 → sharedOptions/캐시 경로를 우회하고 매 데이터 인덱스마다
//   resolveDataElementOptions가 다시 호출되어 최신 함수 결과가 반영된다.
//   hover state는 useRef로 미러해 closure의 stale 캡쳐를 피한다.
//   borderColor/borderWidth도 동일 방식으로 통일해 향후 회귀 방지.

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

function hueOfSong(songId: string): number {
  let h = 0;
  for (let i = 0; i < songId.length; i++) h = (h * 31 + songId.charCodeAt(i)) | 0;
  return ((h % 360) + 360) % 360;
}
function colorOfSong(songId: string, alpha: number = 1): string {
  const hue = hueOfSong(songId);
  return alpha >= 1
    ? `hsl(${hue} 65% 60%)`
    : `hsl(${hue} 65% 60% / ${alpha})`;
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

// Live hover/visibility state read by the chart's scriptable options.
// Must be a ref (not React state) so the scriptable closures always see
// the latest values — chart.js evaluates them on every redraw and we
// cannot rebind them without destroying the chart.
interface HoverStateRef {
  hoveredId: string | null;
  hiddenIds: Set<string>;
}

function buildViewModel(
  data: MelonHistoryResp,
  windowSize: number,
  hoverStateRef: { current: HoverStateRef },
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
    // baseColor 형식 = `hsl(H 65% 60%)`. 끝의 `60%)`를 `60% / 0.18)`로
    // 치환해 alpha 채널만 추가한 dim 색.
    const dimColor = color.replace(/60%\)$/, "60% / 0.18)");
    const songId = s.song_id;
    // Helpers — read live hover state from the ref every time chart.js
    // evaluates the scriptable option. Must not capture React state
    // directly: chart.js calls these on every redraw and the chart is
    // only recreated on data change.
    const isHovered = () => hoverStateRef.current.hoveredId === songId;
    const isDimmed = () => {
      const h = hoverStateRef.current.hoveredId;
      return h != null && h !== songId;
    };
    return {
      label: s.song_title,
      data: valueAt(s),
      // Scriptable options bypass chart.js's enableOptionSharing cache
      // (resolveNamedOptions marks the result as $shared=false when any
      // option is a function) so every redraw re-evaluates these and
      // picks up the latest hover state — even under update('none').
      borderColor: () => (isDimmed() ? dimColor : color),
      backgroundColor: () => (isDimmed() ? dimColor : color),
      pointBackgroundColor: () => (isDimmed() ? dimColor : color),
      pointBorderColor: () => (isDimmed() ? dimColor : color),
      borderWidth: () => (isHovered() ? 2.8 : isDimmed() ? 1.0 : 1.8),
      // Dimmed datasets collapse their points to radius 0 — both
      // baseline and hover — so a stray cursor near a dimmed line can't
      // momentarily reveal a bright dot. Hovered series gets a slight
      // emphasis.
      pointRadius: () => (isDimmed() ? 0 : isHovered() ? 3.2 : 2.2),
      pointHoverRadius: () => (isDimmed() ? 0 : 5),
      order: () => (isHovered() ? -1 : 0),
      spanGaps: false,
      tension: 0.25,
      // Custom metadata — still used by the tooltip title callback to
      // map dataset → song_id for release-axis absolute-date lookup.
      meta_song_id: songId,
      meta_base_color: color,
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

// Sync dataset visibility from hiddenIds and trigger a redraw. The
// per-dataset hover dim is now expressed purely through scriptable
// options on each dataset (see buildViewModel) reading hoverStateRef,
// so updating that ref + calling chart.update('none') is enough to
// repaint with fresh hover state — no dataset mutation here.
function applyChartState(
  chart: Chart,
  hiddenIds: Set<string>,
): void {
  const datasets: any[] = chart.data.datasets as any[];
  datasets.forEach((ds, i) => {
    const songId: string = ds.meta_song_id;
    chart.setDatasetVisibility(i, !hiddenIds.has(songId));
  });
  chart.update("none");
}

export function MelonChartHistory({ groupKey }: { groupKey: string }) {
  const [type, setType]   = useState<ChartType>("daily");
  const [anchor, setAnchor] = useState<Anchor>("lookback");
  const [days, setDays]   = useState(30);
  const [windowSize, setWindow] = useState(90);
  const [data, setData] = useState<MelonHistoryResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart  = useRef<Chart | null>(null);
  // Live mirror of hover/visibility state for scriptable chart options
  // (see buildViewModel). React state is rebound on every render but
  // the scriptable closures are captured at chart-build time, so we
  // route the live values through this ref instead of through state.
  const hoverStateRef = useRef<HoverStateRef>({
    hoveredId: null,
    hiddenIds: new Set<string>(),
  });

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

  // Reset hover + hidden + search when the song set may change. (Hidden
  // state is keyed by song_id which is stable across daily/top100, but
  // the song list itself differs between groups/anchors so a wipe is
  // friendlier than carrying stale entries.)
  useEffect(() => {
    setHoveredId(null);
    setHiddenIds(new Set());
    setQuery("");
  }, [groupKey, type, anchor]);

  // Build VM and (re)create chart whenever data changes. The scriptable
  // options inside vm.datasets read from hoverStateRef on every redraw,
  // so passing the ref through keeps them in sync without rebuilding.
  const vm = data ? buildViewModel(data, windowSize, hoverStateRef) : null;

  useEffect(() => {
    if (chart.current) {
      chart.current.destroy();
      chart.current = null;
    }
    if (!canvas.current || !vm) return;

    // Sync ref before the first draw so scriptable options resolve
    // against the current hover/hidden state (e.g. if the user already
    // had something hovered/hidden when data finishes refetching).
    hoverStateRef.current = { hoveredId, hiddenIds };

    chart.current = new Chart(canvas.current, {
      type: "line",
      data: { labels: vm.labels, datasets: vm.datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          // V2.27: bottom legend 제거. 우측 패널이 그 역할을 대신함.
          legend: { display: false },
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
    // Reapply hidden state to the freshly created chart. (Hover dim is
    // expressed via scriptable options reading hoverStateRef, so it
    // doesn't need explicit reapplication after recreation.)
    applyChartState(chart.current, hiddenIds);
  }, [data]);

  // Push the latest hover/visibility state into the ref that scriptable
  // chart options read, then nudge chart.js to repaint. update('none')
  // skips animation; the scriptable closures pick up the new ref values
  // because $shared=false bypasses sharedOptions caching (chart.js v4).
  useEffect(() => {
    hoverStateRef.current = { hoveredId, hiddenIds };
    if (chart.current) applyChartState(chart.current, hiddenIds);
  }, [hoveredId, hiddenIds]);

  // Unmount-only cleanup. (Re-create handled above on every data swap.)
  useEffect(() => () => {
    if (chart.current) {
      chart.current.destroy();
      chart.current = null;
    }
  }, []);

  const tab = TYPE_TABS.find(t => t.v === type) ?? TYPE_TABS[0]!;
  const aTab = ANCHOR_TABS.find(t => t.v === anchor) ?? ANCHOR_TABS[0]!;

  const toggleHidden = (songId: string) => {
    setHiddenIds(prev => {
      const next = new Set(prev);
      if (next.has(songId)) next.delete(songId);
      else next.add(songId);
      return next;
    });
  };

  // 검색 필터 — 패널 노출에만 영향, chart는 그대로.
  const songsFiltered = (data?.songs ?? []).filter(s => {
    if (!query) return true;
    return s.song_title.toLowerCase().includes(query.toLowerCase());
  });

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
          chart가 안 그려지던 V2.24 issue 회피 (DebutCurve.tsx와 동일 패턴).

          V2.27: 차트 + 우측 음원 패널 grid. lg(≥1024px) 이상에서 사이드
          바, 모바일은 차트 아래로 wrap. 사이드 패널은 chart 영역과 동일
          높이로 잡아 잘림 없이 스크롤. */}
      <div
        class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_240px] gap-3"
        style={{ display: !loading && data && vm ? "grid" : "none" }}
      >
        <div class="h-64 md:h-80">
          <canvas ref={canvas}></canvas>
        </div>
        {data && (
          <div class="flex flex-col gap-2 h-64 md:h-80">
            <input
              type="text"
              placeholder="음원 검색…"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              class="w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:border-violet-500 focus:outline-none"
            />
            <div class="flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500">
              <span>음원 {songsFiltered.length}/{data.songs.length}</span>
              {hiddenIds.size > 0 && (
                <button
                  type="button"
                  onClick={() => setHiddenIds(new Set())}
                  class="text-violet-400 hover:text-violet-300"
                >전체 표시</button>
              )}
            </div>
            <div class="flex-1 overflow-y-auto pr-1 space-y-0.5">
              {songsFiltered.map(s => {
                const hidden = hiddenIds.has(s.song_id);
                const dim = hoveredId != null && hoveredId !== s.song_id;
                return (
                  <button
                    key={s.song_id}
                    type="button"
                    onMouseEnter={() => setHoveredId(s.song_id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => toggleHidden(s.song_id)}
                    class={"w-full flex items-center gap-2 rounded px-1.5 py-1 text-xs text-left transition-colors " +
                           (hidden
                             ? "text-zinc-600 hover:bg-zinc-800/60"
                             : dim
                               ? "text-zinc-500 hover:bg-zinc-800/60"
                               : "text-zinc-200 hover:bg-zinc-800/60")}
                    title={hidden ? "클릭해서 표시" : "클릭해서 숨김"}
                  >
                    <span
                      class="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
                      style={{
                        background: hidden ? "transparent" : colorOfSong(s.song_id),
                        border: hidden ? "1px solid " + colorOfSong(s.song_id, 0.5) : "none",
                        opacity: dim ? 0.4 : 1,
                      }}
                    />
                    <span class={"flex-1 truncate " + (hidden ? "line-through" : "")}>
                      {s.song_title}
                    </span>
                    <span class="tabular-nums text-[10px] text-zinc-500">
                      {s.peak != null ? `#${s.peak}` : "—"}
                    </span>
                  </button>
                );
              })}
              {songsFiltered.length === 0 && (
                <div class="text-zinc-500 text-xs py-2 px-1.5">검색 결과 없음</div>
              )}
            </div>
          </div>
        )}
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
                {data.songs.map(s => {
                  const dim = hoveredId != null && hoveredId !== s.song_id;
                  const hidden = hiddenIds.has(s.song_id);
                  return (
                  <tr
                    key={s.song_id}
                    onMouseEnter={() => setHoveredId(s.song_id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => toggleHidden(s.song_id)}
                    class={"border-b border-zinc-800/40 cursor-pointer transition-opacity " +
                           (hidden ? "opacity-40 " : "") +
                           (dim ? "opacity-50" : "")}
                  >
                    <td class="py-1.5 max-w-xs truncate">
                      <span
                        class="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle"
                        style={{ background: colorOfSong(s.song_id) }}
                      />
                      <span class={hidden ? "line-through" : ""}>{s.song_title}</span>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
