import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const insights = await d1Query<any>(env.DB,
    `SELECT id, week_start, scope, type, title, body, source_refs_json, generated_at
       FROM insights
      WHERE type='weekly'
      ORDER BY generated_at DESC LIMIT 20`);
  const hanteo = await d1Query<any>(env.DB,
    `SELECT week_start, week_end, group_key, album, rank, sales, note
       FROM hanteo_weekly
      WHERE week_end = (SELECT MAX(week_end) FROM hanteo_weekly)
      ORDER BY rank ASC`);
  const movers = await d1Query<any>(env.DB,
    `SELECT s.group_key,
            s.yt_total_views - COALESCE(p.yt_total_views, 0) AS d_views,
            s.dc_total_posts  - COALESCE(p.dc_total_posts, 0)  AS d_dc
       FROM agg_summary s
       LEFT JOIN agg_summary p
              ON p.group_key = s.group_key
             AND p.snapshot_at = (
                SELECT MAX(snapshot_at) FROM agg_summary
                  WHERE group_key = s.group_key
                    AND snapshot_at < s.snapshot_at)
      WHERE s.snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)`);
  return jsonResponse({ insights, hanteo, movers });
};
