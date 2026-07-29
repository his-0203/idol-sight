// /api/miiwan — dedicated MiiWAN briefing endpoint.
//
// MiiWAN is the IPX × Abyss joint debut (2026-06). The dashboard team
// needs an own-brand view, not a generic group page, so this endpoint
// bundles everything the briefing tab renders in one round-trip:
//
//   1. group meta + days-to-debut countdown
//   2. latest agg_summary + health for MiiWAN
//   3. active member roster (with whether each has a solo channel)
//   4. MiiWAN-scoped insights (scope='miiwan' OR type='ipx_action' tied
//      to MiiWAN). Falls back to recent ipx_actions if Gemini hasn't
//      produced any miiwan-scoped item yet.
//
// (Cohort/anchor benchmark comparisons moved to /api/miiwan-cohort.)
//
// We bias toward returning partials. If a section has no data the
// frontend renders an empty-state card rather than failing the page.

import { d1Query, d1QueryOne, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

const TARGET = "miiwan";

interface GroupRow {
  key: string; name: string; name_kr: string;
  debut_date: string | null; yt_channel_id: string | null;
}

interface MemberRow {
  id: number; name: string; name_en: string | null;
  yt_channel_id: string | null; active: number;
}

interface SummaryRow {
  group_key: string; snapshot_at: string;
  yt_total_videos: number; yt_total_views: number; yt_subscribers: number;
  dc_total_posts: number; theqoo_posts: number; instiz_posts: number;
  naver_total_news: number; controversy_count: number;
  data_source: string;
}

interface HealthRow {
  group_key: string; snapshot_at: string;
  total: number | null; grade: string;
  label: string | null; breakdown_json: string | null;
}

interface InsightRow {
  id: number; title: string; body: string; scope: string; type: string;
  source_refs_json: string | null; ai_comment: string | null;
  generated_at: string;
}

// DECISION 탭 — 굿즈 멤버배분의 공개 프록시. agg_member_popularity의
// composite_score를 인기 비중으로 쓴다. yt_sufficient=0이면 표본 부족.
interface MemberPopularityRow {
  member_id: number;
  composite_score: number | null;
  yt_score: number | null;
  yt_avg_views: number | null;
  yt_videos: number | null;
  yt_sufficient: number;
}

// 미완소년 소유자 OAuth(Analytics) 적재 — migration 0087. OAuth 미연결이면
// 행이 없어 decision.analytics 가 null → 프론트 empty-state.
interface YtAnalyticsRow {
  snapshot_at: string;
  returning_viewers_30d: number | null;
  membership_count: number | null;
  membership_penetration: number | null;
  has_super_chat: number | null;
}
interface YtAnalyticsCountryRow {
  country: string;
  watch_share: number;
  growth_mom: number | null;
  retention_rel: number | null;
  sub_per_1k: number;
  watch_minutes: number | null;
  organic_share: number | null;
  subs_gained: number | null;
}

// P2a 찐팬 활동량 — 신규 수집 0(기존 live_chat_messages·youtube_video_stats
// 재가공). agg_live_activity_summary(그룹 1행 헤드라인) + agg_live_activity
// (방송별 추이). 마이그레이션(0096 예정) 미적용이면 쿼리만 실패(.catch)하고
// fan_activity=null → 프론트가 '축적 중' empty-state. loyalty 미러.
interface LiveActivitySummaryRow {
  generated_at: string;
  window_days: number;
  broadcast_count: number;
  median_unique_chatters: number | null;
  median_msgs_per_chatter: number | null;
  median_returning_rate: number | null;
  median_peak_msgs_per_min: number | null;
  core_fan_count: number | null;
  core_fan_share: number | null;
  est_engaged_fans: number | null;
  est_active_core: number | null;
  view_through: number | null;
  like_rate: number | null;
  comment_rate: number | null;
  basis: "scored" | "low_confidence" | "insufficient";
}
interface LiveActivityBroadcastRow {
  video_id: string;
  ended_at: string | null;
  unique_chatters: number;
  total_messages: number;
  msgs_per_chatter: number | null;
  peak_msgs_per_min: number | null;
  returning_rate: number | null;
  basis: string;
}

const safeJson = (s: string | null) => {
  try { return s ? JSON.parse(s) : []; } catch { return []; }
};

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  // 1) Group meta
  const group = await d1QueryOne<GroupRow>(
    env.DB,
    "SELECT key, name, name_kr, debut_date, yt_channel_id FROM groups WHERE key=?",
    [TARGET],
  );
  if (!group) {
    return jsonResponse({ error: "miiwan group not seeded" }, 404);
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const debutIso = group.debut_date;
  const daysToDebut = debutIso ? daysBetween(todayIso, debutIso) : null;

  // 2-4) Everything below is scoped to MiiWAN and independent of one another,
  // so issue them concurrently instead of as ~8 serial D1 round-trips. (Each
  // d1Query* is one binding round-trip; Promise.all collapses the wall-clock to
  // a single round-trip's worth.)
  //
  // insights: MiiWAN-scoped + latest ipx_actions, 7-day window (analyze-weekly
  //   runs Mon 09:00 KST so a 7-day cutoff = one fresh cycle; "이번 주 권고만").
  // alerts: worker-emitted, surfaced in the briefing's Risk Watch.
  // controversyTrend: mirrors PRRisk's WoW logic for an in-context risk badge.
  const [
    summary, prevSummary, summaryHistory, health, members, insights, alerts,
    controversyTrend, memberPopularity, ytAnalytics, ytAnalyticsCountries,
    goodsPreorder, liveActivitySummary, liveActivityBroadcasts,
  ] = await Promise.all([
    d1QueryOne<SummaryRow>(
      env.DB,
      `SELECT * FROM agg_summary
        WHERE group_key=? AND snapshot_at = (
          SELECT MAX(snapshot_at) FROM agg_summary WHERE group_key=?)`,
      [TARGET, TARGET],
    ),
    d1QueryOne<SummaryRow>(
      env.DB,
      `SELECT * FROM agg_summary
        WHERE group_key=? AND snapshot_at <= datetime('now', '-7 days')
        ORDER BY snapshot_at DESC LIMIT 1`,
      [TARGET],
    ),
    d1Query<any>(
      env.DB,
      `SELECT snapshot_at, yt_total_views, yt_subscribers, yt_total_videos,
              dc_total_posts, naver_total_news
         FROM agg_summary
        WHERE group_key=? AND snapshot_at >= datetime('now', '-30 days')
        ORDER BY snapshot_at ASC LIMIT 64`,
      [TARGET],
    ),
    d1QueryOne<HealthRow>(
      env.DB,
      `SELECT * FROM agg_health_scores
        WHERE group_key=? AND snapshot_at = (
          SELECT MAX(snapshot_at) FROM agg_health_scores WHERE group_key=?)`,
      [TARGET, TARGET],
    ),
    d1Query<MemberRow>(
      env.DB,
      "SELECT id, name, name_en, yt_channel_id, active FROM members "
      + "WHERE group_key=? AND active=1 ORDER BY id",
      [TARGET],
    ),
    d1Query<InsightRow>(
      env.DB,
      `SELECT id, title, body, scope, type, source_refs_json,
              ai_comment, generated_at
         FROM insights
        WHERE (scope=? OR type='ipx_action')
          AND generated_at >= datetime('now','-7 days')
        ORDER BY generated_at DESC LIMIT 30`,
      [TARGET],
    ),
    d1Query<any>(env.DB,
      `SELECT alert_key, rule, scope, severity, title, body, fired_at
         FROM alerts
        WHERE scope=? AND fired_at >= datetime('now', '-14 days')
        ORDER BY fired_at DESC LIMIT 30`, [TARGET]),
    d1QueryOne<{ current: number; previous: number | null }>(
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
      [TARGET, TARGET, TARGET, TARGET, TARGET],
    ),
    // DECISION 탭 — 멤버배분 프록시. 최신 스냅샷의 per-member 인기 점수.
    d1Query<MemberPopularityRow>(
      env.DB,
      `SELECT member_id, composite_score, yt_score, yt_avg_views,
              yt_videos, yt_sufficient
         FROM agg_member_popularity
        WHERE group_key=? AND snapshot_at = (
          SELECT MAX(snapshot_at) FROM agg_member_popularity WHERE group_key=?)`,
      [TARGET, TARGET],
    ),
    // DECISION 탭 — 미완소년 소유자 OAuth(Analytics). 미연결이면 행 없음.
    d1QueryOne<YtAnalyticsRow>(
      env.DB,
      `SELECT snapshot_at, returning_viewers_30d, membership_count,
              membership_penetration, has_super_chat
         FROM agg_youtube_analytics
        WHERE group_key=? AND snapshot_at = (
          SELECT MAX(snapshot_at) FROM agg_youtube_analytics WHERE group_key=?)`,
      [TARGET, TARGET],
    ),
    d1Query<YtAnalyticsCountryRow>(
      env.DB,
      `SELECT country, watch_share, growth_mom, retention_rel, sub_per_1k,
              watch_minutes, organic_share, subs_gained
         FROM agg_youtube_analytics_country
        WHERE group_key=? AND snapshot_at = (
          SELECT MAX(snapshot_at) FROM agg_youtube_analytics_country
           WHERE group_key=?)
        ORDER BY watch_share DESC`,
      [TARGET, TARGET],
    ),
    // #4 굿즈 예판/위시리스트 by 국가 — 지불의향 hard signal (수동/커머스 적재).
    d1Query<{ country: string; member_id: number | null; count: number; source: string }>(
      env.DB,
      `SELECT country, member_id, SUM(count) AS count, source
         FROM goods_preorder WHERE group_key=?
        GROUP BY country, member_id, source`,
      [TARGET],
    ),
    // P2a 찐팬 활동량 — summary(헤드라인) + 방송별 추이. 둘 다 MiiWAN 만 실질
    // 데이터. 테이블 미적용 시 .catch 로 graceful(null/[]) → 카드 '축적 중'.
    d1QueryOne<LiveActivitySummaryRow>(
      env.DB,
      `SELECT generated_at, window_days, broadcast_count,
              median_unique_chatters, median_msgs_per_chatter,
              median_returning_rate, median_peak_msgs_per_min,
              core_fan_count, core_fan_share,
              est_engaged_fans, est_active_core,
              view_through, like_rate, comment_rate, basis
         FROM agg_live_activity_summary WHERE group_key=?`,
      [TARGET],
    ).catch(() => null),
    d1Query<LiveActivityBroadcastRow>(
      env.DB,
      `SELECT video_id, ended_at, unique_chatters, total_messages,
              msgs_per_chatter, peak_msgs_per_min, returning_rate, basis
         FROM agg_live_activity
        WHERE group_key=? ORDER BY ended_at ASC LIMIT 24`,
      [TARGET],
    ).catch(() => [] as LiveActivityBroadcastRow[]),
  ]);

  return jsonResponse({
    group: {
      key: group.key, name: group.name, name_kr: group.name_kr,
      debut_date: group.debut_date, yt_channel_id: group.yt_channel_id,
    },
    today: todayIso,
    days_to_debut: daysToDebut,
    summary: summary ? {
      snapshot_at: summary.snapshot_at,
      yt_total_videos: summary.yt_total_videos,
      yt_total_views: summary.yt_total_views,
      yt_subscribers: summary.yt_subscribers,
      dc_total_posts: summary.dc_total_posts,
      theqoo_posts: summary.theqoo_posts,
      instiz_posts: summary.instiz_posts,
      naver_total_news: summary.naver_total_news,
      controversy_count: summary.controversy_count,
    } : null,
    prev_summary: prevSummary ? {
      snapshot_at: prevSummary.snapshot_at,
      yt_total_videos: prevSummary.yt_total_videos,
      yt_total_views: prevSummary.yt_total_views,
      yt_subscribers: prevSummary.yt_subscribers,
      dc_total_posts: prevSummary.dc_total_posts,
      naver_total_news: prevSummary.naver_total_news,
    } : null,
    summary_history: summaryHistory,
    health_score: health ? {
      total: health.total, grade: health.grade, label: health.label,
      breakdown: (() => {
        try { return health.breakdown_json ? JSON.parse(health.breakdown_json) : {}; }
        catch { return {}; }
      })(),
    } : null,
    members: members.map((m) => ({
      id: m.id, name: m.name, name_en: m.name_en,
      has_solo_channel: Boolean(m.yt_channel_id),
    })),
    insights: insights.map((i) => ({
      id: i.id, title: i.title, body: i.body,
      scope: i.scope, type: i.type,
      source_refs: safeJson(i.source_refs_json),
      ai_comment: i.ai_comment,
      generated_at: i.generated_at,
    })),
    alerts,
    controversy_trend: controversyTrend,
    // DECISION 탭 데이터. member_popularity는 공개 프록시(지금 가동),
    // analytics는 소유자 OAuth 전용 지표 — 연결 전까지 null이라 프론트가
    // empty-state로 렌더한다. OAuth collector가 채우면 자동 점등.
    decision: {
      member_popularity: (() => {
        const nameOf = new Map(members.map((m) => [m.id, m.name]));
        return (memberPopularity ?? []).map((r) => ({
          member_id: r.member_id,
          name: nameOf.get(r.member_id) ?? `#${r.member_id}`,
          composite_score: r.composite_score,
          yt_avg_views: r.yt_avg_views,
          sufficient: Boolean(r.yt_sufficient),
        }));
      })(),
      // 미완소년 소유자 OAuth(Analytics) 적재분. 행이 없으면 null →
      // 프론트가 '연결 대기' empty-state. worker youtube-analytics 커맨드가
      // 채운다 (migration 0087 / collectors/youtube_analytics.py).
      analytics: (ytAnalytics || (ytAnalyticsCountries ?? []).length > 0)
        ? {
            snapshot_at: ytAnalytics?.snapshot_at ?? "",
            // growth_mom 은 null(직전 30일 데이터 없음 = 신규)을 보존한다 —
            // 프론트가 "성장 0%"와 "성장 데이터 없음"을 구분해야 데뷔 초기
            // 산점도가 x=0 에 무더기로 뭉치지 않는다. retention 은 1.0(국내
            // 동등) 폴백이 의미 있어 유지.
            countries: (ytAnalyticsCountries ?? []).map((c) => ({
              country: c.country,
              watch_share: c.watch_share,
              growth_mom: c.growth_mom,
              retention_rel: c.retention_rel ?? 1,
              sub_per_1k: c.sub_per_1k,
              watch_minutes: c.watch_minutes,
              organic_share: c.organic_share,
              subs_gained: c.subs_gained,
            })),
            returning_viewers_30d: ytAnalytics?.returning_viewers_30d ?? null,
            membership_count: ytAnalytics?.membership_count ?? null,
            membership_penetration: ytAnalytics?.membership_penetration ?? null,
            has_super_chat: ytAnalytics?.has_super_chat == null
              ? null : Boolean(ytAnalytics.has_super_chat),
          }
        : null,
      // #4 굿즈 예판 — 국가/멤버별 집계 (지불의향 hard signal). 비었으면 [].
      goods_preorder: (goodsPreorder ?? []).map((g) => ({
        country: g.country, member_id: g.member_id,
        count: Number(g.count ?? 0), source: g.source,
      })),
    },
    // P2a 찐팬 활동량 — measured 라이브 코어 + estimated 영상 참여. 점수 아님
    // (현황 표시). summary 행 없으면 null → 카드 '라이브 데이터 축적 중'.
    // broadcasts 는 시간순(오래된→최신), 카드가 최신-위로 reverse.
    fan_activity: liveActivitySummary
      ? { ...liveActivitySummary, broadcasts: liveActivityBroadcasts }
      : null,
  });
};
