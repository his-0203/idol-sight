// /api/miiwan-cohort 계약 고정: 데뷔일 정렬 인덱스 곡선·스코어카드 순위에서
// plave(reference)가 순위 모수에 안 들어가는 것, D0 결측 그룹의 excluded
// 처리, 응답 형태. (라이브는 HMAC 게이트 — 이 레이어에서 검증.)
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/miiwan-cohort";
import { PRE_DEBUT_DAYS } from "../../functions/lib/cohortReport";
import { bucketIndexForAge, labelForIndex } from "../../functions/lib/debutWindowBuckets";

/** 유기성 창의 왼쪽 끝 = 곡선이 보는 데뷔 전 구간을 덮는 버킷 (엔드포인트와 동일 파생). */
const ORG_FIRST_BUCKET = labelForIndex(bucketIndexForAge(-PRE_DEBUT_DAYS));

type Capture = (sql: string, params: unknown[]) => void;

const envWith = (handler: (sql: string) => any[], capture?: Capture) => ({
  DB: { prepare: vi.fn((sql: string) => {
    const stmt: any = {
      bind: vi.fn((...params: unknown[]) => { capture?.(sql, params); return stmt; }),
      all: vi.fn(async () => ({ results: handler(sql) })),
      first: vi.fn(async () => handler(sql)[0] ?? null),
    };
    return stmt;
  }) },
} as any);

const req = () => ({ request: new Request("https://x/api/miiwan-cohort") });

// 데뷔 30일 뒤 시점을 흉내내려면 miiwan debut_date를 오늘-30일로 만든다
// (엔드포인트가 오늘 기준 as_of_day를 동적 계산하므로 테스트도 상대 날짜 사용).
const iso = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

const GROUPS = (miiwanDebutDaysAgo = 30) => [
  { key: "miiwan", name: "MiiWAN", debut_date: iso(miiwanDebutDaysAgo) },
  { key: "myrakl", name: "MYRAKL", debut_date: iso(200) },
  { key: "plave",  name: "PLAVE",  debut_date: iso(1200) },
];

// agg_summary 행: 그룹별 D0·D+30 두 스냅샷 (miiwan 2배, myrakl 3배 성장).
const summaryRows = () => {
  const mk = (gk: string, debutDaysAgo: number, d0: number, d30: number) => [
    { group_key: gk, debut_date: iso(debutDaysAgo),
      snapshot_at: iso(debutDaysAgo) + "T09:00:00Z",
      yt_subscribers: d0, yt_total_views: d0 * 100,
      data_source: "live" },
    { group_key: gk, debut_date: iso(debutDaysAgo),
      snapshot_at: iso(debutDaysAgo - 30) + "T09:00:00Z",
      yt_subscribers: d30, yt_total_views: d30 * 100,
      data_source: "live" },
  ];
  return [...mk("miiwan", 30, 1000, 2000), ...mk("myrakl", 200, 5000, 15000)];
};

async function call(handler: (sql: string) => any[], capture?: Capture) {
  const res = await onRequestGet({ env: envWith(handler, capture), ...req() } as any);
  expect(res.status).toBe(200);
  return await res.json() as any;
}

