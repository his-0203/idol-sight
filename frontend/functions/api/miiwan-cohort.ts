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
  AT_DAY_WINDOW, BASE_WINDOW, PRE_BASE_WINDOW, PRE_DEBUT_DAYS, baseValueAt,
  growthMultiple, indexCurve, measuredOnly, preAnchor, preMultiple, rankOf,
  subsPer1kViews, totalMultiple, type CurvePoint,
} from "../lib/cohortReport";
import type { AlignedValue } from "../lib/debutAligned";

const TARGET = "miiwan";
const COHORT = ["myrakl", "owis", "bdawn", "bthd", "skinz"] as const;
const REFERENCE = ["plave"] as const;
const ALL_KEYS = [TARGET, ...COHORT, ...REFERENCE];
// 지표는 "데뷔일 대비 얼마나 늘었나"를 성장배수로 말할 수 있는 것만 둔다.
// 뺀 것 (둘 다 이 화면 한정 — 다른 화면의 같은 지표는 그대로 쓴다):
//  · dc_total_posts — 갤러리 개설 시점이 그룹마다 달라 D-Day 기준값이 성장의
//    출발선이 아니라 "갤러리가 언제 열렸나"를 재는 값이 된다.
//  · naver_total_news — live 수집은 누적 건수인데 백필 행은 그 주의 기간
//    건수라 단위가 섞여 있다. 누적÷기간으로 낸 배수는 성장이 아니라 두
//    수집 방식의 차이를 재는 값이라 동시기 비교가 성립하지 않는다.
const METRICS = ["yt_subscribers", "yt_total_views"] as const;
// 유기성 창의 왼쪽 끝 = 곡선이 그리는 데뷔 전 구간(D-PRE_DEBUT_DAYS)을 덮는
// 버킷. 종전에는 D-Day 버킷(index 3)에서 잘랐는데, 실측 확인 결과 유료
// 캠페인은 데뷔 전 1~3주에 몰려 있었다 — D-Day 부터 세면 광고가 실제로
// 집행된 구간이 통째로 집계 밖으로 빠져 점수가 실제보다 깨끗하게 나온다.
// 시퀀스 index 0(D-60)까지 내리지 않는 이유는 곡선·표가 보는 구간(D-30~)과
// 창을 맞추기 위해서다 — 화면마다 다른 창을 쓰면 숫자끼리 대조가 안 된다.
// (이 화면 한정. 워커·다른 유기성 화면의 창은 건드리지 않는다.)
const ORGANICITY_FIRST_BUCKET_INDEX = bucketIndexForAge(-PRE_DEBUT_DAYS);

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
interface ScorecardRow {
  group_key: string;
  value_at_day: number | null;
  /** 데뷔 후 배수 (데뷔일 → D+asOf). */
  growth_multiple: number | null;
  /** 데뷔 전 배수 (D-PRE_DEBUT_DAYS → 데뷔일). */
  pre_multiple: number | null;
  source: string | null;
  reference: boolean;
  base_day: number | null;
  base_value: number | null;
  at_day: number | null;
  base_source: string | null;
  /** 조회수 1,000회당 늘어난 구독자 — 데뷔 전 / 데뷔 후 구간. */
  subs_per_1k_pre: number | null;
  subs_per_1k_post: number | null;
  /** 데뷔 전 앵커 값 (D-30±7 우선, 없으면 데뷔 전 최초 확보 값). 표의 "데뷔 전 값" 컬럼. */
  pre_value: number | null;
  pre_day: number | null;
  pre_source: string | null;
  /** 총 성장배수 = D+N ÷ 데뷔 전 앵커 (앵커 없으면 데뷔일 기준 — anchor_day 로 공시). */
  total_multiple: number | null;
  total_anchor_day: number | null;
  total_anchor_source: string | null;
}
interface SummaryRow {
  group_key: string; debut_date: string | null; snapshot_at: string;
  yt_subscribers: number | null; yt_total_views: number | null;
  data_source: string;
}
// 헤드라인 유기성 점수는 코드베이스 표준(src/lib/organicity.ts
// headlineOrganicScore)과 동일하게 shrunk → simple 순 fallback.
// raw organic_score_mean 은 뷰 가중이라 아웃라이어 한 편에 끌려간다.
// organic_score_mean 은 버킷 안에서 이미 뷰 가중 평균이라 별도로 병기한다
// (편수 기준 점수와 크게 벌어지면 조회수가 소수의 영상에 쏠려 있다는 신호).
interface OrgRow {
  group_key: string;
  organic_score_mean_shrunk: number | null;
  organic_score_mean_simple: number | null;
  organic_score_mean: number | null;
  total_views: number | null;
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

