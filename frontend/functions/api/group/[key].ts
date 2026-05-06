import { d1Query, d1QueryOne, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

const safeJson = (s: string | null) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, params }) => {
  const key = String(params.key);

  const group = await d1QueryOne<{
    key: string; name: string; name_kr: string; debut_date: string | null;
    group_model: string | null;
  }>(env.DB,
    "SELECT key, name, name_kr, debut_date, group_model FROM groups WHERE key=? AND is_active=1",
    [key]);
  if (!group) return jsonResponse({ error: "not_found" }, 404);

  const summary = await d1QueryOne<any>(env.DB,
    `SELECT * FROM agg_summary
      WHERE group_key=? AND snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_summary WHERE group_key=?
      )`, [key, key]);

  // Forward-fill source for yt_* columns — when latest snapshot has
  // NULL (e.g. wegosix on day-zero of channel-stats collection) we
  // substitute the most recent non-null backfill row. Same defense
  // as /api/market.
  const fill = await d1QueryOne<{
    yt_subscribers: number | null;
    yt_total_views: number | null;
    yt_total_videos: number | null;
  }>(env.DB,
    `SELECT
        (SELECT yt_subscribers FROM agg_summary
          WHERE group_key=? AND yt_subscribers IS NOT NULL
          ORDER BY snapshot_at DESC LIMIT 1) AS yt_subscribers,
        (SELECT yt_total_views FROM agg_summary
          WHERE group_key=? AND yt_total_views IS NOT NULL
          ORDER BY snapshot_at DESC LIMIT 1) AS yt_total_views,
        (SELECT yt_total_videos FROM agg_summary
          WHERE group_key=? AND yt_total_videos IS NOT NULL
          ORDER BY snapshot_at DESC LIMIT 1) AS yt_total_videos`,
    [key, key, key]);
  if (summary) {
    summary.yt_subscribers  = summary.yt_subscribers  ?? fill?.yt_subscribers  ?? null;
    summary.yt_total_views  = summary.yt_total_views  ?? fill?.yt_total_views  ?? null;
    summary.yt_total_videos = summary.yt_total_videos ?? fill?.yt_total_videos ?? null;
  }

  // 7-day-ago snapshot for WoW delta. We grab the latest snapshot at
  // or before now-7d (rather than exact date arithmetic) so missed
  // collection windows degrade gracefully — if no snapshot existed
  // exactly 7 days ago we fall back to the most recent one within
  // that window.
  const prevSummary = await d1QueryOne<any>(env.DB,
    `SELECT * FROM agg_summary
      WHERE group_key=?
        AND snapshot_at <= datetime('now', '-7 days')
      ORDER BY snapshot_at DESC LIMIT 1`, [key]);

  const health = await d1QueryOne<any>(env.DB,
    `SELECT total, grade, label, breakdown_json, bonus_json, quality_method
       FROM agg_health_scores
      WHERE group_key=? AND snapshot_at=(
        SELECT MAX(snapshot_at) FROM agg_health_scores WHERE group_key=?
      )`, [key, key]);

  // 30-day Health Score history for the Hero sparkline. Daily
  // aggregator runs once per cycle so we just take every snapshot
  // in the window in chronological order — no resampling needed.
  // Limit a generous 64 rows in case the cron fires more than daily;
  // sparkline component handles arbitrary point counts.
  const healthHistory = await d1Query<{ snapshot_at: string; total: number | null }>(
    env.DB,
    `SELECT snapshot_at, total FROM agg_health_scores
      WHERE group_key=? AND snapshot_at >= datetime('now', '-30 days')
      ORDER BY snapshot_at ASC LIMIT 64`, [key]);

  // 30-day summary history — used for KPI sparklines (subscribers,
  // views, dc posts, naver news). One row per cycle is enough; the
  // KPI sparkline normalizes to its own min/max so absolute scale
  // mismatches across columns don't matter.
  const summaryHistory = await d1Query<any>(env.DB,
    `SELECT snapshot_at,
            yt_total_views, yt_subscribers, yt_total_videos,
            dc_total_posts, naver_total_news, twitter_posts,
            controversy_count
       FROM agg_summary
      WHERE group_key=? AND snapshot_at >= datetime('now', '-30 days')
      ORDER BY snapshot_at ASC LIMIT 64`, [key]);

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
    `SELECT cp.url_hash, cp.url, cp.title, cp.platform, cp.posted_at,
            cp.sentiment,
            COALESCE(cps.views,0) AS views,
            COALESCE(cps.likes,0) AS likes,
            COALESCE(cps.comments,0) AS comments
       FROM community_posts cp
       LEFT JOIN community_post_stats cps ON cps.url_hash = cp.url_hash
        AND cps.snapshot_at = (SELECT MAX(snapshot_at) FROM community_post_stats
                                 WHERE url_hash = cp.url_hash)
      WHERE cp.group_key = ?
        AND COALESCE(cp.user_flagged_irrelevant, 0) = 0
      ORDER BY views DESC LIMIT 30`, [key]);

  const naver = await d1Query<any>(env.DB,
    `SELECT title, url, source, published_at FROM naver_articles
      WHERE group_key=? AND COALESCE(is_excluded,0)=0
      ORDER BY published_at DESC LIMIT 30`, [key]);

  const tweets = await d1Query<any>(env.DB,
    `SELECT tweet_id, title, author_handle, url, posted_at, type
       FROM twitter_posts WHERE group_key=?
      ORDER BY posted_at DESC LIMIT 30`, [key]);

  // Recent alerts emitted by the worker for this group. We pull the
  // last 14 days so the PR/Risk view can render the worker's actual
  // critical signals (controversy_spike / identity_leak / model_theft
  // / video_velocity_24h / debut_milestone) instead of re-deriving
  // weak heuristics in the frontend. A 14-day window matches the
  // operator's review cadence and stays cheap to query.
  const alerts = await d1Query<any>(env.DB,
    `SELECT alert_key, rule, scope, severity, title, body, fired_at
       FROM alerts
      WHERE scope=? AND fired_at >= datetime('now', '-14 days')
      ORDER BY fired_at DESC LIMIT 30`, [key]);

  // Scope-filtered insights for this group's page (last 30d window —
  // matches the WeeklyUpdate retention). LLM weekly emits scope='miiwan'
  // / 'plave' / etc. Group page should surface only the items that name
  // this group; market-scope items belong on MarketOverview.
  const insights = await d1Query<any>(env.DB,
    `SELECT id, title, body, scope, type, source_refs_json, generated_at
       FROM insights
      WHERE scope=? AND generated_at >= datetime('now', '-30 days')
      ORDER BY generated_at DESC LIMIT 20`, [key]);

  // Controversy trend — the worker's controversy_spike rule fires on a
  // 2× WoW multiplier with a 5-count floor; the frontend mirrors those
  // thresholds so the displayed Risk Level stays in lock-step with the
  // Discord alert. We need the current and the prior weekly snapshot's
  // controversy_count, both already in agg_summary.
  const controversyTrend = await d1QueryOne<{ current: number; previous: number | null }>(
    env.DB,
    `SELECT
        (SELECT controversy_count FROM agg_summary
          WHERE group_key=? AND snapshot_at=(SELECT MAX(snapshot_at) FROM agg_summary WHERE group_key=?)
        ) AS current,
        (SELECT controversy_count FROM agg_summary
          WHERE group_key=? AND snapshot_at=(
            SELECT MAX(snapshot_at) FROM agg_summary
             WHERE group_key=?
               AND snapshot_at < (SELECT MAX(snapshot_at) FROM agg_summary WHERE group_key=?))
        ) AS previous`,
    [key, key, key, key, key],
  );

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
    group_model: group.group_model ?? "corporate",
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
    alerts,                             // worker-emitted critical signals
    insights: insights.map((i) => ({
      id: i.id, title: i.title, body: i.body,
      scope: i.scope, type: i.type,
      source_refs: (() => { try { return JSON.parse(i.source_refs_json ?? "[]"); }
                            catch { return []; } })(),
      generated_at: i.generated_at,
    })),
    controversy_trend: controversyTrend,
    prev_summary: prevSummary,          // 7-day-ago WoW baseline
    health_history: healthHistory,      // 30d sparkline points
    summary_history: summaryHistory,    // 30d KPI sparkline points
  });
};
