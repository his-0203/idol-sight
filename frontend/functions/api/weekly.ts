import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const insights = await d1Query<any>(env.DB,
    `SELECT id, week_start, scope, type, title, body, source_refs_json, generated_at
       FROM insights
      WHERE type IN ('weekly', 'insight', 'ipx_action')
      ORDER BY generated_at DESC LIMIT 30`);
  const hanteo = await d1Query<any>(env.DB,
    `SELECT h.week_start, h.week_end, h.group_key,
            COALESCE(g.name, h.group_key) AS group_name,
            h.album, h.rank, h.sales, h.note
       FROM hanteo_weekly h
       LEFT JOIN groups g ON g.key = h.group_key
      WHERE h.week_end = (SELECT MAX(week_end) FROM hanteo_weekly)
      ORDER BY h.rank ASC`);
  const movers = await d1Query<any>(env.DB,
    `SELECT s.group_key,
            COALESCE(g.name, s.group_key) AS group_name,
            s.yt_total_views - COALESCE(p.yt_total_views, 0) AS d_views,
            s.dc_total_posts  - COALESCE(p.dc_total_posts, 0)  AS d_dc
       FROM agg_summary s
       LEFT JOIN groups g ON g.key = s.group_key
       LEFT JOIN agg_summary p
              ON p.group_key = s.group_key
             AND p.snapshot_at = (
                SELECT MAX(snapshot_at) FROM agg_summary
                  WHERE group_key = s.group_key
                    AND snapshot_at < s.snapshot_at)
      WHERE s.snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)
      ORDER BY d_views DESC NULLS LAST`);
  return jsonResponse({ insights, hanteo, movers });
};