  // 한 방 쿼리: 대상 그룹 × METRICS. 정렬 범위는 곡선이 그리는 데뷔 전
  // 구간(D-PRE_DEBUT_DAYS)부터 D+asOf+7 까지 — 손으로 적은 D-7 을 쓰면
  // 상수를 늘렸을 때 곡선만 넓어지고 데이터는 안 따라와 조용히 잘린다.
  // date(snapshot_at, '+9 hours') — debut_date 가 KST 달력 날짜이고 정확한
  // 버킷팅(alignByDebut)도 KST 기준이라 프리필터도 같은 달력을 써야 한다.
  const from = -PRE_DEBUT_DAYS;
  const to = asOfDay + AT_DAY_WINDOW;
  const rows = await d1Query<SummaryRow>(
    env.DB,
    `SELECT s.group_key, g.debut_date, s.snapshot_at,
            s.yt_subscribers, s.yt_total_views,
            s.data_source
       FROM agg_summary s
       JOIN groups g ON g.key = s.group_key
      WHERE s.group_key IN (${ph})
        AND g.debut_date IS NOT NULL
        AND CAST(julianday(date(s.snapshot_at, '+9 hours')) - julianday(g.debut_date) AS INTEGER)
            BETWEEN ? AND ?`,
    [...ALL_KEYS, from, to],
  );

  const isRef = (gk: string) => (REFERENCE as readonly string[]).includes(gk);
  const curves: Record<string, Record<string, CurvePoint[]>> = {};
  const scorecard: Record<string, {
    rows: ScorecardRow[]; miiwan_rank: number | null; cohort_size: number;
  }> = {};
  const excluded: Array<{ group_key: string; metric: string; reason: string }> = [];

  // 지표별 정렬 결과를 남겨둔다 — 구독 획득 효율은 구독자와 조회수를 **같은
  // 날짜 쌍**에서 집어야 해서 두 지표의 점 목록이 동시에 필요하다.
  const alignedByMetric: Record<string, Record<string, Map<number, AlignedValue>>> = {};

