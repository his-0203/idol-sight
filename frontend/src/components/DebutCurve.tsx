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
  { key: "naver_total_news",  label: "뉴스" },
  // dc_total_posts removed 2026-05: collectors 부재로 데이터 거의 0.
  // twitter_posts removed 2026-06 (P4): 수집 중단, 컬럼 DROP 예정.
] as const;
// `naver_total_news` 컬럼은 V2.11에서 BIGKinds 통합값 (Naver Open API
// + BIGKinds 한국언론진흥재단 archive 합산) 으로 확장됨. 표시 라벨은
// "뉴스" 로 일반화 — naver 단독 카운트 의미가 더 이상 아님.

type MetricKey = typeof METRIC_OPTIONS[number]["key"];

// 누적(cumulative) 시계열 메트릭. 시간이 지날수록 단조증가해야 하며
// 백필 estimate 와 live 데이터가 섞일 때 음의 차분이 발생할 수 있어
// 시각화 단계에서 cummax 보정을 적용 (PLAVE D-180~D-1500 구간에서
// 채널별 백필 추정치 < 일부 live snapshot 으로 라인이 V자 모양으로
// 흔들리는 문제 수정).
const CUMULATIVE_METRICS = new Set<MetricKey>([
  "yt_subscribers",
  "yt_total_views",
  "yt_total_videos",
]);

// '뉴스' 메트릭의 단위 라벨. agg_summary.naver_total_news 의 backfill
// 행 (BIGKinds 0030 / Naver API 0025) 은 *그 주(또는 일)에 발생한 기사
// 수* 를 그대로 저장 — 누적이 아님. live 행도 raw_naver_articles 의
// retention window 내 row count 라 일별 작은 값 (한자릿수~10대) 로 들어옴.
// 따라서 차트 표현은 두 가지 view 를 지원:
//   1) 'cumulative-line' (기본): 주간 합을 누적합 → 라인 차트 (다른
//      메트릭과 일관). 그룹 간 우월/열위 비교 직관적.
//   2) 'weekly-bar' (legacy): 주간 합 막대. spike pattern 가시화.
// (이전 PR 의 누적값 차분 방식은 데이터 의미를 잘못 가정한 결과 — 차분
// 적용 시 음수 발생으로 0 clamp 되어 실제 데이터 대비 막대가 누락됐음.)
const NEWS_WEEKLY_UNIT = "주간 기사 수 (BIGKinds + Naver Open API 합산)";
const NEWS_CUMULATIVE_UNIT = "누적 기사 수 (BIGKinds + Naver Open API 합산)";

type NewsView = 'cumulative-line' | 'weekly-bar';

// DebutCurve 한정으로 시리즈/범례에서 숨길 그룹. STELLIVE 는 6인
// confederation (각 멤버 솔로 채널 합산) 모델이라 D-N 데뷔 정렬 축에서
// 다른 그룹과 같은 평면에서 비교하면 왜곡이 큼 (예: 단일 채널 1개의
// D-30 vs 6개 채널 합산의 D-30). UR:L (uryael) 도 같은 이유 — segmentary
// 모델 (그룹 채널 + 4 멤버 솔로 채널) 의 subculture cohort 라 K-pop 그룹
// 들과 같은 D-N 평면 비교 부적합. is_active=0 으로 백엔드에서는 그대로
// 유지하되 *이 차트에서만* 가린다. 다른 화면 (MarketOverview, GroupContent,
// Insights 등) 에서는 정상 노출.
const HIDDEN_GROUPS = new Set<string>(["stellive", "uryael"]);

function cohortOf(groupModel: string | null | undefined): "kpop" | "subculture" {
  return (groupModel === "segmentary" || groupModel === "confederation")
    ? "subculture"
    : "kpop";
}

