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
            v.view_count_24h, v.viral_velocity_ratio,
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

  // V2.5: hanteo album lifecycle. We pull the full weekly series per
  // album so the frontend can render dive curves and pattern labels
  // (밀리언/롱런/자연사/역주행). Limited to albums with sales data
  // and ordered chronologically per album.
  const hanteo = await d1Query<{
    album: string; week_start: string; week_end: string;
    rank: number | null; sales: number | null;
  }>(env.DB,
    `SELECT album, week_start, week_end, rank, sales
       FROM hanteo_weekly
      WHERE group_key=? AND sales IS NOT NULL AND sales > 0
      ORDER BY album, week_start ASC`, [key]);

  // V2.5: dual-entity combined views for the toggle (group_only / sum /
  // weighted). Latest snapshot per method. We always return three rows
  // when the worker has run aggregate at least once, even if some are
  // identical (corporate groups with no member channels).
  const combined = await d1Query<{
    combined_method: string;
    yt_subscribers_combined: number;
    yt_views_combined: number;
    yt_videos_combined: number;
    group_subs: number;
    member_subs: number;
    active_member_channel_count: number;
  }>(env.DB,
    `SELECT combined_method, yt_subscribers_combined, yt_views_combined,
            yt_videos_combined, group_subs, member_subs,
            active_member_channel_count
       FROM agg_group_combined
      WHERE group_key=? AND snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_group_combined WHERE group_key=?
      )`, [key, key]);
  const combinedByMethod: Record<string, unknown> = {};
  for (const r of combined) {
    combinedByMethod[r.combined_method] = {
      subscribers: r.yt_subscribers_combined,
      views:       r.yt_views_combined,
      videos:      r.yt_videos_combined,
      group_subs:  r.group_subs,
      member_subs: r.member_subs,
      member_channel_count: r.active_member_channel_count,
    };
  }

  // Group hanteo rows into per-album lifecycle objects.
  const albumMap: Record<string, Array<typeof hanteo[number]>> = {};
  for (const r of hanteo) {
    const list = albumMap[r.album] ?? (albumMap[r.album] = []);
    list.push(r);
  }
  const albumLifecycles = Object.entries(albumMap)
    .filter(([, weeks]) => weeks.length > 0)
    .map(([album, weeks]) => {
      const first = weeks[0]!;
      const last = weeks[weeks.length - 1]!;
      const w1 = first.sales ?? 0;
      const peak = weeks.reduce(
        (m, w) => ((w.sales ?? 0) > (m.sales ?? 0) ? w : m), first);
      // Pattern classification (밀리언/롱런/자연사/역주행).
      let pattern: "millennium" | "longrun" | "naturaldecay" | "rebound" | "n/a";
      if (weeks.length < 2) {
        pattern = "n/a";
      } else if (peak.week_start !== first.week_start
                 && (peak.sales ?? 0) > w1 * 1.1) {
        pattern = "rebound";
      } else if (w1 >= 1_000_000) {
        pattern = "millennium";
      } else {
        const w4 = weeks.find((_, i) => i >= 3) ?? last;
        const decayRatio = (w4.sales ?? 0) / Math.max(w1, 1);
        pattern = decayRatio >= 0.3 ? "longrun" : "naturaldecay";
      }
      return {
        album,
        release_week_start: first.week_start,
        weeks: weeks.map((w) => ({
          week_start: w.week_start, week_end: w.week_end,
          rank: w.rank, sales: w.sales,
        })),
        first_week_sales: w1,
        latest_sales: last.sales ?? 0,
        peak_sales: peak.sales ?? 0,
        pattern,
      };
    });
  // Most recent release first.
  albumLifecycles.sort((a, b) =>
    (b.release_week_start ?? "").localeCompare(a.release_week_start ?? ""));

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
    combined_views: combinedByMethod,   // {group_only, sum, weighted}
    yt_top15: ytTop,
    community_top: commTop,
    naver_articles: naver,
    twitter_posts: tweets,
    albums: albumLifecycles,            // V2.5 dive curves
  });
};
