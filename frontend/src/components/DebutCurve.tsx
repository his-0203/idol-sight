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
  points: Array<{ day_offset: number; value: number }>;
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
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<Chart | null>(null);

  useEffect(() => {
    setData(null);
    api.debutCurve(metric, from, to).then(setData).catch(() => setData({ series: [] }));
  }, [metric, from, to]);

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

    const datasets = visibleSeries.map((s) => {
      const map = new Map(s.points.map((p) => [p.day_offset, p.value]));
      const isMiiwan = s.group_key === "miiwan";
      return {
        label: s.name,
        data: xs.map((d) => ({ x: d, y: map.get(d) ?? null })),
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
      };
    });

    chart.current = new Chart(canvas.current, {
      type: "line",
      data: { datasets },
      options: {
        parsing: false as any,  // we feed {x, y} objects directly
        // The single biggest hover-readability win: 'index' mode means
        // hovering at any x reveals every visible group's value
        // simultaneously, ranked, so the operator doesn't have to aim
        // at a 1.5px line. intersect:false widens the hit zone to the
        // full plot area.
        interaction: {
          mode: "index",
          intersect: false,
          axis: "x",
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
            // Sort tooltip rows by value desc so the operator's eye
            // falls on the dominant group first regardless of
            // dataset order.
            itemSort: (a, b) =>
              ((b.parsed as any).y ?? 0) - ((a.parsed as any).y ?? 0),
            callbacks: {
              title: (items) => {
                const x = (items[0]?.parsed as any)?.x;
                if (typeof x !== "number") return "";
                return x === 0 ? "D-DAY" : x > 0 ? `D+${x}` : `D${x}`;
              },
              label: (ctx) => {
                const v = (ctx.parsed as any).y;
                if (v == null) return `${ctx.dataset.label}: —`;
                return `${ctx.dataset.label}: ${fmt(v)}`;
              },
            },
          },
        },
      },
    });
  }, [visibleSeries, metric]);

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
          </div>
        </div>
      )}
    </section>
  );
}