export function DebutCurve() {
  const [metric, setMetric] = useState<MetricKey>("yt_subscribers");
  const [from, setFrom] = useState<number>(-90);
  const [to,   setTo]   = useState<number>(180);
  // 뉴스 탭 한정 시각화 모드 토글. cumulative-line 기본 — 다른 메트릭과
  // 일관된 라인 형식이고 9그룹 비교 시 stacked bar 보다 가독성이 높음.
  const [newsView, setNewsView] = useState<NewsView>('cumulative-line');
  const [data, setData] = useState<{ series: Series[] } | null>(null);
  // hidden = explicitly toggled off. isolated = a group's panel item
  // was clicked; only that group remains visible.
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

  const filteredSeries = useMemo<Series[]>(() => {
    if (!data) return [];
    // HIDDEN_GROUPS 적용 지점. 차트 데이터/범례/latestValues 모두 이
    // 시리즈 리스트에서 파생되므로 여기서 한 번 거르면 단독 panel
    // 토글 UI 와 차트 빌드 양쪽에서 동시에 사라진다.
    return data.series.filter((s) => !HIDDEN_GROUPS.has(s.group_key));
  }, [data]);

  const visibleSeries = useMemo<Series[]>(() => {
    if (isolated) return filteredSeries.filter((s) => s.group_key === isolated);
    return filteredSeries.filter((s) => !hidden.has(s.group_key));
  }, [filteredSeries, hidden, isolated]);

  useEffect(() => {
    if (!canvas.current) return;
    chart.current?.destroy();
    if (visibleSeries.length === 0) return;

    // 뉴스 (naver_total_news) 표시 모드. 'cumulative-line' 기본 — 다른
    // 메트릭과 동일한 라인 차트 표현. 'weekly-bar' 토글 시 주간 집계 막대.
    // 다른 메트릭(구독자/조회수/영상수)은 항상 daily line 유지.
    const isNewsMetric = metric === "naver_total_news";
    const isBarMetric = isNewsMetric && newsView === 'weekly-bar';
    const isNewsLineMetric = isNewsMetric && newsView === 'cumulative-line';
    const isCumulative = CUMULATIVE_METRICS.has(metric);

    // 누적 보정: agg_summary 의 cumulative metric (구독자/조회수/영상수)
    // 은 단조증가가 정상이지만 백필 estimate (Social Blade 채널 합계) 와
    // live collector (영상 단위 합산) 가 섞여 일부 구간에서 음의 차분이
    // 발생. PLAVE D-180~D-1500 의 V자 흔들림 + MiiWAN '영상 수' 탭의
    // 0 으로 떨어지는 dip 이 모두 같은 원인. 표시 단계에서 cummax 적용.
    const cumMaxAdjusted = isCumulative
      ? visibleSeries.map((s) => {
          const sorted = [...s.points].sort((a, b) => a.day_offset - b.day_offset);
          let running = -Infinity;
          const fixed = sorted.map((p) => {
            const v = Number(p.value);
            if (!Number.isFinite(v) || v <= 0) {
              // null/0 처리: 누적 메트릭에서 0 은 거의 항상 결손. 직전
              // 누적값(running) 으로 carry-forward 하여 라인이 0 으로
              // 떨어지는 가짜 dip 제거. running 이 아직 없으면 skip.
              return running > -Infinity
                ? { ...p, value: running, source: p.source }
                : null;
            }
            if (v < running) {
              // 단조증가 위반 → 직전 누적값 유지. 색/소스는 estimate
              // 으로 강등하여 점선으로 표시.
              return { ...p, value: running, source: 'backfill_estimate' as const };
            }
            running = v;
            return { ...p, value: v };
          }).filter((p): p is NonNullable<typeof p> => p != null);
          return { ...s, points: fixed };
        })
      : visibleSeries;

    // Weekly bucket aggregation for the news chart.
    //
    // 핵심 의미: agg_summary.naver_total_news 의 각 행은 *누적값이 아니라
    // 그 시점(주차) 카운트* 다. BIGKinds backfill (0030) / Naver API
    // backfill (0025) 모두 weekly bucketed pubDate count 로 INSERT, live
    // collector 도 raw_naver_articles 의 (retention 적용된) row count
    // 라서 일별 작은 값. 따라서 bucket 합산 시 *값을 그대로 SUM* 해야
    // 주간 총합이 됨. (이전 코드는 누적이라 가정하고 차분을 계산 → 음수
    // 0 clamp 으로 실제 데이터 대비 막대가 누락되는 버그 발생.)
    //
    // 같은 day_offset 안에 여러 row 가 있을 때 (live + backfill 혼재),
    // API 가 이미 (group, day) 당 max 1개로 dedupe 하므로 단순 sum 가능.
    // backfill_estimate 기반 zero-fill 행 (0027/0029 잔재) 은 0 이라
    // sum 에 영향 없음.
    //
    // newsView='weekly-bar' → 주간 합. 'cumulative-line' → 주간 합의
    // 누적합 (cumsum) 으로 다른 메트릭과 동일한 단조증가 라인.
    const seriesForRender = isNewsMetric
      ? visibleSeries.map((s) => {
          // 1) 같은 (group, week-bucket) 안의 raw point 들의 값을 SUM.
          //    같은 day_offset 에 들어온 multi-snapshot 은 API 단에서
          //    max 1개로 dedupe 되었으므로 추가 정규화 불필요.
          const sorted = [...s.points].sort((a, b) => a.day_offset - b.day_offset);
          // weekly bucket 키: 데뷔일(D=0) 기준 7일 윈도. floor 사용으로
          // D-1 ~ D-7 = bucket -7, D0 ~ D+6 = bucket 0 (데뷔주).
          const bucketSum = new Map<number, { sum: number; src: string; hasExact: boolean; hasLive: boolean }>();
          for (const p of sorted) {
            const v = Number(p.value);
            if (!Number.isFinite(v) || v <= 0) continue;
            const k = Math.floor(p.day_offset / 7) * 7;
            const cur = bucketSum.get(k);
            const isExact = p.source === 'backfill_exact';
            const isLive = p.source === 'live';
            if (!cur) {
              bucketSum.set(k, { sum: v, src: p.source, hasExact: isExact, hasLive: isLive });
            } else {
              cur.sum += v;
              cur.hasExact = cur.hasExact || isExact;
              cur.hasLive = cur.hasLive || isLive;
              // src priority: live > backfill_exact > backfill_estimate.
              if (isLive) cur.src = 'live';
              else if (isExact && cur.src === 'backfill_estimate') cur.src = 'backfill_exact';
            }
          }
          const ordered = [...bucketSum.entries()].sort((a, b) => a[0] - b[0]);
          if (newsView === 'cumulative-line') {
            // 2a) 누적합 변환. 라인 차트가 단조증가하도록.
            let running = 0;
            const out: Array<{ day_offset: number; value: number; source: any }> = [];
            for (const [d, v] of ordered) {
              running += v.sum;
              out.push({ day_offset: d, value: running, source: v.src as any });
            }
            return { ...s, points: out };
          }
          // 2b) 주간 합 그대로 (막대 분기).
          const out: Array<{ day_offset: number; value: number; source: any }> = ordered.map(
            ([d, v]) => ({ day_offset: d, value: v.sum, source: v.src as any })
          );
          return { ...s, points: out };
        })
      : cumMaxAdjusted;

    // Build a sparse {day_offset: value} per group then materialize a
    // common x-axis from all observed offsets. This avoids forcing
    // every group onto a dense 0-padded axis (which would suggest
    // they had data we don't have).
    const allDays = new Set<number>();
    for (const s of seriesForRender) {
      for (const p of s.points) allDays.add(p.day_offset);
    }
    const xs = [...allDays].sort((a, b) => a - b);

    const datasets: any[] = seriesForRender.map((s) => {
      const map = new Map(s.points.map((p) => [p.day_offset, p]));
      const isMiiwan = s.group_key === "miiwan";
      // Bar branch needs a plain numeric array aligned to `labels`
      // (Chart.js category x-axis). Line branch keeps {x,y,source}
      // objects to drive parsing:false + segment-source borderDash.
      const base = isBarMetric
        ? {
            label: s.name,
            data: xs.map((d) => map.get(d)?.value ?? null),
            borderColor: colorOf(s.group_key),
          } as any
        : {
            label: s.name,
            data: xs.map((d) => {
              const p = map.get(d);
              return p
                ? { x: d, y: p.value, source: p.source }
                : { x: d, y: null, source: 'live' as const };
            }),
            borderColor: colorOf(s.group_key),
          } as any;
      if (isBarMetric) {
        return {
          ...base,
          // Bar 차트: 막대 fill 자체에 그룹 색을 60% opacity 로 입혀
          // 여러 그룹이 같은 x에서 겹쳐도 색 구분 가능. MiiWAN 만
          // 더 진하게. categoryPercentage / barPercentage 1.0 로 두면
          // 막대 폭이 weekly 윈도(7일) 가까이 채워져서 sparse 데이터
          // 에서도 시각적으로 보임.
          backgroundColor: fillOf(s.group_key, isMiiwan ? 0.85 : 0.55),
          borderColor: colorOf(s.group_key),
          borderWidth: isMiiwan ? 1.5 : 0.5,
          borderRadius: 2,
          barPercentage: 1.0,
          categoryPercentage: 1.0,
        };
      }
      return {
        ...base,
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
      type: isBarMetric ? "bar" : "line",
      // Bar branch uses a category x-scale → labels=xs aligns plain
      // numeric data arrays to ticks. Line branch keeps {x,y} objects
      // on a linear x-scale (parsing:false). Mixing the two branches
      // was the root cause of the empty news chart — Chart.js stacked
      // bar on a linear axis collapsed bars to sub-pixel widths.
      data: isBarMetric ? { labels: xs, datasets } : { datasets },
      options: {
        // parsing:false only valid on the linear-scale line path. On
        // category-scale bar we want default parsing so Chart.js maps
        // the numeric data array to label indexes.
        parsing: isBarMetric ? undefined : (false as any),
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
          x: isBarMetric
            ? {
                // Category axis for stacked bars — labels=xs (week-start
                // day offsets, multiples of 7). Each bar represents a
                // 7-day window starting at that offset.
                type: "category",
                title: {
                  display: true,
                  text: "데뷔 기준 주차 (W-N / W+N) · 1막대 = 7일",
                },
                ticks: {
                  callback: (_v, i) => {
                    const n = xs[i] ?? 0;
                    // Display week index instead of raw day to match
                    // the bar binning (n is always a multiple of 7).
                    const w = Math.round(n / 7);
                    return w === 0 ? "W0 (데뷔주)" : w > 0 ? `W+${w}` : `W${w}`;
                  },
                  // 180+ weekly buckets → cap label density to keep
                  // the axis readable.
                  maxTicksLimit: 16,
                  autoSkip: true,
                },
                // dodge(grouped) 막대 — 사용자 피드백 "막대 보기 불편"에 대한
                // 응답. weekly-bar는 cumulative-line의 fallback(spike 비교용)이라
                // 그룹 간 변별력이 본질. stacked는 한 주의 총합만 보여 변별력 약함.
                stacked: false,
              }
            : {
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
            title: {
              display: true,
              text: isBarMetric
                ? NEWS_WEEKLY_UNIT
                : isNewsLineMetric
                ? NEWS_CUMULATIVE_UNIT
                : (METRIC_OPTIONS.find((m) => m.key === metric)?.label ?? metric),
            },
            ticks: { callback: (v) => fmtScale(v as number) },
            stacked: false,
            beginAtZero: isBarMetric || isNewsLineMetric,
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
                if (isBarMetric) {
                  // Bar 차트의 parsed.x 는 category index → labels(xs)
                  // 에서 실제 day offset 을 lookup. 막대 1개 = 7일 윈도.
                  const idx = items[0]?.dataIndex ?? 0;
                  const dStart = xs[idx] ?? 0;
                  const dEnd = dStart + 6;
                  const fmtD = (n: number) =>
                    n === 0 ? "D-DAY" : n > 0 ? `D+${n}` : `D${n}`;
                  return `${fmtD(dStart)} ~ ${fmtD(dEnd)} (7일 · 주간)`;
                }
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
                if (isBarMetric) {
                  // Bar 분기의 데이터는 plain number array.
                  const v = typeof ctx.parsed === "number"
                    ? ctx.parsed
                    : (ctx.parsed as any)?.y;
                  if (v == null) return `${ctx.dataset.label}: —`;
                  return `${ctx.dataset.label}: ${fmt(v)} 건/주`;
                }
                const v = raw?.y;
                if (v == null) return `${ctx.dataset.label}: —`;
                if (isNewsLineMetric) {
                  return `${ctx.dataset.label}: ${fmt(v)} 건 (누적)`;
                }
                return `${ctx.dataset.label}: ${fmt(v)}`;
              },
            },
          },
        },
      },
    });
  }, [visibleSeries, metric, events, isolated, from, to, newsView]);

  // Latest observed value per series — shown in the side panel so the
  // panel doubles as a "snapshot at end of range" reference.
  //
  // 뉴스 메트릭은 그래프(seriesForRender)에서 7일 bucket SUM 후
  // cumulative-line 일 때 cumsum 으로 단조증가 누적 라인을 그린다.
  // 같은 변환을 panel 숫자에도 적용해야 그래프 끝점과 일치한다.
  // 일치 안 시키면 OWIS 처럼 그래프는 ~108 까지 가는데 panel 은 0
  // 으로 표시되는 부조화가 발생.
  const latestValues = useMemo(() => {
    const out: Record<string, number | null> = {};
    const isNewsMetric = metric === "naver_total_news";
    const isNewsCumulative = isNewsMetric && newsView === 'cumulative-line';
    for (const s of filteredSeries) {
      if (isNewsMetric) {
        const bucketSum = new Map<number, number>();
        for (const p of s.points) {
          const v = Number(p.value);
          if (!Number.isFinite(v) || v <= 0) continue;
          const k = Math.floor(p.day_offset / 7) * 7;
          bucketSum.set(k, (bucketSum.get(k) ?? 0) + v);
        }
        if (bucketSum.size === 0) {
          out[s.group_key] = null;
          continue;
        }
        if (isNewsCumulative) {
          // cumulative-line 마지막 점 = 모든 주간 bucket 합
          let total = 0;
          for (const v of bucketSum.values()) total += v;
          out[s.group_key] = total;
        } else {
          // weekly-bar 마지막 막대 = 가장 큰 day_offset bucket
          const ordered = [...bucketSum.entries()].sort((a, b) => a[0] - b[0]);
          out[s.group_key] = ordered[ordered.length - 1]![1];
        }
      } else {
        const last = s.points.length ? s.points[s.points.length - 1] : null;
        out[s.group_key] = last?.value ?? null;
      }
    }
    return out;
  }, [filteredSeries, metric, newsView]);

  return (
    <section class="card">
      <div class="mb-3 flex flex-wrap items-center gap-2 text-data">
        <h3 class="section-title">데뷔 정렬 곡선</h3>
        <span class="text-hint text-zinc-500">
          각 그룹의 debut_date 기준 D-N / D+N 으로 정렬한 코호트 비교. MiiWAN은 굵게 강조.
        </span>
        {metric === "naver_total_news" && (
          <span class="ml-2 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
            단위: {newsView === 'cumulative-line' ? NEWS_CUMULATIVE_UNIT : NEWS_WEEKLY_UNIT}
          </span>
        )}
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
        {metric === "naver_total_news" && (
          <>
            <span class="ml-2 text-zinc-500">표시</span>
            {([
              ['cumulative-line', '누적 라인'],
              ['weekly-bar',      '주간 막대'],
            ] as const).map(([v, lbl]) => (
              <button
                key={v}
                type="button"
                class={"rounded-md border px-2 py-1 transition-colors " +
                  (newsView === v
                    ? "border-amber-500 bg-amber-500/10 text-amber-300"
                    : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
                onClick={() => setNewsView(v)}
              >{lbl}</button>
            ))}
          </>
        )}
        <span class="ml-2 text-zinc-500">범위</span>
        {([
          [-30, 30],  [-60, 90],  [-90, 180],  [-60, 365],
          [-180, 1095],
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
          선택한 범위에 해당하는 데이터가 아직 없습니다.
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
            <div class="mt-2 text-[11px] text-zinc-500">
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