  for (const metric of METRICS) {
    const aligned = alignByDebut(
      rows.map((r) => ({
        group_key: r.group_key, debut_date: r.debut_date,
        snapshot_at: r.snapshot_at,
        value: r[metric], source: r.data_source,
      })),
      from, to,
    );
    alignedByMetric[metric] = aligned;
    const metricCurves: Record<string, CurvePoint[]> = {};
    // base_day/at_day = 실제로 값을 집어온 경과일. 탐색 허용폭(D0±BASE_WINDOW,
    // D+N±AT_DAY_WINDOW) 때문에 표의 "D+43 값"이 실은 D+41 스냅샷일 수 있어,
    // 어느 날 값인지 화면에 밝힌다(투자사 보고 — 측정일 숨김 금지).
    //
    // base_value = 성장배수의 분모(= 출발선). 지금까지 분모를 응답에 싣지
    // 않아 화면이 "왜 저 팀 배수가 크고 우리는 작은가"에 답할 수 없었다 —
    // 배수는 출발선이 작을수록 구조적으로 커지므로(1천→2천 = 2.0× 이지만
    // 30만→32만 = 1.1×), 분모를 같이 보여주지 않으면 순위가 규모 차이를
    // 성과 차이로 위장한다.
    //
    // pre_multiple = 데뷔 전 배수(D-PRE_DEBUT_DAYS → 데뷔일). growth_multiple 은
    // 이제 "데뷔 후" 배수로 읽는다 — 둘을 나눠 보면 출발선이 데뷔 전에 쌓인
    // 것인지 데뷔 직전 단기간에 채워진 것인지 구분된다.
    const scRows: ScorecardRow[] = [];
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
          pre_multiple: null, source: null, reference: isRef(gk),
          base_day: null, base_value: null, at_day: null, base_source: null,
          subs_per_1k_pre: null, subs_per_1k_post: null,
          pre_value: null, pre_day: null, pre_source: null,
          total_multiple: null, total_anchor_day: null, total_anchor_source: null,
        });
        continue;
      }
      // 곡선은 실측 점(live · backfill_exact)만 잇는다 — 추정 보간값은 앵커가
      // 없는 구간에서 실제로 없던 급등·출렁임을 그려낸다. 기준값(=100) 탐색도
      // 같은 실측 집합에서 하므로, 실측 기준값이 없으면 곡선만 빠지고 표의
      // 배수는(전체 소스 기준이라) 남을 수 있다 — 이 비대칭은 화면 각주가 밝힌다.
      const curvePts = measuredOnly(pts);
      const { curve, reason: curveReason } = indexCurve(curvePts, asOfDay);
      if (curve) metricCurves[gk] = curve;
      const at = baseValueAt(pts, asOfDay, AT_DAY_WINDOW);
      const base = baseValueAt(pts, 0, BASE_WINDOW);
      const growth = growthMultiple(pts, asOfDay);
      // (그룹,지표)당 excluded 는 정확히 최대 1건. 곡선 실패와 배수 실패를
      // 따로 push 하면 같은 항목이 두 줄 나오고, 더 나쁘게는 "곡선만 빠지고
      // 표의 배수는 남는다"는 곡선-side 문구가 배수도 없는 행에 붙어 거짓이
      // 된다(D0 근방에 추정값만 있고 D+N 값이 아예 없는 조합). 우선순위:
      //   ① 배수 자체를 못 냄 → 그 원인(기준값 없음 / 도달값 없음)
      //   ② 배수는 있는데 곡선만 실패 → 곡선 사유
      // ②의 문구만이 "표의 배수는 남는다"를 항상 참으로 만든다.
      if (growth == null) {
        excluded.push({
          group_key: gk,
          metric,
          // base.value <= 0 이면 growthMultiple 이 기준값을 못 쓴 것이라
          // 도달값 유무와 무관하게 기준값 문제로 분류한다.
          reason: base && base.value > 0 ? "no_at_day_value" : "no_d0_baseline",
        });
      } else if (!curve) {
        // 여기 오면 배수는 살아 있다 — 실측 기준값만 없는 경우는 "기준값
        // 자체가 없음"과 대응이 달라 별도 사유로 구분한다.
        excluded.push({
          group_key: gk,
          metric,
          reason: curveReason === "no_d0_baseline"
            ? "no_measured_d0_baseline"
            : curveReason,
        });
      }
      const anchor = preAnchor(pts);
      const total = totalMultiple(pts, asOfDay);
      scRows.push({
        group_key: gk,
        value_at_day: at?.value ?? null,
        growth_multiple: growth,
        pre_multiple: preMultiple(pts),
        source: at?.source ?? null,
        reference: isRef(gk),
        base_day: base?.day ?? null,
        base_value: base?.value ?? null,
        at_day: at?.day ?? null,
        base_source: base?.source ?? null,
        // 구독 효율은 구독자·조회수를 함께 봐야 해서 두 지표가 다 정렬된
        // 뒤에 채운다(아래 별도 패스).
        subs_per_1k_pre: null,
        subs_per_1k_post: null,
        pre_value: anchor?.value ?? null,
        pre_day: anchor?.day ?? null,
        pre_source: anchor?.source ?? null,
        total_multiple: total?.multiple ?? null,
        total_anchor_day: total?.anchor_day ?? null,
        total_anchor_source: total?.anchor_source ?? null,
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
    curves[metric] = metricCurves;
  }

  // 구독 획득 효율 — 두 지표가 다 정렬된 뒤에야 계산할 수 있어 별도 패스.
  // 조회수는 거의 안 늘었는데 구독자만 뛰면 값이 크게 튄다(영상 노출 없이
  // 구독이 붙었다는 뜻). 실측 점만 쓰고, 구독자·조회수가 **같은 날** 다 있는
  // 날짜에서만 양 끝을 집는다 — 구간이 어긋나면 비율 자체가 무의미해진다.
  // 화면에는 수치만 싣고 임계선·판정 플래그는 두지 않는다: 해석은 캡션이
  // 설명하고 판단은 읽는 사람 몫이다.
  const subsAligned = alignedByMetric["yt_subscribers"] ?? {};
  const viewsAligned = alignedByMetric["yt_total_views"] ?? {};
  for (const [, card] of Object.entries(scorecard)) {
    for (const row of card.rows) {
      const s = subsAligned[row.group_key];
      const v = viewsAligned[row.group_key];
      if (!s || !v) continue;
      const sm = measuredOnly(s);
      const vm = measuredOnly(v);
      row.subs_per_1k_pre = subsPer1kViews(
        sm, vm, -PRE_DEBUT_DAYS, PRE_BASE_WINDOW, 0, BASE_WINDOW,
      );
      row.subs_per_1k_post = subsPer1kViews(
        sm, vm, 0, BASE_WINDOW, asOfDay, AT_DAY_WINDOW,
      );
    }
  }

  // 동시기 유기성 — 그룹 수준 규칙은 organicity.ts 의 headlineOrganicScore
  // (버킷당 shrunk ?? simple 택일)와 동일하게, 행별 COALESCE(shrunk, simple)를
  // scored_video_count 가중 평균한다. summary.ts 의 SUM 들은 canonical 이 아니다
  // — 거긴 PK(group_key, window_bucket) 단일 행 위에서 도는 no-op 이라
  // "가중치 규칙"을 정의하지 않는다. 워커(debut_window.py)는 shrunk 가 null이면
  // simple 도 null로 쓰기 때문에 "shrunk null · simple 존재" 행은 실무에서
  // 나오지 않는다 — 아래 COALESCE 는 pre-0092 잔재를 향한 방어일 뿐, 별도의
  // 폴백 가중치 분기는 두지 않는다.
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
            organic_score_mean, total_views, scored_video_count
       FROM debut_window_organicity_summary
      WHERE group_key IN (${ph}) AND window_bucket IN (${orgPh})`,
    [...ALL_KEYS, ...orgWindow.buckets],
  ).catch(() => {
    organicityUnavailable = true;
    return [] as OrgRow[];
  });
  // 영상 단위 유료 판정 제외 집계 — "조회수 점수가 낮은 이유가 소수 집행
  // 콘텐츠 쏠림인가"를 한눈에 보여주기 위한 보조 층. 판정(min)·배지는
  // 이 수치와 무관하게 유지된다(동어반복 방지: 화면은 반드시 쏠림 규모와
  // 함께 표기). 창은 summary 쿼리와 같은 버킷 — 화면마다 창이 다르면
  // 숫자끼리 대조가 안 된다.
  interface ExPaidRow {
    group_key: string; n: number; views: number | null;
    paid_n: number; paid_views: number | null;
    ex_wsum: number | null; ex_views: number | null;
  }
  const exPaidRows = await d1Query<ExPaidRow>(
    env.DB,
    `SELECT group_key,
            COUNT(*) AS n,
            SUM(view_count) AS views,
            SUM(CASE WHEN verdict = 'likely_paid' THEN 1 ELSE 0 END) AS paid_n,
            SUM(CASE WHEN verdict = 'likely_paid' THEN view_count ELSE 0 END) AS paid_views,
            SUM(CASE WHEN verdict != 'likely_paid' THEN organic_score * view_count ELSE 0 END) AS ex_wsum,
            SUM(CASE WHEN verdict != 'likely_paid' THEN view_count ELSE 0 END) AS ex_views
       FROM debut_window_video_organicity
      WHERE group_key IN (${ph}) AND window_bucket IN (${orgPh})
        AND organic_score IS NOT NULL AND view_count IS NOT NULL
      GROUP BY group_key`,
    [...ALL_KEYS, ...orgWindow.buckets],
  ).catch(() => [] as ExPaidRow[]);
  const exPaidBy = new Map(exPaidRows.map((r) => [r.group_key, r]));

  const orgAgg = new Map<string, { wsum: number; n: number }>();
  // 뷰 가중 집계: organic_score_mean 은 **버킷 안에서 이미 뷰 가중 평균**이라
  // 버킷 사이를 합칠 때의 가중치는 편수가 아니라 그 버킷의 조회수여야 한다
  // (같은 테이블의 total_views — 추정이 아니라 실제 컬럼).
  const orgViewAgg = new Map<string, { wsum: number; n: number }>();
  for (const r of orgRows) {
    const score = r.organic_score_mean_shrunk ?? r.organic_score_mean_simple;
    const weight = Number(r.scored_video_count);
    if (score != null && Number.isFinite(weight) && weight > 0) {
      const a = orgAgg.get(r.group_key) ?? { wsum: 0, n: 0 };
      a.wsum += score * weight;
      a.n += weight;
      orgAgg.set(r.group_key, a);
    }
    const vScore = r.organic_score_mean;
    const vWeight = Number(r.total_views);
    if (vScore != null && Number.isFinite(vWeight) && vWeight > 0) {
      const a = orgViewAgg.get(r.group_key) ?? { wsum: 0, n: 0 };
      a.wsum += vScore * vWeight;
      a.n += vWeight;
      orgViewAgg.set(r.group_key, a);
    }
  }
  // 쿼리 자체가 실패했을 땐 그룹별 null-placeholder 행도 만들지 않는다 —
  // "데이터 없음(score:null)"과 "쿼리 실패"를 organicity 배열 모양만으로는
  // 구분할 수 없으므로, 실패는 오직 organicity_unavailable 로만 표현하고
  // organicity 자체는 빈 배열로 명확히 비운다.
  const organicity = organicityUnavailable
    ? []
    : ALL_KEYS.filter((gk) => byKey.has(gk)).map((gk) => {
        const a = orgAgg.get(gk);
        const v = orgViewAgg.get(gk);
        const ep = exPaidBy.get(gk);
        const epViews = ep?.views ?? 0;
        const epExViews = ep?.ex_views ?? 0;
        return {
          group_key: gk,
          score: a && a.n > 0 ? Math.round((a.wsum / a.n) * 10) / 10 : null,
          // 편수 기준 점수와 나란히 놓는 조회수 기준 점수. 둘이 크게 벌어지면
          // 조회수가 소수의 광고성 영상에 쏠려 있다는 신호다.
          score_view_weighted:
            v && v.n > 0 ? Math.round((v.wsum / v.n) * 10) / 10 : null,
          // 실효 표본 수 = 점수에 실제로 실린 scored_video_count 합.
          video_count: a?.n ?? 0,
          reference: isRef(gk),
          // 영상 단위 유료 판정 제외 집계 — 쿼리 실패/데이터 없음이면
          // count는 0, 비율·점수는 null(가짜 수치 금지).
          window_video_count: ep?.n ?? 0,
          paid_video_count: ep?.paid_n ?? 0,
          paid_view_share: ep && epViews > 0 && ep.paid_views != null
            ? Math.round((ep.paid_views / epViews) * 1000) / 1000 : null,
          score_view_weighted_ex_paid: ep && epExViews > 0 && ep.ex_wsum != null
            ? Math.round((ep.ex_wsum / epExViews) * 10) / 10 : null,
        };
      });

  const groupsOut: Record<string, { name: string; debut_date: string | null; reference: boolean }> = {};
  for (const g of groups) {
    groupsOut[g.key] = { name: g.name, debut_date: g.debut_date, reference: isRef(g.key) };
  }

  return jsonResponse({
    as_of_day: asOfDay,
    // 측정 허용폭을 응답에 실어 보낸다 — 화면 각주가 "±3 / ±7" 을 따로
    // 하드코딩하면 상수를 바꿨을 때 표기와 실제 계산이 조용히 어긋난다
    // (투자사 보고 — 화면 자기모순 금지).
    // pre_debut 도 같은 이유로 함께 — 화면 캡션이 "데뷔 30일 전부터"를
    // 따로 적어두면 상수를 바꿨을 때 문구만 옛날 값으로 남는다.
    windows: { base: BASE_WINDOW, at: AT_DAY_WINDOW, pre_debut: PRE_DEBUT_DAYS },
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
