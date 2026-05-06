// DebutCurve — debut-aligned cohort line chart with isolation panel.
//
// X-axis: days since (or before) each group's debut_date. Negative
// values are pre-debut (e.g. D-30 = 30 days before debut). Y-axis: a
// selected metric from agg_summary. Each group is a separate line so
// the operator can read "MiiWAN at D-30" against "SKINZ at D-30",
// "OWIS at D-30", etc. directly.
//
// UX notes:
//   - interaction.mode='index' + intersect=false makes the tooltip
//     show all groups' values at the hovered x, so the operator
//     never has to thread the cursor through a 1.5px line. The
//     previous default ('nearest' + intersect:true) required pixel-
//     perfect aim and made readout effectively impossible on a
//     dense chart.
//   - hoverBorderWidth + larger pointHoverRadius widen the visual
//     hit zone too, in case the operator does want to home in on
//     one line.
//   - A side panel of group toggles (default: all on; click to
//     isolate that group; toggle visibility) sits next to the chart.
//     It's the keyboard/touch fallback for users who can't hover and
//     it doubles as a static legend with deltas at D+N.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { colorOf, fillOf } from "../design/groups";
import { fmtScale } from "../design/chart-defaults";

type Series = {
  group_key: string;
  name: string;
  debut_date: string;
  group_model: string;
  points: Array<{
    day_offset: number;
    value: number;
    source: 'live' | 'backfill_exact' | 'backfill_estimate';
  }>;
};

type EventRow = {
  id: number;
  group_key: string;
  event_date: string;
  event_type: string;
  title: string;
  description: string | null;
  source_url: string | null;
  confidence: string;
};

// Only annotate events that materially shape the trajectory the
// operator is reading. Member reveals fire near-daily during the
// pre-debut campaign, which would clutter the chart; debut + first
// release + first show win + album drops are what bend the curve.
const ANNOTATABLE_EVENT_TYPES = new Set([
  "debut",
  "first_release",
  "first_show_win",
  "album_release",
  "first_concert",
  "tour_start",
  "single_release",
  "merger",
  "graduation",
  "song_release",
  "showcase",
  "company_launch",
  "1st_gen_debut",
  "2nd_gen_debut",
  "3rd_gen_debut",
]);

const EVENT_ICON: Record<string, string> = {
  debut:           "🎬",
  first_release:   "💿",
  first_show_win:  "🏆",
  album_release:   "💿",
  single_release:  "🎵",
  song_release:    "🎵",
  first_concert:   "🎤",
  tour_start:      "🎤",
  showcase:        "🎤",
  merger:          "🤝",
  graduation:      "🌅",
  company_launch:  "🏢",
  "1st_gen_debut": "🎬",
  "2nd_gen_debut": "🎬",
  "3rd_gen_debut": "🎬",
};

const METRIC_OPTIONS = [
  { key: "yt_subscribers",    label: "구독자" },
  { key: "yt_total_views",    label: "조회수 (누적)" },
  { key: "yt_total_videos",   label: "영상 수" },
  { key: "dc_total_posts",    label: "디시 게시글" },
  { key: "naver_total_news",  label: "네이버 뉴스" },
  { key: "twitter_posts",     label: "트위터 멘션" },
] as const;

type MetricKey = typeof METRIC_OPTIONS[number]["key"];

type CohortFilter = "all" | "kpop" | "subculture";

function cohortOf(groupModel: string | null | undefined): "kpop" | "subculture" {
  return (groupModel === "segmentary" || groupModel === "confederation")
    ? "subculture"
    : "kpop";
}

