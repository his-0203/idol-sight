import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

// GET /api/melon/:key?anchor=...&type=daily|top100[&days=N|&window=N]
//
// Two anchor modes:
//   anchor=lookback (default) — last `days` (7..120, default 30) ending today.
//     Backward-compatible with V2.25 — `?days=` keeps working.
//   anchor=release            — per-song window of `window` days (30..180,
//     default 90) starting from each song's first chart_date. Lets us see
//     "발매 후 90일 trajectory" even when the song first charted years ago,
//     which the lookback mode cuts off.
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
//   group_key, anchor, days|window, type,
//   start, end,
//   songs: [{ song_id, song_title, peak, avg, days_charted, last_rank,
//             release_date, sources,
//             series: [{ date, day_offset, rank, source }, ...] }],
//   daily_summary: [{ date, peak, depth }, ...]   // lookback only
// }
//
// `release_date` = MIN(chart_date) for that song under the current type
// filter. `day_offset` = days since release_date (always present, 0 for
// release day). For anchor=lookback `day_offset` is still computed so the
// frontend can switch view without re-fetching if needed.

type ChartType = "daily" | "top100";
type Anchor = "lookback" | "release";

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

const parseAnchor = (raw: string | null): Anchor =>
  raw === "release" ? "release" : "lookback";

// UTC date diff in whole days. Both inputs YYYY-MM-DD.
function daysBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86400_000);
}

// Add `days` days to a YYYY-MM-DD date (UTC).
function addDays(date: string, days: number): string {
  const t = Date.parse(date + "T00:00:00Z") + days * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({
  env, params, request,
}) => {
  const key = String(params.key);
  const url = new URL(request.url);
  const type = parseType(url.searchParams.get("type"));
  const anchor = parseAnchor(url.searchParams.get("anchor"));

  const daysParam = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysParam)
    ? Math.min(120, Math.max(7, Math.trunc(daysParam)))
    : 30;
  const windowParam = Number(url.searchParams.get("window") ?? "90");
  const window = Number.isFinite(windowParam)
    ? Math.min(180, Math.max(30, Math.trunc(windowParam)))
    : 90;

  // chart_type 필터: 'daily' 탭은 NULL chart_type도 포함 (legacy 호환).
  // 'top100' 탭은 명시적으로 chart_type='top100' 만.
  const typeClause = type === "top100"
    ? "chart_type = 'top100'"
    : "(chart_type IS NULL OR chart_type = 'daily')";

  let rows: EntryRow[];
  if (anchor === "lookback") {
    const cutoffDate = new Date(Date.now() - days * 86400_000)
      .toISOString().slice(0, 10);
    rows = await d1Query<EntryRow>(env.DB,
      `SELECT chart_date, snapshot_at, song_id, song_title, rank, source
         FROM melon_chart_entries
        WHERE group_key = ?
          AND ${typeClause}
          AND COALESCE(chart_date, substr(snapshot_at, 1, 10)) >= ?
        ORDER BY COALESCE(chart_date, substr(snapshot_at, 1, 10)) ASC,
                 rank ASC`,
      [key, cutoffDate]);
  } else {
    // anchor === "release": for each song, fetch rows where day-of-chart
    // <= release_date + window. SQLite date('+N days') works on YYYY-MM-DD
    // strings. We compute the COALESCE day inline because chart_date can
    // be NULL on the oldest forward-collected V2.23 rows.
    rows = await d1Query<EntryRow>(env.DB,
      `WITH day_e AS (
         SELECT chart_date, snapshot_at, song_id, song_title, rank, source,
                COALESCE(chart_date, substr(snapshot_at, 1, 10)) AS d
           FROM melon_chart_entries
          WHERE group_key = ? AND ${typeClause}
       ),
       releases AS (
         SELECT song_id, MIN(d) AS release_date FROM day_e GROUP BY song_id
       )
       SELECT e.chart_date, e.snapshot_at, e.song_id, e.song_title,
              e.rank, e.source
         FROM day_e e JOIN releases r USING (song_id)
        WHERE e.d <= date(r.release_date, '+' || ? || ' days')
        ORDER BY e.song_id ASC, e.d ASC, e.rank ASC`,
      [key, window]);
  }

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
    const dates = [...s.perDay.keys()].sort();
    const releaseDate = dates[0] ?? null;
    const series = dates.map(date => {
      const v = s.perDay.get(date)!;
      return {
        date,
        day_offset: releaseDate ? daysBetween(releaseDate, date) : 0,
        rank: v.rank,
        source: v.source,
      };
    });
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
      release_date: releaseDate,
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
  // Meaningful for lookback (shared timeline); for release anchor each
  // song lives on its own offset so we still emit absolute dates for
  // legacy consumers but it represents the union of all per-song windows.
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
    anchor,
    days: anchor === "lookback" ? days : null,
    window: anchor === "release" ? window : null,
    start, end,
    songs,
    daily_summary,
  });
};
