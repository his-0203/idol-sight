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
//
// V2.22.1 (2026-05-14): order rewritten from arbitrary insertion order
// (plave/skinz/myrakl/owis/bdawn/wegosix) to a 도장깨기 / "next wall to
// break" sequence — left-to-right is monotone-ascending in MiiWAN's
// effective gap to each comparison group, so the briefing reads as a
// ladder MiiWAN climbs through.
//
// Distance metric: yt_subscribers is the primary signal, yt_total_views
// is the tiebreaker (captures "tier-1 K-pop" weight that subs alone miss
// when a 1군 group has heavy view accumulation per subscriber).
//
// Prod D1 verified 2026-05-14 (snapshot at the closest non-NULL D-30 row
// per group). MiiWAN current baseline = 1.06K subs / 412K views / 81 vid.
//
//                   D-30 subs    D-30 views   data_source
//   1. MY:RAKL      n/a (—)      n/a          (SB archive backfill confirmed
//                                              channel did not exist before
//                                              2026-02-04 = D+9. Migration
//                                              0056 added 100 daily rows
//                                              2026-02-04~2026-05-14 but
//                                              D-30 (2025-12-27) is pre-
//                                              channel — '—' is the correct
//                                              cell value, not 0)
//   2. B:DAWN        3,290         593K       backfill_estimate
//   3. OWIS          4,120         603K       backfill_estimate
//   4. WEGO-6       11,800          27K       backfill_estimate
//   5. SKINZ        27,100         965K       backfill_estimate
//   6. PLAVE        10,000        21.2M       backfill_estimate
//
// PLAVE / SKINZ swap rationale: by subs alone PLAVE (10K) < SKINZ (27K),
// but PLAVE's D-30 views (21.2M) is 22× SKINZ's (965K) — the 1군 K-pop
// signal is in cumulative views, not subs. Keeping PLAVE in the rightmost
// (final wall) slot matches operator intuition. Note the PLAVE D-30 row
// is Wayback-anchored (sparse) while SKINZ is SB Premium (dense) — the
// raw subs comparison may be partly an artifact of backfill source
// asymmetry, not a true ranking inversion.
//
// WEGO-6 is a pre-debut peer (debut_date NULL in 0034 seed). It joins
// the ladder at slot 4 because its latest snapshot's subs (~11.8K) sits
// between OWIS and SKINZ on the subs axis; the picker shows latest for
// every anchor tab regardless of D-30 / D-DAY / D+30 selection.
const BENCHMARK_GROUPS = [
  "myrakl", "bdawn", "owis", "wegosix", "skinz", "plave",
] as const;

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
    goodsPreorder,
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
              dc_total_posts, naver_total_news, twitter_posts
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
              watch_minutes, organic_share
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
  ]);

  // 5) Cohort benchmarks anchored at seven points in the debut timeline:
  //    D-30 / D-20 / D-10 (approach), D-DAY (debut), D+10 / D+20 / D+30
  //    (early growth). Each tab in the briefing shows the same comparison
  //    groups but anchored at that point in their own debut window — gives
  //    the strategy team a target trajectory ("MiiWAN 현재 vs PLAVE D-20 /
  //    D-Day / D+10").
  //
  //    V2.22 (2026-05-14): split the prior 3-anchor layout (D-30/D-DAY/D+30)
  //    into 7 anchors aligned with the Posture bar buckets. Each non-D-DAY
  //    anchor still uses a monotone pre/post window, so under sparse
  //    backfill the same snapshot row can resolve into multiple adjacent
  //    anchor tabs — that's expected (the picker shows "the closest row to
  //    this anchor on the correct side of debut", not a strict bucket).
  //
  //    Pre-debut peers (debut_date NULL, e.g. WEGOSIX) ignore the anchor
  //    and always show their latest agg_summary — there is no D-DAY for
  //    a group without a debut date.
  type AnchorKey =
    | "d-30" | "d-20" | "d-10"
    | "d-day"
    | "d+10" | "d+20" | "d+30";
  const ANCHORS: AnchorKey[] = [
    "d-30", "d-20", "d-10", "d-day", "d+10", "d+20", "d+30",
  ];
  type BenchmarkRow = {
    group_key: string; name: string; debut_date: string | null;
    snapshot_at: string | null;
    data_source: string | null;
    summary: Omit<SummaryRow, "group_key" | "snapshot_at"> | null;
  };
  const benchmarksByAnchor: Record<AnchorKey, BenchmarkRow[]> = {
    "d-30": [], "d-20": [], "d-10": [],
    "d-day": [],
    "d+10": [], "d+20": [], "d+30": [],
  };

  // Per-anchor SQL window + target offset. Pre-debut anchors clamp to
  // date(snapshot_at) <= debut_date; post-debut clamp the other way; D-DAY
  // uses a symmetric ±14d window so a sparse week around debut doesn't
  // accidentally pull in a far-side row that the column header would
  // mislabel. Target offset picks the closest row inside the window. The
  // fill-rate tiebreak from the original D-30 query is preserved across
  // all anchors.
  function anchorQuery(anchor: AnchorKey): { where: string; targetOffset: string } {
    if (anchor === "d-day") {
      return {
        where: "date(snapshot_at) BETWEEN date(?, '-14 days') AND date(?, '+14 days')",
        targetOffset: "+0 days",
      };
    }
    const isPre = anchor.startsWith("d-");
    const offsetDays = parseInt(anchor.slice(2), 10);  // 30 / 20 / 10
    return {
      where: isPre
        ? "date(snapshot_at) <= date(?)"
        : "date(snapshot_at) >= date(?)",
      targetOffset: `${isPre ? "-" : "+"}${offsetDays} days`,
    };
  }

  // Fetch all benchmark groups in ONE query (was one lookup per group).
  const benchPlaceholders = BENCHMARK_GROUPS.map(() => "?").join(",");
  const benchGroups = await d1Query<GroupRow>(
    env.DB,
    `SELECT key, name, name_kr, debut_date, yt_channel_id FROM groups
      WHERE key IN (${benchPlaceholders})`,
    [...BENCHMARK_GROUPS],
  );
  const benchByKey = new Map(benchGroups.map((g) => [g.key, g]));

  // Build every anchor-row query up front and run them concurrently. This was
  // 7 groups × (1 group lookup + 7 anchor queries) = ~56 SERIAL round-trips per
  // briefing load; now it's one groups query + a single concurrent batch.
  // A pre-debut peer (no debut_date) reuses ONE "latest snapshot" query across
  // all its anchor tabs — its current state is the only meaningful comparison.
  type AnchorTask = {
    gk: string; anchor: AnchorKey; g: GroupRow; row: Promise<SummaryRow | null>;
  };
  const anchorTasks: AnchorTask[] = [];
  for (const gk of BENCHMARK_GROUPS) {
    const g = benchByKey.get(gk);
    if (!g) continue;
    if (!g.debut_date) {
      const row = d1QueryOne<SummaryRow>(
        env.DB,
        `SELECT * FROM agg_summary
          WHERE group_key=? AND snapshot_at = (
            SELECT MAX(snapshot_at) FROM agg_summary WHERE group_key=?)`,
        [gk, gk],
      );
      for (const anchor of ANCHORS) anchorTasks.push({ gk, anchor, g, row });
      continue;
    }
    for (const anchor of ANCHORS) {
      const { where, targetOffset } = anchorQuery(anchor);
      // ORDER 우선순위: 1) yt_subscribers IS NOT NULL (sparse 백필에서도 subs
      // 살아있는 행 우선) 2) 나머지 컬럼 충실도 3) anchor 근접도 4) 최신.
      const params: unknown[] = anchor === "d-day"
        ? [gk, g.debut_date, g.debut_date, g.debut_date]
        : [gk, g.debut_date, g.debut_date];
      const row = d1QueryOne<SummaryRow>(
        env.DB,
        `SELECT * FROM agg_summary
          WHERE group_key=? AND ${where}
          ORDER BY
            (yt_subscribers IS NOT NULL) DESC,
            (
              (yt_total_videos  IS NOT NULL) +
              (yt_total_views   IS NOT NULL) +
              (CASE WHEN naver_total_news > 0 THEN 1 ELSE 0 END)
            ) DESC,
            ABS(julianday(date(snapshot_at)) - julianday(date(?, '${targetOffset}'))) ASC,
            snapshot_at DESC
          LIMIT 1`,
        params,
      );
      anchorTasks.push({ gk, anchor, g, row });
    }
  }

  await Promise.all(anchorTasks.map((t) => t.row));
  for (const t of anchorTasks) {
    const row = await t.row;
    benchmarksByAnchor[t.anchor].push({
      group_key: t.gk,
      name: t.g.name,
      debut_date: t.g.debut_date,
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
    benchmarks_by_anchor: benchmarksByAnchor,
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
  });
};