export function DebutCurve() {
  const [metric, setMetric] = useState<MetricKey>("yt_subscribers");
  const [cohort, setCohort] = useState<CohortFilter>("all");
  const [from, setFrom] = useState<number>(-60);
  const [to,   setTo]   = useState<number>(180);
  const [data, setData] = useState<{ series: Series[] } | null>(null);
  // hidden = explicitly toggled off. isolated = a group's panel item
  // was clicked; only that group remains visible. Both states reset
  // when the cohort filter changes (the filter would otherwise
  // produce empty isolation states like "isolate=plave + cohort=서브컬처").
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [isolated, setIsolated] = useState<string | null>(null);
  // Events for the isolated group only — overlaying every group's
  // events at once produced ~80 markers across 8 lines, which read
  // as visual noise. Single-group isolation is the natural moment
  // to surface the timeline annotation.
  const [events, setEvents] = useState<EventRow[]>([]);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<Chart | null>(null);

  useEffect(() => {
    setData(null);
    api.debutCurve(metric, from, to).then(setData).catch(() => setData({ series: [] }));
  }, [metric, from, to]);

  useEffect(() => {
    if (!isolated) { setEvents([]); return; }
    // Wide window so events for older groups (PLAVE 2023, ISEDOL
    // 2021) are reachable regardless of the chart's current D-N
    // range. The component filters to range-visible events at
    // dataset-build time.
    api.groupEvents(isolated, "2020-01-01", "2030-12-31")
      .then((d) => setEvents(d?.events ?? []))
      .catch(() => setEvents([]));
  }, [isolated]);

  // Reset visibility when cohort changes — otherwise an isolated
  // group from a previous filter can paradoxically vanish.
  useEffect(() => {
    setHidden(new Set());
    setIsolated(null);
  }, [cohort]);

  const filteredSeries = useMemo<Series[]>(() => {
    if (!data) return [];
    if (cohort === "all") return data.series;
    return data.series.filter((s) => cohortOf(s.group_model) === cohort);
  }, [data, cohort]);

  const visibleSeries = useMemo<Series[]>(() => {
    if (isolated) return filteredSeries.filter((s) => s.group_key === isolated);
    return filteredSeries.filter((s) => !hidden.has(s.group_key));
  }, [filteredSeries, hidden, isolated]);

  useEffect(() => {
    if (!canvas.current) return;
    chart.current?.destroy();
    if (visibleSeries.length === 0) return;

    // Build a sparse {day_offset: value} per group then materialize a
    // common x-axis from all observed offsets. This avoids forcing
    // every group onto a dense 0-padded axis (which would suggest
    // they had data we don't have).
    const allDays = new Set<number>();
    for (const s of visibleSeries) {
      for (const p of s.points) allDays.add(p.day_offset);
    }
    const xs = [...allDays].sort((a, b) => a - b);

    const datasets: any[] = visibleSeries.map((s) => {
      const map = new Map(s.points.map((p) => [p.day_offset, p]));
      const isMiiwan = s.group_key === "miiwan";
      return {
        label: s.name,
        data: xs.map((d) => {
          const p = map.get(d);
          return p
            ? { x: d, y: p.value, source: p.source }
            : { x: d, y: null, source: 'live' as const };
        }),
        borderColor: colorOf(s.group_key),
        backgroundColor: fillOf(s.group_key, 0.1),
        borderWidth: isMiiwan ? 3 : 2,
        // Hovering anywhere on the chart bumps every line's stroke
        // width — the active group's value reads from the tooltip
        // (interaction.mode='index') rather than from line thickness,
        // so a uniform hover bump keeps the chart legible.
        hoverBorderWidth: isMiiwan ? 4 : 3,
        borderDash: isMiiwan ? [] : (cohortOf(s.group_model) === "subculture" ? [4, 3] : []),
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHitRadius: 12,
        spanGaps: true,
        tension: 0.25,
        fill: false,
        // segment 콜백: 두 인접 포인트 사이의 라인 세그먼트의 source 기준 분기.
        // backfill_estimate가 한쪽이라도 있으면 굵은 점선, backfill_exact만이면
        // 가는 점선, 둘 다 live이면 실선(undefined로 기본 borderDash 사용).
        segment: {
          borderDash: (ctx: any) => {
            const a = ctx.p0?.raw?.source;
            const b = ctx.p1?.raw?.source;
            if (a === 'backfill_estimate' || b === 'backfill_estimate') return [6, 4];
            if (a === 'backfill_exact'    || b === 'backfill_exact')    return [2, 2];
            return undefined;
          },
          borderColor: (ctx: any) => {
            const b = ctx.p1?.raw?.source;
            return b && b !== 'live'
              ? fillOf(s.group_key, 0.55)
              : colorOf(s.group_key);
          },
        },
      };
    });

    // Event annotation layer — only when a single group is isolated.
    // We project each event's calendar date onto the debut-relative
    // x-axis (day_offset = (event_date − debut_date) days), look up
    // the line's y-value at that offset, and emit a triangle marker
    // anchored to the line itself. Markers carry their event metadata
    // so the tooltip callback can show "🏆 첫 음방 1위" instead of
    // a numeric label.
    if (isolated && events.length > 0 && visibleSeries.length === 1) {
      const series = visibleSeries[0]!;
      const debutMs = Date.parse(series.debut_date);
      if (Number.isFinite(debutMs)) {
        const lookup = new Map(series.points.map((p) => [p.day_offset, p.value]));
        const eventPoints = events
          .filter((e) => ANNOTATABLE_EVENT_TYPES.has(e.event_type))
          .map((e) => {
            const evMs = Date.parse(e.event_date);
            if (!Number.isFinite(evMs)) return null;
            const offset = Math.round((evMs - debutMs) / 86_400_000);
            if (offset < from || offset > to) return null;
            // Use the closest known data point for vertical anchoring.
            // Without this, an event on a day with no agg_summary row
            // would land at y=null and Chart.js would skip it.
            let y: number | null = lookup.get(offset) ?? null;
            if (y == null) {
              const sortedDays = [...lookup.keys()].sort((a, b) => Math.abs(a - offset) - Math.abs(b - offset));
              if (sortedDays.length > 0 && sortedDays[0] !== undefined) {
                y = lookup.get(sortedDays[0]) ?? null;
              }
            }
            if (y == null) return null;
            return { x: offset, y, _event: e };
          })
          .filter((p): p is { x: number; y: number; _event: EventRow } => p != null);

        if (eventPoints.length > 0) {
          datasets.push({
            label: "이벤트",
            type: "line",
            data: eventPoints,
            showLine: false,
            pointStyle: "triangle",
            pointRadius: 8,
            pointHoverRadius: 12,
            pointHitRadius: 16,
            backgroundColor: "#fbbf24",
            borderColor: "#78350f",
            borderWidth: 1.5,
            spanGaps: true,
            // Higher z-order so markers sit on top of the line.
            order: -1,
          });
        }
      }
    }

    chart.current = new Chart(canvas.current, {
      type: "line",
      data: { datasets },
      options: {
        parsing: false as any,  // we feed {x, y} objects directly
        // mode='nearest' + intersect:false + axis:'xy' picks the single
        // data point physically closest to the cursor (in both axes),
        // so hovering OVER a line shows only that line's value rather
        // than the all-groups-at-this-x stack 'index' mode used to
        // produce. intersect:false keeps the hit zone wide enough that
        // the operator doesn't have to aim pixel-perfect at the line.
        // pointHitRadius below also ensures a generous catch radius.
        interaction: {
          mode: "nearest",
          intersect: false,
          axis: "xy",
        },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "데뷔 기준 일수 (D-N / D+N)" },
            ticks: {
              callback: (v) => {
                const n = Number(v);
                return n === 0 ? "D-DAY" : n > 0 ? `D+${n}` : `D${n}`;
              },
            },
            grid: { color: (ctx: any) => ctx.tick.value === 0 ? "rgba(245,158,11,0.4)" : undefined },
          },
          y: {
            title: { display: true, text: METRIC_OPTIONS.find((m) => m.key === metric)?.label ?? metric },
            ticks: { callback: (v) => fmtScale(v as number) },
          },
        },
        plugins: {
          // The side panel below is the static legend; suppressing
          // Chart.js's built-in legend stops the duplicated UI and
          // gives the chart 40px of vertical breathing room.
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                const x = (items[0]?.parsed as any)?.x;
                if (typeof x !== "number") return "";
                return x === 0 ? "D-DAY" : x > 0 ? `D+${x}` : `D${x}`;
              },
              label: (ctx) => {
                const raw = ctx.raw as any;
                // Event marker — surface the event metadata instead
                // of "이벤트: 1234" which would be meaningless.
                if (raw && raw._event) {
                  const e = raw._event as EventRow;
                  const icon = EVENT_ICON[e.event_type] ?? "•";
                  return `${icon} ${e.event_date} · ${e.title}`;
                }
                const v = raw?.y;
                if (v == null) return `${ctx.dataset.label}: —`;
                return `${ctx.dataset.label}: ${fmt(v)}`;
              },
            },
          },
        },
      },
    });
  }, [visibleSeries, metric, events, isolated, from, to]);

  // Latest observed value per series — shown in the side panel so the
  // panel doubles as a "snapshot at end of range" reference.
  const latestValues = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const s of filteredSeries) {
      const last = s.points.length ? s.points[s.points.length - 1] : null;
      out[s.group_key] = last?.value ?? null;
    }
    return out;
  }, [filteredSeries]);

  return (
    <section class="card">
      <div class="mb-3 flex flex-wrap items-center gap-2 text-data">
        <h3 class="section-title">데뷔 정렬 곡선</h3>
        <span class="text-hint text-zinc-500">
          각 그룹의 debut_date 기준 D-N / D+N 으로 정렬한 코호트 비교. MiiWAN은 굵게 강조.
        </span>
        <span class="ml-auto text-[11px] text-zinc-500">
          <span class="mr-2"><span class="inline-block w-4 border-t-2 border-zinc-400 align-middle"></span> 실측</span>
          <span class="mr-2"><span class="inline-block w-4 border-t-2 border-dashed border-zinc-400 align-middle"></span> 백필 추정</span>
          <span><span class="inline-block w-4 border-t border-dotted border-zinc-400 align-middle"></span> 백필 검증</span>
        </span>
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span class="text-zinc-500">지표</span>
        {METRIC_OPTIONS.map((m) => (
          <button
            key={m.key}
            type="button"
            class={"rounded-md border px-2 py-1 transition-colors " +
              (metric === m.key
                ? "border-violet-500 bg-violet-500/10 text-violet-300"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
            onClick={() => setMetric(m.key)}
          >{m.label}</button>
        ))}
        <span class="ml-2 text-zinc-500">코호트</span>
        {([
          { key: "all" as const,        label: "전체" },
          { key: "kpop" as const,       label: "K-POP" },
          { key: "subculture" as const, label: "서브컬처" },
        ]).map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setCohort(c.key)}
            class={"rounded-md border px-2 py-1 transition-colors " +
              (cohort === c.key
                ? "border-violet-500 bg-violet-500/10 text-violet-300"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
          >{c.label}</button>
        ))}
        <span class="ml-2 text-zinc-500">범위</span>
        {([
          [-30, 30],  [-60, 90],  [-60, 180],  [-60, 365],
        ] as const).map(([f, t]) => (
          <button
            key={`${f}_${t}`}
            type="button"
            onClick={() => { setFrom(f); setTo(t); }}
            class={"rounded-md border px-2 py-1 transition-colors " +
              (from === f && to === t
                ? "border-violet-500 bg-violet-500/10 text-violet-300"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
          >{`D${f} ~ D+${t}`}</button>
        ))}
      </div>

      {!data ? (
        <div class="text-hint text-zinc-500">Loading…</div>
      ) : filteredSeries.length === 0 ? (
        <div class="text-hint text-zinc-500">
          선택한 코호트/범위에 해당하는 데이터가 아직 없습니다.
          (PLAVE/ISEDOL/STELLIVE는 데뷔 후 오랜 기간이 지나 D-30 / D+30 데이터가 없을 수 있음)
        </div>
      ) : (
        <div class="grid gap-3 md:grid-cols-[1fr_220px]">
          <div class="h-80 md:h-[28rem]"><canvas ref={canvas}></canvas></div>
          <div>
            <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
              <span>그룹 ({filteredSeries.length})</span>
              {(isolated || hidden.size > 0) && (
                <button
                  type="button"
                  class="ml-auto rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] hover:bg-zinc-800"
                  onClick={() => { setIsolated(null); setHidden(new Set()); }}
                >초기화</button>
              )}
            </div>
            <ul class="space-y-1">
              {filteredSeries.map((s) => {
                const isHidden = hidden.has(s.group_key);
                const isIso = isolated === s.group_key;
                const dimmed = isolated && !isIso;
                return (
                  <li key={s.group_key}>
                    <div class="flex items-center gap-1.5 text-xs">
                      <button
                        type="button"
                        title={isHidden ? "보이기" : "숨기기"}
                        class={"shrink-0 rounded border px-1.5 py-0.5 text-[11px] transition-colors " +
                          (isHidden
                            ? "border-zinc-800 text-zinc-600"
                            : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
                        onClick={() => {
                          setHidden((h) => {
                            const next = new Set(h);
                            if (next.has(s.group_key)) next.delete(s.group_key);
                            else next.add(s.group_key);
                            return next;
                          });
                          if (isolated === s.group_key) setIsolated(null);
                        }}
                      >{isHidden ? "○" : "●"}</button>
                      <button
                        type="button"
                        title={isIso ? "전체 보기" : "이 그룹만 보기"}
                        onClick={() => setIsolated(isIso ? null : s.group_key)}
                        class={"flex flex-1 items-center justify-between gap-2 rounded px-2 py-0.5 text-left transition-colors " +
                          (isIso
                            ? "bg-violet-500/10 ring-1 ring-violet-500/40"
                            : dimmed
                            ? "opacity-40 hover:opacity-100 hover:bg-zinc-800/60"
                            : "hover:bg-zinc-800/60") +
                          (isHidden ? " line-through opacity-50" : "")}
                      >
                        <span class="flex items-center gap-1.5 truncate">
                          <span
                            class="inline-block h-2 w-3 shrink-0 rounded"
                            style={{ backgroundColor: colorOf(s.group_key) }}
                          />
                          <span class="truncate">{s.name}</span>
                        </span>
                        <span class="shrink-0 tabular-nums text-zinc-500">
                          {latestValues[s.group_key] != null
                            ? fmt(latestValues[s.group_key]!)
                            : "—"}
                        </span>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div class="mt-2 text-[11px] text-zinc-600">
              ● 표시/숨기기 · 그룹명 클릭 시 단독 표시
            </div>
            {isolated && events.length > 0 && (
              <div class="mt-3 border-t border-zinc-800 pt-3">
                <div class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-400">
                  주요 이벤트 (▲ 차트 마커)
                </div>
                <ul class="space-y-1 text-[11px]">
                  {events
                    .filter((e) => ANNOTATABLE_EVENT_TYPES.has(e.event_type))
                    .slice(0, 8)
                    .map((e) => (
                      <li key={e.id} class="text-zinc-400">
                        <span class="mr-1">{EVENT_ICON[e.event_type] ?? "•"}</span>
                        <span class="tabular-nums text-zinc-500">{e.event_date}</span>
                        <span class="ml-1 text-zinc-300">{e.title}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
