import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";
import {
  buildDiagnostic, groupNameVariants,
  type ShortRow, type DiagnosticInput,
} from "../lib/shortsDiagnostic";

const SELF_KEY = "miiwan";
const WINDOW_DAYS = 90;
const TREND_LIMIT = 400;

interface GroupRow {
  key: string; name: string; name_kr: string;
  context_keywords: string | null; twitter_handles: string | null;
}
interface TrendRow {
  video_id: string; group_key: string; title: string | null;
  content_type: string | null; published_at: string | null;
  views: number | null; likes: number | null; comments: number | null;
  view_count_24h: number | null; viral_velocity_ratio: number | null;
}
interface SummaryRow {
  group_key: string; yt_subscribers: number | null; twitter_posts: number | null;
  naver_total_news: number | null; dc_total_posts: number | null;
}

const parseJsonArr = (s: string | null): string[] => {
  try { const v = s ? JSON.parse(s) : []; return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
};

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  // 최신 stat 1건을 video 당 join 하기 위한 상관 서브쿼리.
  const latestStat = `
    (SELECT views FROM youtube_video_stats WHERE video_id = v.video_id
      ORDER BY snapshot_at DESC LIMIT 1) AS views,
    (SELECT likes FROM youtube_video_stats WHERE video_id = v.video_id
      ORDER BY snapshot_at DESC LIMIT 1) AS likes,
    (SELECT comments FROM youtube_video_stats WHERE video_id = v.video_id
      ORDER BY snapshot_at DESC LIMIT 1) AS comments`;

  const groups = await d1Query<GroupRow>(env.DB,
    `SELECT key, name, name_kr, context_keywords, twitter_handles
       FROM groups WHERE is_active = 1`);
  const nameByKey: Record<string, string> = {};
  for (const g of groups) nameByKey[g.key] = g.name_kr || g.name;

  // 경쟁사(=MiiWAN 제외) 숏폼, 최근 90일.
  const trendRows = await d1Query<TrendRow>(env.DB,
    `SELECT v.video_id, v.group_key, v.title, v.content_type, v.published_at,
            v.view_count_24h, v.viral_velocity_ratio, ${latestStat}
       FROM youtube_videos v
      WHERE v.is_short = 1 AND v.group_key != ?
        AND v.published_at >= datetime('now', ?)
      ORDER BY v.published_at DESC
      LIMIT ?`,
    [SELF_KEY, `-${WINDOW_DAYS} days`, TREND_LIMIT]);

  const trend = trendRows.map((r) => ({ ...r, group_name_kr: nameByKey[r.group_key] ?? r.group_key }));

  // MiiWAN 숏폼 전체 (진단용 — 90일 제한 없음, 표본 확보).
  const miiwanShorts = await d1Query<ShortRow>(env.DB,
    `SELECT v.video_id, v.title, v.published_at, v.viral_velocity_ratio, ${latestStat}
       FROM youtube_videos v
      WHERE v.is_short = 1 AND v.group_key = ?`,
    [SELF_KEY]);

  const summaryNow = await d1Query<SummaryRow>(env.DB,
    `SELECT group_key, yt_subscribers, twitter_posts, naver_total_news, dc_total_posts
       FROM agg_summary
      WHERE group_key = ?
      ORDER BY snapshot_at DESC LIMIT 1`, [SELF_KEY]);
  const summaryPrev = await d1Query<{ group_key: string; naver_total_news: number | null }>(env.DB,
    `SELECT group_key, naver_total_news
       FROM agg_summary
      WHERE group_key = ? AND snapshot_at <= datetime('now', '-7 days')
      ORDER BY snapshot_at DESC LIMIT 1`, [SELF_KEY]);
  const members = await d1Query<{ composite_score: number | null }>(env.DB,
    `SELECT composite_score FROM agg_member_popularity
      WHERE group_key = ?
        AND snapshot_at = (SELECT MAX(snapshot_at) FROM agg_member_popularity WHERE group_key = ?)`,
    [SELF_KEY, SELF_KEY]);

  const self = groups.find((g) => g.key === SELF_KEY);
  const s = summaryNow[0];
  const input: DiagnosticInput = {
    group_key: SELF_KEY,
    shorts: miiwanShorts,
    groupTokens: self
      ? groupNameVariants(self.name, self.name_kr, parseJsonArr(self.context_keywords))
      : [SELF_KEY],
    subscribers: s?.yt_subscribers ?? null,
    twitterHandles: self ? parseJsonArr(self.twitter_handles) : [],
    twitterPosts: s?.twitter_posts ?? null,
    newsCount: s?.naver_total_news ?? null,
    newsCountPrev: summaryPrev[0]?.naver_total_news ?? null,
    dcPosts: s?.dc_total_posts ?? null,
    memberShares: members.map((m) => m.composite_score ?? 0),
  };

  return jsonResponse({
    generated_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    limit: TREND_LIMIT,
    trend,
    groups: groups.filter((g) => g.key !== SELF_KEY).map((g) => ({ key: g.key, name_kr: g.name_kr })),
    diagnostic: buildDiagnostic(input),
  });
};
