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
//   5. D-30 benchmark — for each comparison group (plave/isedol/stellive
//      already debuted), the last agg_summary row whose snapshot_at fell
//      within the 30 days BEFORE that group's debut_date. This is what
//      lets the UI say "MiiWAN D-26 SNS = +12% vs PLAVE D-26".
//
// We bias toward returning partials. If a section has no data the
// frontend renders an empty-state card rather than failing the page.

import { d1Query, d1QueryOne, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

const TARGET = "miiwan";

// Benchmark cohort = K-POP corporate newcomer groups (corporate
// model). ISEDOL/STELLIVE dropped — different group_model
// (segmentary/confederation 서브컬처) and different KPI weighting
// structure, so a flat D-30 comparison against them implies an
// apples-to-apples relationship that doesn't hold.
//
// PLAVE re-added (2026-05) — historical backfill via Wayback Machine
// (migrations 0018 + 0020) now covers yt_subscribers / yt_total_videos
// / yt_total_views around its 2023-03 debut window, so D-30 is no
// longer silently NULL on the PLAVE side.
//
// WEGOSIX (2026-05) — pre-debut peer (debut_date NULL in 0034 seed).
// Doesn't fit the literal "D-30 이전 스냅샷" framing, but since it's
// the only other tracked corporate-model pre-debut group it gives the
// strategy team a parallel "right-now" reading. Handled separately
// below: when debut_date is null we pick the latest agg_summary
// instead of an anchored window.
const BENCHMARK_GROUPS = ["plave", "skinz", "myrakl", "owis", "bdawn", "wegosix"] as const;

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
  naver_total_news: number; twitter_posts: number; controversy_count: number;
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

  // 2) Latest summary + health for MiiWAN
  const summary = await d1QueryOne<SummaryRow>(
    env.DB,
    `SELECT * FROM agg_summary
      WHERE group_key=? AND snapshot_at = (
        SELECT MAX(snapshot_at) FROM agg_summary WHERE group_key=?)`,
    [TARGET, TARGET],
  );
  const prevSummary = await d1QueryOne<SummaryRow>(
    env.DB,
    `SELECT * FROM agg_summary
      WHERE group_key=? AND snapshot_at <= datetime('now', '-7 days')
      ORDER BY snapshot_at DESC LIMIT 1`,
    [TARGET],
  );
  const summaryHistory = await d1Query<any>(
    env.DB,
    `SELECT snapshot_at, yt_total_views, yt_subscribers, yt_total_videos,
            dc_total_posts, naver_total_news, twitter_posts
       FROM agg_summary
      WHERE group_key=? AND snapshot_at >= datetime('now', '-30 days')
      ORDER BY snapshot_at ASC LIMIT 64`,
    [TARGET],
  );
  const health = await d1QueryOne<HealthRow>(
    env.DB,
    `SELECT * FROM agg_health_scores
      WHERE group_key=? AND snapshot_at = (
        SELECT MAX(snapshot_at) FROM agg_health_scores WHERE group_key=?)`,
    [TARGET, TARGET],
  );

  // 3) Members roster
  const members = await d1Query<MemberRow>(
    env.DB,
    "SELECT id, name, name_en, yt_channel_id, active FROM members "
    + "WHERE group_key=? AND active=1 ORDER BY id",
    [TARGET],
  );

  // 4) MiiWAN-scoped insights. We pick anything explicitly scoped to
  //    MiiWAN, plus the latest 5 ipx_actions (those are recommended-
  //    actions that the strategy team should see even when Gemini
  //    didn't pick MiiWAN as the scope literal).
  // 7-day window: stale ipx_actions / market insights from prior cycles
  // pile up if we don't bound the read. analyze-weekly runs Monday 09:00
  // KST (00:00 UTC) so a 7-day cutoff always covers exactly one fresh
  // cycle plus a small carry-over window for late-day reads. Matches
  // operator mental model: "이번 주 권고만 보여줘."
  const insights = await d1Query<InsightRow>(
    env.DB,
    `SELECT id, title, body, scope, type, source_refs_json,
            ai_comment, generated_at
       FROM insights
      WHERE (scope=? OR type='ipx_action')
        AND generated_at >= datetime('now','-7 days')
      ORDER BY generated_at DESC LIMIT 30`,
    [TARGET],
  );

  // Worker-emitted alerts scoped to MiiWAN. The strategic-analyst
  // briefing surfaces these in a Risk Watch section instead of making
  // the operator hop to PR/Risk and re-establish MiiWAN context.
  const alerts = await d1Query<any>(env.DB,
    `SELECT alert_key, rule, scope, severity, title, body, fired_at
       FROM alerts
      WHERE scope=? AND fired_at >= datetime('now', '-14 days')
      ORDER BY fired_at DESC LIMIT 30`, [TARGET]);

  // Controversy WoW trend — mirrors PRRisk's logic so the briefing
  // can render an in-context risk badge without leaving the page.
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
    [TARGET, TARGET, TARGET, TARGET, TARGET],
  );

  // 5) D-30 benchmark for comparison groups. We pick the agg_summary
  //    snapshot whose snapshot_at falls in the [debut-30d, debut-1d]
  //    window — i.e. the last reading we have before debut. If no row
  //    falls in that window (we may not have been collecting that far
  //    back), we fall back to the closest snapshot before debut_date.
  const benchmarks: Array<{
    group_key: string; name: string; debut_date: string | null;
    snapshot_at: string | null;
    data_source: string | null;
    summary: Omit<SummaryRow, "group_key" | "snapshot_at"> | null;
  }> = [];

  for (const gk of BENCHMARK_GROUPS) {
    const g = await d1QueryOne<GroupRow>(
      env.DB,
      "SELECT key, name, name_kr, debut_date, yt_channel_id FROM groups WHERE key=?",
      [gk],
    );
    if (!g) continue;
    // Two query shapes:
    //   (a) debuted group → closest agg_summary snapshot to D-30 in the
    //       pre-debut window. Sparse backfill, so we tiebreak by column
    //       fill rate before D-30 proximity.
    //   (b) pre-debut peer (debut_date NULL, e.g. WEGOSIX) → latest
    //       agg_summary. Refreshed daily by collect-daily, so the
    //       column tracks the peer's current state without any cron.
    let row: SummaryRow | null;
    if (g.debut_date) {
      row = await d1QueryOne<SummaryRow>(
        env.DB,
        // ORDER 우선순위:
        //   1) yt_subscribers IS NOT NULL — pre-debut 표에서 가장 가치
        //      높은 단일 메트릭. PLAVE 처럼 D-30 윈도에 views/videos 만
        //      백필되고 subs 가 NULL 인 행이 살아있으면 사용자에겐
        //      benchmark 가 의미 잃음. subs 살아있는 행을 무조건 우선.
        //   2) 나머지 컬럼 충실도 (videos / views / news>0)
        //   3) D-30 시점 근접도 (window 안에서 가장 D-30 에 가까운 행)
        //   4) snapshot_at 최신
        `SELECT * FROM agg_summary
          WHERE group_key=? AND date(snapshot_at) <= date(?)
          ORDER BY
            (yt_subscribers IS NOT NULL) DESC,
            (
              (yt_total_videos  IS NOT NULL) +
              (yt_total_views   IS NOT NULL) +
              (CASE WHEN naver_total_news > 0 THEN 1 ELSE 0 END)
            ) DESC,
            ABS(julianday(date(snapshot_at)) - julianday(date(?, '-30 days'))) ASC,
            snapshot_at DESC
          LIMIT 1`,
        [gk, g.debut_date, g.debut_date],
      );
    } else {
      row = await d1QueryOne<SummaryRow>(
        env.DB,
        `SELECT * FROM agg_summary
          WHERE group_key=? AND snapshot_at = (
            SELECT MAX(snapshot_at) FROM agg_summary WHERE group_key=?)`,
        [gk, gk],
      );
    }
    benchmarks.push({
      group_key: gk,
      name: g.name,
      debut_date: g.debut_date,
      snapshot_at: row?.snapshot_at ?? null,
      data_source: row?.data_source ?? null,
      summary: row ? {
        yt_total_videos: row.yt_total_videos,
        yt_total_views: row.yt_total_views,
        yt_subscribers: row.yt_subscribers,
        dc_total_posts: row.dc_total_posts,
        theqoo_posts: row.theqoo_posts,
        instiz_posts: row.instiz_posts,
        naver_total_news: row.naver_total_news,
        twitter_posts: row.twitter_posts,
        controversy_count: row.controversy_count,
        data_source: row.data_source,
      } : null,
    });
  }

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
      twitter_posts: summary.twitter_posts,
      controversy_count: summary.controversy_count,
    } : null,
    prev_summary: prevSummary ? {
      snapshot_at: prevSummary.snapshot_at,
      yt_total_videos: prevSummary.yt_total_videos,
      yt_total_views: prevSummary.yt_total_views,
      yt_subscribers: prevSummary.yt_subscribers,
      dc_total_posts: prevSummary.dc_total_posts,
      naver_total_news: prevSummary.naver_total_news,
      twitter_posts: prevSummary.twitter_posts,
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
    benchmarks,
    alerts,
    controversy_trend: controversyTrend,
  });
};
