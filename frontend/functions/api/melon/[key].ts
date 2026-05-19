import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

// GET /api/melon/:key?days=30
//   Returns per-song melon 일간차트 trajectories for the requested group
//   over the last `days` (default 30, clamped 7..120). The series carry
//   one point per chart_date the song was charting; gaps = chart-out days
//   (the frontend renders these as line breaks).
//
// V2.24: date axis uses chart_date (migration 0059) — 일간차트 본래
// 날짜(KST). 이전엔 snapshot_at.slice(0,10)(UTC fetch date) 사용했는데
// fetch 시각과 차트 본 날짜가 1일 어긋날 수 있어 trajectory가 미세하게
// 비뚤어졌다. chart_date 우선, NULL fallback으로 snapshot_at 사용
// (V2.23 이전 rows 대비, migration 0059이 백필했지만 안전망).
//
// Response shape (consumed by MelonChartHistory.tsx):
// {
//   group_key: "plave",
//   days: 30,
//   start: "2026-04-18", end: "2026-05-17",
//   songs: [{
//     song_id, song_title, peak, avg, days_charted, last_rank, sources,
//     series: [{ date: "YYYY-MM-DD", rank: N, source: "realtime|daily|both" }, ...]
//   }],
//   daily_summary: [{ date, peak, depth }, ...]
// }

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

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({
  env, params, request,
}) => {
  const key = String(params.key);
  const url = new URL(request.url);
  const daysParam = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysParam)
    ? Math.min(120, Math.max(7, Math.trunc(daysParam)))
    : 30;

  // Cutoff date — days ago in UTC date form (YYYY-MM-DD). chart_date
  // is YYYY-MM-DD, snapshot_at is full ISO. We compare against the
  // larger column (snapshot_at) with the cutoff ISO timestamp; the
  // ORDER BY uses COALESCE for stable chronological sort.
  const cutoffMs = Date.now() - days * 86400_000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 13) + ":00:00Z";
  const cutoffDate = cutoff.slice(0, 10);

  const rows = await d1Query<EntryRow>(env.DB,
    `SELECT chart_date, snapshot_at, song_id, song_title, rank, source
       FROM melon_chart_entries
      WHERE group_key = ?
        AND COALESCE(chart_date, substr(snapshot_at, 1, 10)) >= ?
      ORDER BY COALESCE(chart_date, substr(snapshot_at, 1, 10)) ASC,
               rank ASC`,
    [key, cutoffDate]);

  // Group by song_id → trajectory. song_title can drift across days
  // (rare retitle) — keep the latest title seen.
  const bySong = new Map<string, {
    song_id: string;
    song_title: string;
    series: { date: string; rank: number; source: string }[];
    sources: Set<string>;
  }>();
  for (const r of rows) {
    let s = bySong.get(r.song_id);
    if (!s) {
      s = { song_id: r.song_id, song_title: r.song_title,
            series: [], sources: new Set() };
      bySong.set(r.song_id, s);
    }
    s.song_title = r.song_title;
    s.series.push({ date: dayOf(r), rank: r.rank, source: r.source });
    s.sources.add(r.source);
  }

  // Per-song summary stats. Sort songs by peak ascending (best first),
  // tie-break by days_charted descending.
  const songs = [...bySong.values()].map(s => {
    const ranks = s.series.map(p => p.rank);
    const peak = ranks.length ? Math.min(...ranks) : null;
    const avg  = ranks.length ? +(ranks.reduce((a,b)=>a+b,0) / ranks.length).toFixed(1) : null;
    const last = s.series[s.series.length - 1] ?? null;
    return {
      song_id: s.song_id,
      song_title: s.song_title,
      peak,
      avg,
      days_charted: s.series.length,
      last_rank: last?.rank ?? null,
      sources: [...s.sources],
      series: s.series,
    };
  }).sort((a, b) => {
    if (a.peak === null) return 1;
    if (b.peak === null) return -1;
    if (a.peak !== b.peak) return a.peak - b.peak;
    return b.days_charted - a.days_charted;
  });

  // Daily roll-up — useful for the KPI card (max depth, avg peak).
  // depth uses distinct song_id per chart_date — same song appearing
  // twice on the same day (impossible w/ daily-only, but defensive)
  // shouldn't inflate depth.
  const byDay = new Map<string, {
    date: string; peak: number; songs: Set<string>;
  }>();
  for (const r of rows) {
    const d = dayOf(r);
    let agg = byDay.get(d);
    if (!agg) {
      agg = { date: d, peak: r.rank, songs: new Set() };
      byDay.set(d, agg);
    }
    if (r.rank < agg.peak) agg.peak = r.rank;
    agg.songs.add(r.song_id);
  }
  const daily_summary = [...byDay.values()]
    .map(d => ({ date: d.date, peak: d.peak, depth: d.songs.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const start = daily_summary[0]?.date ?? null;
  const end = daily_summary[daily_summary.length - 1]?.date ?? null;

  return jsonResponse({
    group_key: key,
    days,
    start, end,
    songs,
    daily_summary,
  });
};
