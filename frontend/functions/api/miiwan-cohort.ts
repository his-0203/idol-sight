// frontend/functions/api/miiwan-cohort.ts
//
// 동시기(데뷔일 정렬) 코호트 성과 — 투자사 보고용 "왜 잘되는가" 근거 데이터.
// 절대값 비교가 아니라 각 그룹의 D0을 원점으로 정렬한 인덱스 성장(D0=100)·
// 성장배수·순위를 반환한다. 규칙: 가짜 수치 없음 — D0 기준값이 없는
// (그룹,지표)는 excluded로 명시하고 순위 모수에서 뺀다.
//
// plave는 성공 사례 참조선(reference) — 체급이 달라 순위에 섞으면
// 미완이 배지가 무의미해지므로 곡선·표에는 나오되 순위 모수에서 제외.
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";
import { debutAgeDaysKST } from "../lib/debutWindowBuckets";
import { alignByDebut } from "../lib/debutAligned";
import {
  AT_DAY_WINDOW, baseValueAt, growthMultiple, indexCurve, rankOf,
} from "../lib/cohortReport";

const TARGET = "miiwan";
const COHORT = ["myrakl", "owis", "bdawn", "bthd", "skinz"] as const;
const REFERENCE = ["plave"] as const;
const ALL_KEYS = [TARGET, ...COHORT, ...REFERENCE];
const METRICS = [
  "yt_subscribers", "yt_total_views", "naver_total_news", "dc_total_posts",
] as const;
// 유기성: 동시기 = D-Day(−10..9)·D+20(10..29)·D+40(30..49)·D+60(50..69) 버킷
// (debutWindowBuckets 라벨 체계) — 데뷔 직후 ~70일 창.
const ORGANICITY_BUCKETS = ["D-Day", "D+20", "D+40", "D+60"];

interface GroupRow { key: string; name: string; debut_date: string | null }
interface SummaryRow {
  group_key: string; debut_date: string | null; snapshot_at: string;
  yt_subscribers: number | null; yt_total_views: number | null;
  naver_total_news: number | null; dc_total_posts: number | null;
  data_source: string;
}
interface OrgRow {
  group_key: string; organic_score_mean: number | null; scored_video_count: number;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const ph = ALL_KEYS.map(() => "?").join(",");
  const groups = await d1Query<GroupRow>(
    env.DB,
    `SELECT key, name, debut_date FROM groups WHERE key IN (${ph})`,
    ALL_KEYS,
  );
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const miiwan = byKey.get(TARGET);
  if (!miiwan?.debut_date) {
    return jsonResponse({ error: "miiwan_debut_date_missing" }, 409);
  }
  const rawAge = debutAgeDaysKST(miiwan.debut_date, new Date());
  const asOfDay = Number.isFinite(rawAge) ? Math.max(0, rawAge) : 0;

  // 한 방 쿼리: 대상 그룹 × 4지표. 정렬 범위는 D-7(기준값 탐색 여유)~D+asOf+7.
  const from = -7;
  const to = asOfDay + AT_DAY_WINDOW;
  const rows = await d1Query<SummaryRow>(
    env.DB,
    `SELECT s.group_key, g.debut_date, s.snapshot_at,
            s.yt_subscribers, s.yt_total_views, s.naver_total_news,
            s.dc_total_posts, s.data_source
       FROM agg_summary s
       JOIN groups g ON g.key = s.group_key
      WHERE s.group_key IN (${ph})
        AND g.debut_date IS NOT NULL
        AND CAST(julianday(date(s.snapshot_at)) - julianday(g.debut_date) AS INTEGER)
            BETWEEN ? AND ?`,
    [...ALL_KEYS, from, to],
  );

  const isRef = (gk: string) => (REFERENCE as readonly string[]).includes(gk);
  const curves: Record<string, Record<string, ReturnType<typeof indexCurve>>> = {};
  const scorecard: Record<string, unknown> = {};
  const excluded: Array<{ group_key: string; metric: string; reason: string }> = [];