describe("/api/miiwan-cohort", () => {
  const baseHandler = (sql: string): any[] => {
    if (sql.includes("FROM groups")) return GROUPS();
    if (sql.includes("FROM agg_summary")) return summaryRows();
    if (sql.includes("debut_window_organicity_summary")) return [
      { group_key: "miiwan", organic_score_mean_shrunk: 80,
        organic_score_mean_simple: 55, scored_video_count: 10 },
      // shrunk NULL (pre-0092 행) → simple 로 fallback, 가중치는 scored_video_count
      { group_key: "myrakl", organic_score_mean_shrunk: null,
        organic_score_mean_simple: 60, scored_video_count: 5 },
    ];
    return [];
  };

  it("as_of_day = 미완이 데뷔 경과일, 곡선은 D0=100 인덱스", async () => {
    const body = await call(baseHandler);
    expect(body.as_of_day).toBeGreaterThanOrEqual(29);
    expect(body.as_of_day).toBeLessThanOrEqual(31);
    const mi = body.curves.yt_subscribers.miiwan;
    expect(mi[0].index).toBe(100);
    expect(mi[mi.length - 1].index).toBe(200); // 1000→2000 = 2배
  });

  // 커뮤니티 활동(dc_total_posts)은 갤러리 개설 시점이 팀마다 달라 데뷔일
  // 기준값이 성장의 출발선이 되지 못한다 — 동시기 성과에서만 뺀 것이라
  // 목록·쿼리 양쪽에서 사라졌는지 함께 고정한다(다른 화면은 계속 쓴다).
  it("동시기 지표 목록에 dc_total_posts 없음 (SELECT 에서도 빠짐)", async () => {
    let summarySql = "";
    const body = await call(baseHandler, (sql) => {
      if (sql.includes("FROM agg_summary")) summarySql = sql;
    });
    expect(body.metrics).toEqual(["yt_subscribers", "yt_total_views"]);
    expect(body.scorecard.dc_total_posts).toBeUndefined();
    expect(body.curves.dc_total_posts).toBeUndefined();
    expect(summarySql).not.toContain("dc_total_posts");
    // 뉴스는 live=누적 / 백필=기간 건수라 단위가 섞여 배수 비교가 성립하지
    // 않는다 — 목록·쿼리 양쪽에서 빠졌는지 함께 고정.
    expect(body.scorecard.naver_total_news).toBeUndefined();
    expect(summarySql).not.toContain("naver_total_news");
  });

  it("plave는 reference=true, 순위 모수 제외", async () => {
    const body = await call(baseHandler);
    expect(body.groups.plave.reference).toBe(true);
    const sc = body.scorecard.yt_subscribers;
    // miiwan 2.0배 vs myrakl 3.0배 → miiwan 2위 / 모수 2 (plave 미포함)
    expect(sc.miiwan_rank).toBe(2);
    expect(sc.cohort_size).toBe(2);
    const plaveRow = sc.rows.find((r: any) => r.group_key === "plave");
    expect(plaveRow?.reference).toBe(true);
  });

  it("D0 결측 그룹은 곡선 제외 + excluded 기록 (가짜 수치 없음)", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      // myrakl은 D+150 스냅샷만 → D0 기준값 없음
      if (sql.includes("FROM agg_summary")) return [
        ...summaryRows().filter((r) => r.group_key === "miiwan"),
        { group_key: "myrakl", debut_date: iso(200),
          snapshot_at: iso(50) + "T09:00:00Z",
          yt_subscribers: 9999, yt_total_views: 1,
          data_source: "backfill_estimate" },
      ];
      return [];
    });
    expect(body.curves.yt_subscribers.myrakl).toBeUndefined();
    expect(body.excluded.some((e: any) =>
      e.group_key === "myrakl" && e.metric === "yt_subscribers")).toBe(true);
  });

  it("유기성 쿼리 실패는 organicity_unavailable=true로 명시 (200 + 빈 배열 위장 금지)", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return summaryRows();
      if (sql.includes("debut_window_organicity_summary")) {
        throw new Error("D1 error: table locked");
      }
      return [];
    });
    expect(body.organicity_unavailable).toBe(true);
    expect(body.organicity).toEqual([]);
  });

  it("스코어카드 행에 실제 측정일 메타(base_day·at_day·base_source)", async () => {
    const body = await call(baseHandler);
    const rows = body.scorecard.yt_subscribers.rows;
    const mine = rows.find((r: any) => r.group_key === "miiwan");
    expect(mine.base_day).toBe(0);
    expect(mine.at_day).toBe(30);       // D+30 스냅샷에서 집어온 값
    expect(mine.base_source).toBe("live");
    // 데이터 없는 코호트 구성원도 필드 자체는 존재(null) — 프론트가 분기할 수 있어야.
    const plave = rows.find((r: any) => r.group_key === "plave");
    expect(plave).toMatchObject({
      base_day: null, base_value: null, at_day: null, base_source: null,
      pre_value: null, pre_day: null, pre_source: null,
      total_multiple: null, total_anchor_day: null, total_anchor_source: null,
    });
  });

  // 성장배수의 분모를 화면이 못 보면 "출발선이 작아서 큰 배수"를 실력 차이로
  // 읽는다 — 분자(value_at_day)와 분모(base_value)를 같이 낸다.
  it("스코어카드 행에 출발선 값(base_value) — 배수 = 도달값 ÷ 출발선", async () => {
    const body = await call(baseHandler);
    const rows = body.scorecard.yt_subscribers.rows;
    const mine = rows.find((r: any) => r.group_key === "miiwan");
    expect(mine.base_value).toBe(1000);
    expect(mine.value_at_day).toBe(2000);
    expect(mine.growth_multiple).toBeCloseTo(mine.value_at_day / mine.base_value);
    const peer = rows.find((r: any) => r.group_key === "myrakl");
    expect(peer.base_value).toBe(5000);
  });

  // 성장을 데뷔 전/후로 쪼개야 "출발선이 크다"가 데뷔 전에 쌓인 것인지
  // 데뷔 직전에 채워진 것인지 구분된다.
  it("데뷔 전 배수(pre_multiple) + 구독 획득 효율(subs/1k뷰)", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return [
        // D-30: 구독 500 / 조회 50,000
        { group_key: "miiwan", debut_date: iso(30),
          snapshot_at: iso(60) + "T09:00:00Z",
          yt_subscribers: 500, yt_total_views: 50_000, data_source: "live" },
        ...summaryRows().filter((r) => r.group_key === "miiwan"),
      ];
      return [];
    });
    const mine = body.scorecard.yt_subscribers.rows
      .find((r: any) => r.group_key === "miiwan");
    // 데뷔 전: 500 → 1,000 = 2.0× / 데뷔 후: 1,000 → 2,000 = 2.0×
    expect(mine.pre_multiple).toBeCloseTo(2);
    expect(mine.growth_multiple).toBeCloseTo(2);
    // 데뷔 전 구독 +500, 조회 +50,000 → 1,000뷰당 10
    expect(mine.subs_per_1k_pre).toBeCloseTo(10);
    // 데뷔 후 구독 +1,000, 조회 +100,000 → 1,000뷰당 10
    expect(mine.subs_per_1k_post).toBeCloseTo(10);
    // 데뷔 전 앵커(D-30, 500) + 총 성장배수(500 → D+30 값 2,000 = 4.0×).
    expect(mine.pre_value).toBe(500);
    expect(mine.pre_day).toBe(-30);
    expect(mine.pre_source).toBe("live");
    expect(mine.total_multiple).toBeCloseTo(4);
    expect(mine.total_anchor_day).toBe(-30);
    expect(mine.total_anchor_source).toBe("live");
  });

  // 추정 보간값은 앵커 없는 구간에 없던 급등을 그린다 — 곡선은 실측만 잇되
  // 표의 배수는 종전대로(est 배지로 공시) 추정값까지 쓴다.
  it("곡선은 실측점만 · 표의 배수는 추정값 포함 (비대칭을 그대로 유지)", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return [
        { group_key: "miiwan", debut_date: iso(30),
          snapshot_at: iso(30) + "T09:00:00Z",
          yt_subscribers: 1_000, yt_total_views: 100_000, data_source: "live" },
        // D+15 추정 보간 — 곡선에는 안 실린다.
        { group_key: "miiwan", debut_date: iso(30),
          snapshot_at: iso(15) + "T09:00:00Z",
          yt_subscribers: 9_999, yt_total_views: 999_999,
          data_source: "backfill_estimate" },
        { group_key: "miiwan", debut_date: iso(30),
          snapshot_at: iso(0) + "T09:00:00Z",
          yt_subscribers: 2_000, yt_total_views: 200_000, data_source: "live" },
      ];
      return [];
    });
    const days = body.curves.yt_subscribers.miiwan.map((p: any) => p.day);
    expect(days).not.toContain(15);
    expect(days).toEqual([0, 30]);
    // 배수는 여전히 전체 소스 기준으로 계산된다.
    const mine = body.scorecard.yt_subscribers.rows
      .find((r: any) => r.group_key === "miiwan");
    expect(mine.growth_multiple).toBeCloseTo(2);
  });

  // 종전에는 표에 "—" 만 뜨고 왜 빈지 화면이 답하지 못했다.
  it("기준값은 있으나 비교 시점 값이 없으면 no_at_day_value 로 명시", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return [
        ...summaryRows().filter((r) => r.group_key === "miiwan"),
        // myrakl: D0 근방 값만 있고 D+30±7 구간이 비어 있다.
        { group_key: "myrakl", debut_date: iso(200),
          snapshot_at: iso(200) + "T09:00:00Z",
          yt_subscribers: 5_000, yt_total_views: 500_000, data_source: "live" },
      ];
      return [];
    });
    expect(body.excluded.some((e: any) =>
      e.group_key === "myrakl" && e.metric === "yt_subscribers"
      && e.reason === "no_at_day_value")).toBe(true);
    const peer = body.scorecard.yt_subscribers.rows
      .find((r: any) => r.group_key === "myrakl");
    expect(peer.base_value).toBe(5_000);
    expect(peer.value_at_day).toBeNull();
  });

  // 회귀: 곡선 실패와 배수 실패를 따로 push 하면 같은 (그룹,지표)가 두 줄
  // 나오고, "곡선만 제외 — 표의 배수는 남음" 문구가 배수도 없는 행에 붙어
  // 거짓이 된다. 사유는 (그룹,지표)당 최대 1건 · 배수 실패가 우선.
  it("D0 근방에 추정값만 + 도달값 없음 → no_at_day_value 한 줄만", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return [
        ...summaryRows().filter((r) => r.group_key === "miiwan"),
        // myrakl: D0±1 에 backfill_estimate 단독 → 실측 곡선 기준값 없음.
        // D+30±7 에는 아무 값도 없음 → 배수도 null.
        { group_key: "myrakl", debut_date: iso(200),
          snapshot_at: iso(199) + "T09:00:00Z",
          yt_subscribers: 5_000, yt_total_views: 500_000,
          data_source: "backfill_estimate" },
      ];
      return [];
    });
    const mine = body.excluded.filter((e: any) =>
      e.group_key === "myrakl" && e.metric === "yt_subscribers");
    expect(mine).toHaveLength(1);
    expect(mine[0].reason).toBe("no_at_day_value");
    const row = body.scorecard.yt_subscribers.rows
      .find((r: any) => r.group_key === "myrakl");
    expect(row.growth_multiple).toBeNull();
  });

  it("어떤 (그룹,지표)도 excluded 에 두 번 나오지 않는다", async () => {
    const body = await call(baseHandler);
    const seen = body.excluded.map((e: any) => `${e.group_key}:${e.metric}`);
    expect(new Set(seen).size).toBe(seen.length);
  });

  // 배수가 살아 있는데 곡선만 실패한 경우에만 곡선-side 사유가 나온다 —
  // 이 경로에서만 "표의 배수는 남는다"는 화면 문구가 참이다.
  it("배수는 남고 곡선만 실패하면 no_measured_d0_baseline", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return [
        ...summaryRows().filter((r) => r.group_key === "miiwan"),
        // D0 는 추정값뿐(실측 기준값 없음), D+30 은 실측 → 배수는 나온다.
        { group_key: "myrakl", debut_date: iso(200),
          snapshot_at: iso(200) + "T09:00:00Z",
          yt_subscribers: 5_000, yt_total_views: 500_000,
          data_source: "backfill_estimate" },
        { group_key: "myrakl", debut_date: iso(200),
          snapshot_at: iso(170) + "T09:00:00Z",
          yt_subscribers: 15_000, yt_total_views: 1_500_000,
          data_source: "live" },
      ];
      return [];
    });
    const mine = body.excluded.filter((e: any) =>
      e.group_key === "myrakl" && e.metric === "yt_subscribers");
    expect(mine).toHaveLength(1);
    expect(mine[0].reason).toBe("no_measured_d0_baseline");
    const row = body.scorecard.yt_subscribers.rows
      .find((r: any) => r.group_key === "myrakl");
    expect(row.growth_multiple).toBeCloseTo(3); // 5,000 → 15,000
    expect(body.curves.yt_subscribers.myrakl).toBeUndefined();
  });

  it("유기성 점수는 shrunk 우선·simple fallback (raw view-weighted mean 아님)", async () => {
    const body = await call(baseHandler);
    const byKey = Object.fromEntries(
      body.organicity.map((o: any) => [o.group_key, o]));
    expect(byKey.miiwan.score).toBe(80);  // shrunk 80 (simple 55 아님)
    expect(byKey.myrakl.score).toBe(60);  // shrunk NULL → simple 60
    expect(byKey.miiwan.video_count).toBe(10);
  });

  // 그룹 수준 규칙은 organicity.ts 의 headlineOrganicScore(버킷당 shrunk ??
  // simple 택일)와 동일 — 행별 COALESCE(shrunk, simple)를 scored_video_count
  // 가중 평균한다. 워커 특성상 shrunk 가 null이면 simple 도 null이라 "shrunk
  // null·simple 존재"인 행은 실무에 없고, 있다면(pre-0092 잔재) scored_video_
  // count=0이라 가중치 0으로 자연 탈락한다 — 별도 폴백 가중치 분기는 없다.
  it("행별 COALESCE(shrunk, simple)를 scored_video_count 가중 평균 (scored=0 행은 자연 탈락)", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return summaryRows();
      if (sql.includes("debut_window_organicity_summary")) return [
        // 정상 행: scored_video_count=10 가중
        { group_key: "miiwan", organic_score_mean_shrunk: 90,
          organic_score_mean_simple: 10, scored_video_count: 10 },
        // pre-0092 잔재: shrunk null → simple 50 이지만 scored_video_count=0
        // 이라 가중 0 → 자연 탈락(폴백 분기 없이도 결과에 영향 없음).
        { group_key: "miiwan", organic_score_mean_shrunk: null,
          organic_score_mean_simple: 50, scored_video_count: 0 },
      ];
      return [];
    });
    const mi = body.organicity.find((o: any) => o.group_key === "miiwan");
    expect(mi.score).toBe(90);
    expect(mi.video_count).toBe(10);
  });

  // 영상 단위 유료 판정 제외 집계 — "조회수 점수가 낮은 이유가 소수 집행
  // 콘텐츠 쏠림인가"를 organicity 행에서 바로 읽을 수 있어야 한다.
  // 픽스처: paid 1편(80k뷰·score 30) + organic 1편(20k뷰·score 80).
  it("영상 단위 유료 판정 제외 집계 — 쏠림 규모 + 제외 점수", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return summaryRows();
      if (sql.includes("debut_window_organicity_summary")) return [
        { group_key: "miiwan", organic_score_mean_shrunk: 80,
          organic_score_mean_simple: 55, scored_video_count: 10 },
      ];
      if (sql.includes("debut_window_video_organicity")) return [
        { group_key: "miiwan", n: 2, views: 100_000,
          paid_n: 1, paid_views: 80_000,
          ex_wsum: 80 * 20_000, ex_views: 20_000 },
      ];
      return [];
    });
    const mi = body.organicity.find((o: any) => o.group_key === "miiwan");
    expect(mi.window_video_count).toBe(2);
    expect(mi.paid_video_count).toBe(1);
    expect(mi.paid_view_share).toBeCloseTo(0.8);
    expect(mi.score_view_weighted_ex_paid).toBeCloseTo(80);
  });

  it("전부 paid인 그룹은 ex_paid null (분모 0, 가짜 수치 금지)", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return summaryRows();
      if (sql.includes("debut_window_organicity_summary")) return [
        { group_key: "myrakl", organic_score_mean_shrunk: 50,
          organic_score_mean_simple: 50, scored_video_count: 5 },
      ];
      if (sql.includes("debut_window_video_organicity")) return [
        { group_key: "myrakl", n: 3, views: 30_000,
          paid_n: 3, paid_views: 30_000,
          ex_wsum: 0, ex_views: 0 },
      ];
      return [];
    });
    const my = body.organicity.find((o: any) => o.group_key === "myrakl");
    expect(my.window_video_count).toBe(3);
    expect(my.paid_video_count).toBe(3);
    expect(my.paid_view_share).toBeCloseTo(1);
    expect(my.score_view_weighted_ex_paid).toBeNull();
  });

  it("영상 단위 쿼리 실패해도 organicity 행은 살아있고 새 필드만 degrade", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return summaryRows();
      if (sql.includes("debut_window_organicity_summary")) return [
        { group_key: "miiwan", organic_score_mean_shrunk: 80,
          organic_score_mean_simple: 55, scored_video_count: 10 },
      ];
      if (sql.includes("debut_window_video_organicity")) {
        throw new Error("D1 error: table locked");
      }
      return [];
    });
    // 전체 응답을 죽이지 않는다 — organicity_unavailable(요약 쿼리 전용
    // 플래그)은 그대로 false, 기존 score 필드도 살아있다.
    expect(body.organicity_unavailable).toBe(false);
    const mi = body.organicity.find((o: any) => o.group_key === "miiwan");
    expect(mi.score).toBe(80);
    expect(mi.window_video_count).toBe(0);
    expect(mi.paid_video_count).toBe(0);
    expect(mi.paid_view_share).toBeNull();
    expect(mi.score_view_weighted_ex_paid).toBeNull();
  });

  it("측정 허용폭·데뷔 전 구간 상수를 응답에 노출 (화면 각주 desync 방지)", async () => {
    const body = await call(baseHandler);
    expect(body.windows).toEqual({ base: 3, at: 7, pre_debut: PRE_DEBUT_DAYS });
  });

  // 곡선이 D-30 부터 그려지는데 조회 창이 D-7 에 머물면 데뷔 전 구간이
  // 조용히 잘린다 — 창의 왼쪽 끝이 상수를 따라가는지 고정한다.
  it("조회 창 왼쪽 끝 = -PRE_DEBUT_DAYS (데뷔 전 구간까지 긁어온다)", async () => {
    let summaryParams: unknown[] = [];
    await call(baseHandler, (sql, params) => {
      if (sql.includes("FROM agg_summary")) summaryParams = params;
    });
    // [...ALL_KEYS, from, to] 순 — 뒤 두 개가 범위.
    const [from, to] = summaryParams.slice(-2) as number[];
    expect(from).toBe(-PRE_DEBUT_DAYS);
    expect(to).toBeGreaterThan(0);
  });

  // 두 사유가 같은 라벨로 뭉치면 "데뷔 수집이 통째로 빈 그룹"과 "기준값은
  // 있는데 관측 창이 빈 그룹"을 화면에서 구분할 수 없다.
  it("excluded 사유를 no_d0_baseline / empty_window 로 구분", async () => {
    const dayRow = (gk: string, debutDaysAgo: number, dayOffset: number, v: number) => ({
      group_key: gk, debut_date: iso(debutDaysAgo),
      snapshot_at: iso(debutDaysAgo - dayOffset) + "T09:00:00Z",
      yt_subscribers: v, yt_total_views: v, data_source: "live",
    });
    // 미완이 데뷔 당일(as_of_day = 0) 기준 — 곡선 창은 [D0, D+0].
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS(0);
      if (sql.includes("FROM agg_summary")) return [
        dayRow("miiwan", 0, 0, 1000),
        // D+5 뿐 → D0±3 안에 기준값이 없다.
        dayRow("myrakl", 200, 5, 500),
        // D+2 는 기준값(D0±3)으로 잡히지만 곡선 창(≤ D+0)에는 점이 없다.
        dayRow("plave", 1200, 2, 700),
      ];
      return [];
    });
    const reasons = Object.fromEntries(body.excluded
      .filter((e: any) => e.metric === "yt_subscribers")
      .map((e: any) => [e.group_key, e.reason]));
    expect(reasons.myrakl).toBe("no_d0_baseline");
    expect(reasons.plave).toBe("empty_window");
  });

  it("유기성 창은 미완이가 도달한 버킷까지만 (고정 D+60 창 금지)", async () => {
    const orgParams: unknown[] = [];
    const cap: Capture = (sql, params) => {
      if (sql.includes("debut_window_organicity_summary")) orgParams.push(...params);
    };
    // 미완이 D+100 → 왼쪽 끝(데뷔 전 버킷)..D+100 까지, 그 너머는 조회 안 함.
    const old = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS(100);
      if (sql.includes("FROM agg_summary")) return summaryRows();
      return [];
    }, cap);
    expect(old.organicity_window).toBe(`${ORG_FIRST_BUCKET}~D+100`);
    expect(orgParams).toContain("D+100");
    expect(orgParams).not.toContain("D+120");

    // 미완이 D+30 → 아직 D+60 버킷에 도달 못함 (피어만 70일치 쓰는 불공정 방지).
    const young = await call(baseHandler);
    expect(young.organicity_window.startsWith(ORG_FIRST_BUCKET)).toBe(true);
    expect(young.organicity_window).not.toContain("D+60");
  });

  // 유료 캠페인은 데뷔 직전에 몰린다 — 창을 D-Day 에서 자르면 그 구간이
  // 통째로 집계 밖이라 점수가 실제보다 깨끗하게 나온다. 곡선이 보는 구간
  // (D-PRE_DEBUT_DAYS)과 같은 버킷에서 시작하는지 고정한다.
  it("유기성 창 왼쪽 끝은 데뷔 전 구간을 덮는 버킷 (D-Day 컷 아님)", async () => {
    const orgParams: unknown[] = [];
    const body = await call(baseHandler, (sql, params) => {
      if (sql.includes("debut_window_organicity_summary")) orgParams.push(...params);
    });
    expect(ORG_FIRST_BUCKET).not.toBe("D-Day");
    expect(orgParams).toContain(ORG_FIRST_BUCKET);
    expect(orgParams).toContain("D-Day");
    expect(body.organicity_window.startsWith(ORG_FIRST_BUCKET)).toBe(true);
  });

  // 편수 기준 점수와 조회수 기준 점수가 크게 벌어지면 조회수가 소수의
  // 광고성 영상에 쏠려 있다는 신호 — 한쪽만 내보내면 그 신호가 사라진다.
  it("자연 유입 점수에 조회수 가중 값 병기 (버킷 total_views 가중)", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return summaryRows();
      if (sql.includes("debut_window_organicity_summary")) return [
        { group_key: "miiwan", organic_score_mean_shrunk: 80,
          organic_score_mean_simple: 80, organic_score_mean: 90,
          total_views: 1_000, scored_video_count: 10 },
        { group_key: "miiwan", organic_score_mean_shrunk: 60,
          organic_score_mean_simple: 60, organic_score_mean: 30,
          total_views: 3_000, scored_video_count: 10 },
        // total_views 없음 → 조회수 가중에서만 빠지고 편수 점수는 살아 있다.
        { group_key: "myrakl", organic_score_mean_shrunk: 50,
          organic_score_mean_simple: 50, organic_score_mean: 50,
          total_views: null, scored_video_count: 4 },
      ];
      return [];
    });
    const byKey = Object.fromEntries(
      body.organicity.map((o: any) => [o.group_key, o]));
    // 편수 가중: (80×10 + 60×10) / 20 = 70
    expect(byKey.miiwan.score).toBe(70);
    // 조회수 가중: (90×1000 + 30×3000) / 4000 = 45
    expect(byKey.miiwan.score_view_weighted).toBe(45);
    expect(byKey.myrakl.score).toBe(50);
    expect(byKey.myrakl.score_view_weighted).toBeNull();
  });

  it("miiwan debut_date 없으면 503-급 에러 대신 명시적 4xx", async () => {
    const res = await onRequestGet({
      env: envWith((sql) =>
        sql.includes("FROM groups")
          ? [{ key: "miiwan", name: "MiiWAN", debut_date: null }] : []),
      ...req(),
    } as any);
    expect(res.status).toBe(409);
  });
});
