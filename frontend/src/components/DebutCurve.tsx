// DebutCurve — debut-aligned cohort line chart.
//
// X-axis: days since (or before) each group's debut_date. Negative
// values are pre-debut (e.g. D-30 = 30 days before debut). Y-axis: a
// selected metric from agg_summary. Each group is a separate line so
// the operator can read "MiiWAN at D-30" against "SKINZ at D-30",
// "OWIS at D-30", etc. directly.
//
// Why this isn't just MarketOverview's SOV chart shifted: that chart
// uses calendar weeks, which is the right axis for "what's happening
// this week", but the wrong axis for "is our pre-debut campaign on
// track vs comparable launches". Switching to a debut-relative axis
// is the single change that turns this dashboard from
// "current state" into "trajectory vs cohort".

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
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
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<Chart | null>(null);

  useEffect(() => {
    setData(null);
    api.debutCurve(metric, from, to).then(setData).catch(() => setData({ series: [] }));
  }, [metric, from, to]);

  const filteredSeries = useMemo<Series[]>(() => {
    if (!data) return [];
    if (cohort === "all") return data.series;
    return data.series.filter((s) => cohortOf(s.group_model) === cohort);
  }, [data, cohort]);

  useEffect(() => {
    if (!canvas.current) return;
    chart.current?.destroy();
    if (filteredSeries.length === 0) return;

    // Build a sparse {day_offset: value} per group then materialize a
    // common x-axis from all observed offsets. This avoids forcing
    // every group onto a dense 0-padded axis (which would suggest
    // they had data we don't have).
    const allDays = new Set<number>();
    for (const s of filteredSeries) {
      for (const p of s.points) allDays.add(p.day_offset);
    }
    const xs = [...allDays].sort((a, b) => a - b);

    const datasets = filteredSeries.map((s) => {
      const map = new Map(s.points.map((p) => [p.day_offset, p.value]));
      const isMiiwan = s.group_key === "miiwan";
      return {
        label: s.name,
        data: xs.map((d) => ({ x: d, y: map.get(d) ?? null })),
        borderColor: colorOf(s.group_key),
        backgroundColor: fillOf(s.group_key, 0.1),
        borderWidth: isMiiwan ? 3 : 1.5,
        borderDash: isMiiwan ? [] : (cohortOf(s.group_model) === "subculture" ? [4, 3] : []),
        pointRadius: 0,
        pointHoverRadius: 3,
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
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              title: (items) => {
                const x = (items[0]?.parsed as any)?.x;
                if (typeof x !== "number") return "";
                return x === 0 ? "D-DAY" : x > 0 ? `D+${x}` : `D${x}`;
              },
            },
          },
        },
      },
    });
  }, [filteredSeries, metric]);

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
        <div class="h-72 md:h-96"><canvas ref={canvas}></canvas></div>
      )}
    </section>
  );
}
