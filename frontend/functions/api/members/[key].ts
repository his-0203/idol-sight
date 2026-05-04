import { d1Query, d1QueryOne, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, params }) => {
  const key = String(params.key);
  const meta = await d1QueryOne<any>(env.DB,
    `SELECT hhi, evenness, status FROM agg_member_pop_meta
      WHERE group_key=? AND snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_member_pop_meta WHERE group_key=?
      )`, [key, key]);
  const rows = await d1Query<any>(env.DB,
    `SELECT m.id, m.name, m.name_en,
            mp.yt_score, mp.community_score, mp.composite_score,
            mp.yt_videos, mp.yt_avg_views, mp.yt_sufficient,
            mp.community_mentions
       FROM agg_member_popularity mp
       JOIN members m ON m.id = mp.member_id
      WHERE mp.group_key=? AND mp.snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_member_popularity WHERE group_key=?
      )
      ORDER BY mp.composite_score DESC`, [key, key]);
  return jsonResponse({
    group_key: key,
    hhi: meta?.hhi ?? null,
    evenness: meta?.evenness ?? null,
    status: meta?.status ?? "insufficient",
    members: rows,
  });
};
