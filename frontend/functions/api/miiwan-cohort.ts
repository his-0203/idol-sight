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
import {
  bucketIndexForAge, debutAgeDaysKST, labelForIndex,
} from "../lib/debutWindowBuckets";
import { alignByDebut } from "../lib/debutAligned";
import {
  AT_DAY_WINDOW, BASE_WINDOW, baseValueAt, growthMultiple, indexCurve, rankOf,
} from "../lib/cohortReport";

const TARGET = "miiwan";
const COHORT = ["myrakl", "owis", "bdawn", "bthd", "skinz"] as const;
const REFERENCE = ["plave"] as const;
const ALL_KEYS = [TARGET, ...COHORT, ...REFERENCE];
const METRICS = [
  "yt_subscribers", "yt_total_views", "naver_total_news", "dc_total_posts",
] as const;
// 유기성 창의 왼쪽 끝 = D-Day 버킷 (debutWindowBuckets 시퀀스 index 3).
// 오른쪽 끝은 고정이 아니라 미완이의 현재 경과일이 도달한 버킷까지 —
// 고정 D+60 창이면 미완이(D+43)는 D+60 버킷이 통째로 비는데 피어는 70일치가
// 다 차 있어 "덜 채워진 쪽 vs 다 채운 쪽"을 비교하게 된다.
const ORGANICITY_FIRST_BUCKET_INDEX = 3; // labelForIndex(3) === "D-Day"

/** 미완이 경과일이 도달한 버킷까지의 라벨 목록 + 표시용 창 라벨. */
function organicityWindow(asOfDay: number): { buckets: string[]; label: string } {
  const right = Math.max(ORGANICITY_FIRST_BUCKET_INDEX, bucketIndexForAge(asOfDay));
  const buckets: string[] = [];
  for (let i = ORGANICITY_FIRST_BUCKET_INDEX; i <= right; i++) buckets.push(labelForIndex(i));
  const first = buckets[0]!;
  const last = buckets[buckets.length - 1]!;
  return { buckets, label: first === last ? first : `${first}~${last}` };
}

interface GroupRow { key: string; name: string; debut_date: string | null }
interface SummaryRow {
  group_key: string; debut_date: string | null; snapshot_at: string;
  yt_subscribers: number | null; yt_total_views: number | null;
  naver_total_news: number | null; dc_total_posts: number | null;
  data_source: string;
}
// 헤드라인 유기성 점수는 코드베이스 표준(src/lib/organicity.ts
// headlineOrganicScore)과 동일하게 shrunk → simple 순 fallback.
// raw organic_score_mean 은 뷰 가중이라 아웃라이어 한 편에 끌려간다.
interface OrgRow {
  group_key: string;
  organic_score_mean_shrunk: number | null;
  organic_score_mean_simple: number | null;
  scored_video_count: number;
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
    // base_day/at_day = 실제로 값을 집어온 경과일. 탐색 허용폭(D0±BASE_WINDOW,
    // D+N±AT_DAY_WINDOW) 때문에 표의 "D+43 값"이 실은 D+41 스냅샷일 수 있어,
    // 어느 날 값인지 화면에 밝힌다(투자사 보고 — 측정일 숨김 금지).
    const scRows: Array<{
      group_key: string; value_at_day: number | null;
      growth_multiple: number | null; source: string | null; reference: boolean;
      base_day: number | null; at_day: number | null; base_source: string | null;
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
          base_day: null, at_day: null, base_source: null,
        });
        continue;
      }
      const curve = indexCurve(pts, asOfDay);
      if (curve) metricCurves[gk] = curve;
      else excluded.push({ group_key: gk, metric, reason: "no_d0_baseline" });
      const at = baseValueAt(pts, asOfDay, AT_DAY_WINDOW);
      const base = baseValueAt(pts, 0, BASE_WINDOW);
      scRows.push({
        group_key: gk,
        value_at_day: at?.value ?? null,
        growth_multiple: growthMultiple(pts, asOfDay),
        source: at?.source ?? null,
        reference: isRef(gk),
        base_day: base?.day ?? null,
        at_day: at?.day ?? null,
        base_source: base?.source ?? null,
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

  // 동시기 유기성 — COALESCE(shrunk, simple) 을 scored_video_count 가중 평균
  // (debut-window/summary.ts 의 헤드라인 집계와 동일 규칙).
  // 핵심 쿼리(groups·agg_summary)는 실패 시 그대로 던져 fail-fast 500 —
  // 그게 없으면 곡선·순위 자체가 조작된 값이 된다. 유기성은 보조 데이터라
  // 이 쿼리만 실패해도 나머지 응답(곡선·스코어카드)까지 죽이지 않고
  // degrade한다 — 단, "값 없음"과 "쿼리 실패"를 조용히 같은 빈 배열로
  // 위장하지 않도록 organicity_unavailable 플래그로 실패를 명시한다.
  const orgWindow = organicityWindow(asOfDay);
  const orgPh = orgWindow.buckets.map(() => "?").join(",");
  let organicityUnavailable = false;
  const orgRows = await d1Query<OrgRow>(
    env.DB,
    `SELECT group_key, organic_score_mean_shrunk, organic_score_mean_simple,
            scored_video_count
       FROM debut_window_organicity_summary
      WHERE group_key IN (${ph}) AND window_bucket IN (${orgPh})`,
    [...ALL_KEYS, ...orgWindow.buckets],
  ).catch(() => {
    organicityUnavailable = true;
    return [] as OrgRow[];
  });
  const orgAgg = new Map<string, { wsum: number; n: number }>();
  for (const r of orgRows) {
    const score = r.organic_score_mean_shrunk ?? r.organic_score_mean_simple;
    if (score == null || !r.scored_video_count) continue;
    const a = orgAgg.get(r.group_key) ?? { wsum: 0, n: 0 };
    a.wsum += score * r.scored_video_count;
    a.n += r.scored_video_count;
    orgAgg.set(r.group_key, a);
  }
  // 쿼리 자체가 실패했을 땐 그룹별 null-placeholder 행도 만들지 않는다 —
  // "데이터 없음(score:null)"과 "쿼리 실패"를 organicity 배열 모양만으로는
  // 구분할 수 없으므로, 실패는 오직 organicity_unavailable 로만 표현하고
  // organicity 자체는 빈 배열로 명확히 비운다.
  const organicity = organicityUnavailable
    ? []
    : ALL_KEYS.filter((gk) => byKey.has(gk)).map((gk) => {
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
    organicity_window: orgWindow.label,
    organicity_unavailable: organicityUnavailable,
    excluded,
  });
};
