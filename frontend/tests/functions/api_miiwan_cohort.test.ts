// /api/miiwan-cohort 계약 고정: 데뷔일 정렬 인덱스 곡선·스코어카드 순위에서
// plave(reference)가 순위 모수에 안 들어가는 것, D0 결측 그룹의 excluded
// 처리, 응답 형태. (라이브는 HMAC 게이트 — 이 레이어에서 검증.)
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/miiwan-cohort";
import { PRE_DEBUT_DAYS } from "../../functions/lib/cohortReport";

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
      naver_total_news: 10, data_source: "live" },
    { group_key: gk, debut_date: iso(debutDaysAgo),
      snapshot_at: iso(debutDaysAgo - 30) + "T09:00:00Z",
      yt_subscribers: d30, yt_total_views: d30 * 100,
      naver_total_news: 20, data_source: "live" },
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
    expect(body.metrics).toEqual([
      "yt_subscribers", "yt_total_views", "naver_total_news",
    ]);
    expect(body.scorecard.dc_total_posts).toBeUndefined();
    expect(body.curves.dc_total_posts).toBeUndefined();
    expect(summarySql).not.toContain("dc_total_posts");
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
          yt_subscribers: 9999, yt_total_views: 1, naver_total_news: 1,
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
      yt_subscribers: v, yt_total_views: v, naver_total_news: v,
      data_source: "live",
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
    // 미완이 D+100 → D-Day..D+100 버킷까지, 그 너머는 조회하지 않는다.
    const old = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS(100);
      if (sql.includes("FROM agg_summary")) return summaryRows();
      return [];
    }, cap);
    expect(old.organicity_window).toBe("D-Day~D+100");
    expect(orgParams).toContain("D+100");
    expect(orgParams).not.toContain("D+120");

    // 미완이 D+30 → 아직 D+60 버킷에 도달 못함 (피어만 70일치 쓰는 불공정 방지).
    const young = await call(baseHandler);
    expect(young.organicity_window.startsWith("D-Day")).toBe(true);
    expect(young.organicity_window).not.toContain("D+60");
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
