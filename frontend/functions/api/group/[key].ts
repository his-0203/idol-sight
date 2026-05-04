import { d1Query, d1QueryOne, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

const safeJson = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, params }) => {
  const key = String(params.key);

  const group = await d1QueryOne<{
    key: string; name: string; name_kr: string; debut_date: string | null;
  }>(env.DB,
    "SELECT key, name, name_kr, debut_date FROM groups WHERE key=? AND is_active=1",
    [key]);
  if (!group) return jsonResponse({ error: "not_found" }, 404);

  const summary = await d1QueryOne<any>(env.DB,
    `SELECT * FROM agg_summary
      WHERE group_key=? AND snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_summary WHERE group_key=?
      )`, [key, key]);

  const health = await d1QueryOne<any>(env.DB,
    `SELECT total, grade, label, breakdown_json, bonus_json, quality_method
       FROM agg_health_scores
      WHERE group_key=? AND snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_health_scores WHERE group_key=?
      )`, [key, key]);

  const ytTop = await d1Query<any>(env.DB,
    `SELECT v.video_id, v.title, v.published_at, v.content_type, v.is_short,
            COALESCE(s.views,0) AS views,
            COALESCE(s.likes,0) AS likes,
            COALESCE(s.comments,0) AS comments
       FROM youtube_videos v
       LEFT JOIN youtube_video_stats s ON s.video_id = v.video_id
        AND s.snapshot_at = (SELECT MAX(snapshot_at) FROM youtube_video_stats
                               WHERE video_id = v.video_id)
      WHERE v.group_key = ?
      ORDER BY views DESC LIMIT 15`, [key]);

  const commTop = await d1Query<any>(env.DB,
    `SELECT cp.url, cp.title, cp.platform, cp.posted_at,
            COALESCE(cps.views,0) AS views,
            COALESCE(cps.likes,0) AS likes,
            COALESCE(cps.comments,0) AS comments
       FROM community_posts cp
       LEFT JOIN community_post_stats cps ON cps.url_hash = cp.url_hash
        AND cps.snapshot_at = (SELECT MAX(snapshot_at) FROM community_post_stats
                                 WHERE url_hash = cp.url_hash)
      WHERE cp.group_key = ?
      ORDER BY views DESC LIMIT 30`, [key]);

  const naver = await d1Query<any>(env.DB,
    `SELECT title, url, source, published_at FROM naver_articles
      WHERE group_key=? AND COALESCE(is_excluded,0)=0
      ORDER BY published_at DESC LIMIT 30`, [key]);

  const tweets = await d1Query<any>(env.DB,
    `SELECT tweet_id, title, author_handle, url, posted_at, type
       FROM twitter_posts WHERE group_key=?
      ORDER BY posted_at DESC LIMIT 30`, [key]);

  return jsonResponse({
    group_key: group.key,
    name: group.name, name_kr: group.name_kr, debut_date: group.debut_date,
    summary,
    health_score: health ? {
      total: health.total, grade: health.grade, label: health.label,
      breakdown: safeJson(health.breakdown_json),
      bonus: safeJson(health.bonus_json),
      quality_method: health.quality_method,
    } : null,
    yt_top15: ytTop,
    community_top: commTop,
    naver_articles: naver,
    twitter_posts: tweets,
  });
};
