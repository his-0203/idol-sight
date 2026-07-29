// /api/miiwan-cohort 계약 고정: 데뷔일 정렬 인덱스 곡선·스코어카드 순위에서
// plave(reference)가 순위 모수에 안 들어가는 것, D0 결측 그룹의 excluded
// 처리, 응답 형태. (라이브는 HMAC 게이트 — 이 레이어에서 검증.)
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/miiwan-cohort";

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
      naver_total_news: 10, dc_total_posts: 5, data_source: "live" },
    { group_key: gk, debut_date: iso(debutDaysAgo),
      snapshot_at: iso(debutDaysAgo - 30) + "T09:00:00Z",
      yt_subscribers: d30, yt_total_views: d30 * 100,
      naver_total_news: 20, dc_total_posts: 9, data_source: "live" },
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
        organic_score_mean_simple: 55, scored_video_count: 10, video_count: 12 },
      // shrunk NULL (pre-0092 행) → simple 로 fallback, 가중치도 video_count 로
      { group_key: "myrakl", organic_score_mean_shrunk: null,
        organic_score_mean_simple: 60, scored_video_count: 0, video_count: 20 },
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
          dc_total_posts: 1, data_source: "backfill_estimate" },
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
    expect(plave).toMatchObject({ base_day: null, at_day: null, base_source: null });
  });

  it("유기성 점수는 shrunk 우선·simple fallback (raw view-weighted mean 아님)", async () => {
    const body = await call(baseHandler);
    const byKey = Object.fromEntries(
      body.organicity.map((o: any) => [o.group_key, o]));
    expect(byKey.miiwan.score).toBe(80);  // shrunk 80 (simple 55 아님)
    expect(byKey.myrakl.score).toBe(60);  // shrunk NULL → simple 60
    expect(byKey.miiwan.video_count).toBe(10);
  });

  // canonical 집계(debut-window/summary.ts): shrunk 는 scored_video_count,
  // simple 은 video_count 가중. 폴백 행에 scored_video_count 를 쓰면
  // scored=0 인 pre-0092 행이 통째로 사라져 두 화면 숫자가 어긋난다.
  it("simple 폴백 행의 가중치는 video_count (canonical 집계와 동일)", async () => {
    const body = await call((sql) => {
      if (sql.includes("FROM groups")) return GROUPS();
      if (sql.includes("FROM agg_summary")) return summaryRows();
      if (sql.includes("debut_window_organicity_summary")) return [
        // shrunk 행: scored_video_count=10 가중
        { group_key: "miiwan", organic_score_mean_shrunk: 90,
          organic_score_mean_simple: 10, scored_video_count: 10, video_count: 999 },
        // simple 폴백 행: scored_video_count=0 여도 video_count=30 으로 살아남는다
        { group_key: "miiwan", organic_score_mean_shrunk: null,
          organic_score_mean_simple: 50, scored_video_count: 0, video_count: 30 },
      ];
      return [];
    });
    const mi = body.organicity.find((o: any) => o.group_key === "miiwan");
    // (90×10 + 50×30) / 40 = 60
    expect(mi.score).toBe(60);
    expect(mi.video_count).toBe(40);
  });

  it("측정 허용폭 상수를 응답에 노출 (화면 각주 하드코딩 desync 방지)", async () => {
    const body = await call(baseHandler);
    expect(body.windows).toEqual({ base: 3, at: 7 });
  });

  // 두 사유가 같은 라벨로 뭉치면 "데뷔 수집이 통째로 빈 그룹"과 "기준값은
  // 있는데 관측 창이 빈 그룹"을 화면에서 구분할 수 없다.
  it("excluded 사유를 no_d0_baseline / empty_window 로 구분", async () => {
    const dayRow = (gk: string, debutDaysAgo: number, dayOffset: number, v: number) => ({
      group_key: gk, debut_date: iso(debutDaysAgo),
      snapshot_at: iso(debutDaysAgo - dayOffset) + "T09:00:00Z",
      yt_subscribers: v, yt_total_views: v, naver_total_news: v,
      dc_total_posts: v, data_source: "live",
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
