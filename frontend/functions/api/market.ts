import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface GroupRow { key: string; name: string; name_kr: string; debut_date: string | null }

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

const safeJson = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const groups = await d1Query<GroupRow>(env.DB,
    "SELECT key, name, name_kr, debut_date FROM groups WHERE is_active=1 ORDER BY key");

  const sums = await d1Query<SummaryRow>(env.DB,
    `SELECT * FROM agg_summary
      WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)`);

  const healths = await d1Query<HealthRow>(env.DB,
    `SELECT * FROM agg_health_scores
      WHERE snapshot_at = (SELECT MAX(snapshot_at) FROM agg_health_scores)`);

  const insights = await d1Query<InsightRow>(env.DB,
    `SELECT id, title, body, scope, type, source_refs_json, generated_at
       FROM insights
      WHERE scope='market' OR type='ipx_action'
      ORDER BY generated_at DESC LIMIT 30`);

  const sumByKey: Record<string, SummaryRow> = {};
  for (const s of sums) sumByKey[s.group_key] = s;
  const healthByKey: Record<string, HealthRow> = {};
  for (const h of healths) healthByKey[h.group_key] = h;

  const out: Record<string, unknown> = {};
  for (const g of groups) {
    const s = sumByKey[g.key];
    const h = healthByKey[g.key];
    out[g.key] = {
      name: g.name, name_kr: g.name_kr, debut_date: g.debut_date,
      summary: s ? {
        yt_total_videos: s.yt_total_videos, yt_total_views: s.yt_total_views,
        yt_subscribers: s.yt_subscribers,
        dc_total_posts: s.dc_total_posts, theqoo_posts: s.theqoo_posts,
        instiz_posts: s.instiz_posts, naver_total_news: s.naver_total_news,
        twitter_posts: s.twitter_posts, controversy_count: s.controversy_count,
      } : null,
      health_score: h ? {
        total: h.total, grade: h.grade, label: h.label,
        breakdown: safeJson(h.breakdown_json),
        bonus: safeJson(h.bonus_json),
        quality_method: h.quality_method,
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