  for (const metric of METRICS) {
    const aligned = alignByDebut(
      rows.map((r) => ({
        group_key: r.group_key, debut_date: r.debut_date,
        snapshot_at: r.snapshot_at,
        value: r[metric], source: r.data_source,
      })),
      from, to,
    );
    const metricCurves: Record<string, NonNullable<ReturnType<typeof indexCurve>>> = {};
    const scRows: Array<{
      group_key: string; value_at_day: number | null;
      growth_multiple: number | null; source: string | null; reference: boolean;
    }> = [];
    for (const gk of ALL_KEYS) {
      const pts = aligned[gk];
      const g = byKey.get(gk);
      if (!pts || !g?.debut_date) {
        excluded.push({ group_key: gk, metric, reason: "no_data_in_window" });
        // 데이터가 없어도 코호트 구성원(특히 reference)은 스코어카드 행에
        // null로나마 남긴다 — 프론트가 "이 그룹은 코호트에 있으나 데이터
        // 없음"을 표시할 수 있어야 하고, plave 같은 reference가 통째로
        // 행에서 사라지면 안 된다.
        scRows.push({
          group_key: gk, value_at_day: null, growth_multiple: null,
          source: null, reference: isRef(gk),
        });
        continue;
      }
      const curve = indexCurve(pts, asOfDay);
      if (curve) metricCurves[gk] = curve;
      else excluded.push({ group_key: gk, metric, reason: "no_d0_baseline" });
      const at = baseValueAt(pts, asOfDay, AT_DAY_WINDOW);
      scRows.push({
        group_key: gk,
        value_at_day: at?.value ?? null,
        growth_multiple: growthMultiple(pts, asOfDay),
        source: at?.source ?? null,
        reference: isRef(gk),
      });
    }
    const mine = scRows.find((r) => r.group_key === TARGET)?.growth_multiple ?? null;
    const peers = scRows.filter(
      (r) => r.group_key !== TARGET && !r.reference && r.growth_multiple != null,
    ).map((r) => r.growth_multiple!);
    scorecard[metric] = {
      rows: scRows,
      miiwan_rank: mine == null ? null : rankOf(mine, peers),
      cohort_size: mine == null ? peers.length : peers.length + 1,
    };
    curves[metric] = metricCurves as never;
  }

  // 동시기 유기성 — scored_video_count 가중 평균.
  const orgPh = ORGANICITY_BUCKETS.map(() => "?").join(",");
  const orgRows = await d1Query<OrgRow>(
    env.DB,
    `SELECT group_key, organic_score_mean, scored_video_count
       FROM debut_window_organicity_summary
      WHERE group_key IN (${ph}) AND window_bucket IN (${orgPh})`,
    [...ALL_KEYS, ...ORGANICITY_BUCKETS],
  ).catch(() => [] as OrgRow[]);
  const orgAgg = new Map<string, { wsum: number; n: number }>();
  for (const r of orgRows) {
    if (r.organic_score_mean == null || !r.scored_video_count) continue;
    const a = orgAgg.get(r.group_key) ?? { wsum: 0, n: 0 };
    a.wsum += r.organic_score_mean * r.scored_video_count;
    a.n += r.scored_video_count;
    orgAgg.set(r.group_key, a);
  }
  const organicity = ALL_KEYS.filter((gk) => byKey.has(gk)).map((gk) => {
    const a = orgAgg.get(gk);
    return {
      group_key: gk,
      score: a && a.n > 0 ? Math.round((a.wsum / a.n) * 10) / 10 : null,
      video_count: a?.n ?? 0,
      reference: isRef(gk),
    };
  });

  const groupsOut: Record<string, { name: string; debut_date: string | null; reference: boolean }> = {};
  for (const g of groups) {
    groupsOut[g.key] = { name: g.name, debut_date: g.debut_date, reference: isRef(g.key) };
  }

  return jsonResponse({
    as_of_day: asOfDay,
    metrics: [...METRICS],
    groups: groupsOut,
    curves,
    scorecard,
    organicity,
    excluded,
  });
};
