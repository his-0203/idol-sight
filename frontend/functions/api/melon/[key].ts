import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

// GET /api/melon/:key?days=30&type=daily
//   Returns per-song melon trajectories for the requested group over the
//   last `days` (default 30, clamped 7..120). One point per chart_date.
//
// V2.25: type query 추가. 'daily'(기본) = 일간차트(06 KST), 'top100' =
// 22 KST TOP100 차트. melon_chart_entries.chart_type 컬럼(migration 0060)
// 으로 필터. 두 데이터를 같은 응답 shape으로 제공해 프런트엔드 탭이 type
// 만 바꾸면 됨.
//
// V2.24 호환: chart_type=NULL인 row(0060 백필 전 데이터; 실제론 모두
// 'daily' backfill됐지만 안전망)는 'daily' 탭에서만 보이도록 COALESCE.
//
// Response shape (consumed by MelonChartHistory.tsx):
// {
//   group_key, days, type,
//   start, end,
//   songs: [{ song_id, song_title, peak, avg, days_charted, last_rank,
//             sources, series: [{ date, rank, source }, ...] }],
//   daily_summary: [{ date, peak, depth }, ...]
// }

type ChartType = "daily" | "top100";

type EntryRow = {
  chart_date: string | null;
  snapshot_at: string;
  song_id: string;
  song_title: string;
  rank: number;
  source: "realtime" | "daily" | "both";
};

const dayOf = (r: EntryRow): string =>
  r.chart_date ?? r.snapshot_at.slice(0, 10);

const parseType = (raw: string | null): ChartType =>
  raw === "top100" ? "top100" : "daily";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({
  env, params, request,
}) => {
  const key = String(params.key);
  const url = new URL(request.url);
  const daysParam = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysParam)
    ? Math.min(120, Math.max(7, Math.trunc(daysParam)))
    : 30;
  const type = parseType(url.searchParams.get("type"));

  // Cutoff date — days ago in UTC date form (YYYY-MM-DD).
  const cutoffMs = Date.now() - days * 86400_000;
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10);

  // chart_type 필터: 'daily' 탭은 NULL chart_type도 포함 (legacy 호환).
  // 'top100' 탭은 명시적으로 chart_type='top100' 만.
  const typeClause = type === "top100"
    ? "chart_type = 'top100'"
    : "(chart_type IS NULL OR chart_type = 'daily')";

  const rows = await d1Query<EntryRow>(env.DB,
    `SELECT chart_date, snapshot_at, song_id, song_title, rank, source
       FROM melon_chart_entries
      WHERE group_key = ?
        AND ${typeClause}
        AND COALESCE(chart_date, substr(snapshot_at, 1, 10)) >= ?
      ORDER BY COALESCE(chart_date, substr(snapshot_at, 1, 10)) ASC,
               rank ASC`,
    [key, cutoffDate]);

  // Group by song_id → trajectory. Same (song_id, chart_date) may appear
  // multiple times if V2.23 적재 시 같은 날 두 번 cron 돈 흔적이 있는데
  // (5/18 케이스), dayDedup으로 한 점만 유지하고 더 좋은 rank를 선택.
  const bySong = new Map<string, {
    song_id: string;
    song_title: string;
    perDay: Map<string, { rank: number; source: string }>;
    sources: Set<string>;
  }>();
  for (const r of rows) {
    let s = bySong.get(r.song_id);
    if (!s) {
      s = { song_id: r.song_id, song_title: r.song_title,
            perDay: new Map(), sources: new Set() };
      bySong.set(r.song_id, s);
    }
    s.song_title = r.song_title;
    const d = dayOf(r);
    const cur = s.perDay.get(d);
    if (!cur || r.rank < cur.rank) {
      s.perDay.set(d, { rank: r.rank, source: r.source });
    }
    s.sources.add(r.source);
  }

  // Per-song summary stats. Sort songs by peak ascending (best first),
  // tie-break by days_charted descending.
  const songs = [...bySong.values()].map(s => {
    const series = [...s.perDay.entries()]
      .map(([date, v]) => ({ date, rank: v.rank, source: v.source }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const ranks = series.map(p => p.rank);
    const peak = ranks.length ? Math.min(...ranks) : null;
    const avg  = ranks.length
      ? +(ranks.reduce((a,b) => a+b, 0) / ranks.length).toFixed(1)
      : null;
    const last = series[series.length - 1] ?? null;
    return {
      song_id: s.song_id,
      song_title: s.song_title,
      peak,
      avg,
      days_charted: series.length,
      last_rank: last?.rank ?? null,
      sources: [...s.sources],
      series,
    };
  }).sort((a, b) => {
    if (a.peak === null) return 1;
    if (b.peak === null) return -1;
    if (a.peak !== b.peak) return a.peak - b.peak;
    return b.days_charted - a.days_charted;
  });

  // Daily roll-up — peak per chart_date, depth = distinct songs that day.
  const byDay = new Map<string, {
    date: string; peak: number; songs: Set<string>;
  }>();
  for (const s of songs) {
    for (const p of s.series) {
      let agg = byDay.get(p.date);
      if (!agg) {
        agg = { date: p.date, peak: p.rank, songs: new Set() };
        byDay.set(p.date, agg);
      }
      if (p.rank < agg.peak) agg.peak = p.rank;
      agg.songs.add(s.song_id);
    }
  }
  const daily_summary = [...byDay.values()]
    .map(d => ({ date: d.date, peak: d.peak, depth: d.songs.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const start = daily_summary[0]?.date ?? null;
  const end = daily_summary[daily_summary.length - 1]?.date ?? null;

  return jsonResponse({
    group_key: key,
    type,
    days,
    start, end,
    songs,
    daily_summary,
  });
};
