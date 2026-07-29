// /api/miiwan-cohort 계약 고정: 데뷔일 정렬 인덱스 곡선·스코어카드 순위에서
// plave(reference)가 순위 모수에 안 들어가는 것, D0 결측 그룹의 excluded
// 처리, 응답 형태. (라이브는 HMAC 게이트 — 이 레이어에서 검증.)
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/miiwan-cohort";

const envWith = (handler: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: handler(sql) })),
    first: vi.fn(async () => handler(sql)[0] ?? null),
  })) },
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

async function call(handler: (sql: string) => any[]) {
  const res = await onRequestGet({ env: envWith(handler), ...req() } as any);
  expect(res.status).toBe(200);
  return await res.json() as any;
}

describe("/api/miiwan-cohort", () => {
  const baseHandler = (sql: string): any[] => {
    if (sql.includes("FROM groups")) return GROUPS();
    if (sql.includes("FROM agg_summary")) return summaryRows();
    if (sql.includes("debut_window_organicity_summary")) return [
      { group_key: "miiwan", organic_score_mean: 80, scored_video_count: 10 },
      { group_key: "myrakl", organic_score_mean: 60, scored_video_count: 20 },
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
