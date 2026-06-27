import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface GroupRow {
  key: string; name: string; name_kr: string; debut_date: string | null;
  group_model: string | null;
}

interface SummaryRow {
  group_key: string; snapshot_at: string;
  yt_total_videos: number; yt_total_views: number; yt_subscribers: number;
  dc_total_posts: number; theqoo_posts: number; instiz_posts: number;
  naver_total_news: number; twitter_posts: number; controversy_count: number;
}

interface HealthRow {
  group_key: string; snapshot_at: string; total: number | null; grade: string;
  label: string | null; breakdown_json: string | null; bonus_json: string | null;
  quality_method: string | null;
}

interface InsightRow {
  id: number; title: string; body: string; scope: string; type: string;
  source_refs_json: string | null; generated_at: string;
}

interface AwarenessRow {
  group_key: string; awareness_score: number | null;
  category_rank: number | null; basis: string;
}

const safeJson = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const groups = await d1Query<GroupRow>(env.DB,
    "SELECT key, name, name_kr, debut_date, group_model FROM groups WHERE is_active=1 ORDER BY key");

  // Per-group latest snapshot. We deliberately do NOT take the global
  // MAX(snapshot_at) row — a fresh live row that wrote NULL/0 for
  // yt_subscribers/yt_total_views (e.g. when youtube_channel_stats
  // hasn't been collected yet for a brand-new group) would otherwise
  // mask the SB backfill row that has the real subs/views. Per-group
  // MAX gives each group its own latest snapshot independently. The
  // forward-fill below then patches missing columns from the most
  // recent non-null backfill row.
  const sums = await d1Query<SummaryRow>(env.DB,
    `SELECT s.* FROM agg_summary s
      WHERE s.snapshot_at = (
        SELECT MAX(snapshot_at) FROM agg_summary
         WHERE group_key = s.group_key
      )`);

  // Forward-fill source: latest non-null value PER COLUMN across all
  // snapshots (live + backfill). When the latest snapshot has NULL
  // subs/views (e.g. wegosix on day-zero of channel-stats collection),
  // we substitute the most recent rolling-up backfill_estimate value.
  // Single SQL is fine because we run it once across all groups.
  const fillRows = await d1Query<{
    group_key: string;
    yt_subscribers: number | null;
    yt_total_views: number | null;
    yt_total_videos: number | null;
  }>(env.DB,
    `SELECT group_key,
            (SELECT yt_subscribers FROM agg_summary
              WHERE group_key = a.group_key AND yt_subscribers IS NOT NULL
              ORDER BY snapshot_at DESC LIMIT 1) AS yt_subscribers,
            (SELECT yt_total_views FROM agg_summary
              WHERE group_key = a.group_key AND yt_total_views IS NOT NULL
              ORDER BY snapshot_at DESC LIMIT 1) AS yt_total_views,
            (SELECT yt_total_videos FROM agg_summary
              WHERE group_key = a.group_key AND yt_total_videos IS NOT NULL
              ORDER BY snapshot_at DESC LIMIT 1) AS yt_total_videos
       FROM (SELECT DISTINCT group_key FROM agg_summary) a`);
  const fillByKey: Record<string, {
    yt_subscribers: number | null;
    yt_total_views: number | null;
    yt_total_videos: number | null;
  }> = {};
  for (const f of fillRows) fillByKey[f.group_key] = f;

  // Per-group 7d-ago snapshot for WoW delta on the cards. We take the
  // latest snapshot per group at-or-before now-7d (graceful fallback
  // when collection windows are uneven). This is one indexed query
  // per group via correlated subquery — D1 handles 8 rows fine.
  const prevSums = await d1Query<SummaryRow>(env.DB,
    `SELECT s.* FROM agg_summary s
      WHERE s.snapshot_at = (
        SELECT MAX(snapshot_at) FROM agg_summary
         WHERE group_key = s.group_key
           AND snapshot_at <= datetime('now', '-7 days')
      )`);

  const healths = await d1Query<HealthRow>(env.DB,
    `SELECT * FROM agg_health_scores
      WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_health_scores)`);

  const insights = await d1Query<InsightRow>(env.DB,
    `SELECT id, title, body, scope, type, source_refs_json, generated_at
       FROM insights
      WHERE scope='market' OR type='ipx_action'
      ORDER BY generated_at DESC LIMIT 30`);

  const awareness = await d1Query<AwarenessRow>(env.DB,
    `SELECT group_key, awareness_score, category_rank, basis
       FROM agg_awareness
      WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_awareness)`);

  const sumByKey: Record<string, SummaryRow> = {};
  for (const s of sums) sumByKey[s.group_key] = s;
  const prevSumByKey: Record<string, SummaryRow> = {};
  for (const s of prevSums) prevSumByKey[s.group_key] = s;
  const healthByKey: Record<string, HealthRow> = {};
  for (const h of healths) healthByKey[h.group_key] = h;
  const awarenessByKey: Record<string, AwarenessRow> = {};
  for (const a of awareness) awarenessByKey[a.group_key] = a;

  const out: Record<string, unknown> = {};
  for (const g of groups) {
    const s = sumByKey[g.key];
    const h = healthByKey[g.key];
    const p = prevSumByKey[g.key];
    const f = fillByKey[g.key] ?? {
      yt_subscribers: null, yt_total_views: null, yt_total_videos: null,
    };
    const aw = awarenessByKey[g.key];
    out[g.key] = {
      name: g.name, name_kr: g.name_kr, debut_date: g.debut_date,
      group_model: g.group_model ?? "corporate",
      summary: s ? {
        // Forward-fill yt_* from latest non-null per column.
        yt_total_videos: s.yt_total_videos ?? f.yt_total_videos,
        yt_total_views:  s.yt_total_views  ?? f.yt_total_views,
        yt_subscribers:  s.yt_subscribers  ?? f.yt_subscribers,
        dc_total_posts: s.dc_total_posts, theqoo_posts: s.theqoo_posts,
        instiz_posts: s.instiz_posts, naver_total_news: s.naver_total_news,
        twitter_posts: s.twitter_posts, controversy_count: s.controversy_count,
      } : null,
      prev_summary: p ? {
        yt_total_views: p.yt_total_views, yt_subscribers: p.yt_subscribers,
        dc_total_posts: p.dc_total_posts, naver_total_news: p.naver_total_news,
        twitter_posts: p.twitter_posts, controversy_count: p.controversy_count,
      } : null,
      health_score: h ? {
        total: h.total, grade: h.grade, label: h.label,
        breakdown: safeJson(h.breakdown_json),
        bonus: safeJson(h.bonus_json),
        quality_method: h.quality_method,
      } : null,
      awareness: aw ? {
        score: aw.basis === "scored" ? aw.awareness_score : null,
        category_rank: aw.basis === "scored" ? aw.category_rank : null,
      } : null,
    };
  }

  return jsonResponse({
    generated_at: sums[0]?.snapshot_at ?? null,
    groups: out,
    market_insights: insights.map((i) => ({
      id: i.id, title: i.title, body: i.body, scope: i.scope, type: i.type,
      source_refs: (() => { try { return JSON.parse(i.source_refs_json ?? "[]"); }
                            catch { return []; } })(),
      generated_at: i.generated_at,
    })),
  });
};
