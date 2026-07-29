// /api/debut-curve — debut-aligned time series for cohort comparison.
//
// Returns per-group agg_summary points indexed by *days since (or
// before) the group's debut_date* instead of raw calendar dates. This
// lets the BI overlay every group's curve on a single "days from
// debut" x-axis so the operator can answer: "Where is MiiWAN at D-30
// vs where SKINZ / OWIS / B:DAWN were at D-30?".
//
// Caveats the operator should know about:
//   - Groups debuted long before collection started (PLAVE 2023,
//     ISEDOL 2021, STELLIVE 2023) only have post-debut points at
//     large positive offsets; their D-30 / D+30 region is empty
//     because we have no backfill for that period.
//   - For each (group, day_offset) bucket we keep the LAST snapshot
//     in the day so the curve smooths over multi-snapshot days
//     without double-counting.
//
// Query params:
//   metric: column name on agg_summary. Default 'yt_subscribers'.
//   from:   integer day offset (inclusive). Default -60.
//   to:     integer day offset (inclusive). Default  180.

import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";
import { alignByDebut } from "../lib/debutAligned";

const ALLOWED_METRICS = new Set([
  "yt_subscribers",
  "yt_total_views",
  "yt_total_videos",
  "dc_total_posts",
  "naver_total_news",
  "controversy_count",
]);

interface Row {
  group_key: string; name: string; debut_date: string | null; group_model: string | null;
  snapshot_at: string; value: number | null;
  source: 'live' | 'backfill_exact' | 'backfill_estimate';
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const metric = url.searchParams.get("metric") || "yt_subscribers";
  if (!ALLOWED_METRICS.has(metric)) {
    return jsonResponse({ error: "invalid_metric", allowed: [...ALLOWED_METRICS] }, 400);
  }
  const from = Number.parseInt(url.searchParams.get("from") ?? "-60", 10);
  const to   = Number.parseInt(url.searchParams.get("to")   ?? "180", 10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return jsonResponse({ error: "invalid_range" }, 400);
  }

  // Pull every (group, snapshot_at, metric) row whose snapshot's day
  // offset from the group's debut_date falls in [from, to]. SQLite's
  // julianday() handles ISO dates fine; we cast to int for an integer
  // day offset bucket. Groups without a debut_date are excluded —
  // there's nothing to align them to.
  // confederation 모델 (STELLIVE) 은 우산형 산하 멤버 그룹별로 데뷔
  // 일자가 다른 구조라 단일 debut_date 정렬이 의미가 없음.
  // MarketOverview 카드에서는 정상 표시되지만 DebutCurve 차트에서만
  // 제외 — 산하 그룹별 D-day 라인을 그릴 수 있는 별도 view 가 생기면
  // 그때 다시 포함.
  const rows = await d1Query<Row>(env.DB,
    `SELECT g.key AS group_key, g.name, g.debut_date, g.group_model,
            s.snapshot_at, s.${metric} AS value, s.data_source AS source
       FROM agg_summary s
       JOIN groups g ON g.key = s.group_key
      WHERE g.is_active = 1
        AND (g.group_model IS NULL OR g.group_model != 'confederation')
        AND g.debut_date IS NOT NULL
        AND CAST(julianday(date(s.snapshot_at)) - julianday(g.debut_date) AS INTEGER) BETWEEN ? AND ?
      ORDER BY g.key, s.snapshot_at ASC`,
    [from, to]);

  // (group, day) MAX 버킷팅 규칙은 ../lib/debutAligned.ts 참조.
  const aligned = alignByDebut(rows, from, to);
  const meta: Record<string, { name: string; debut_date: string; group_model: string }> = {};
  for (const r of rows) {
    if (!r.debut_date) continue;
    meta[r.group_key] ??= {
      name: r.name, debut_date: r.debut_date, group_model: r.group_model ?? "corporate",
    };
  }
  const series = Object.entries(aligned).map(([key, points]) => ({
    group_key: key,
    ...meta[key]!,
    points: [...points.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([day, p]) => ({ day_offset: day, value: p.value, source: p.source })),
  }));

  return jsonResponse({ metric, from, to, series });
};
