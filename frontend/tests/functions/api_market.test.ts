import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/market";

const envWith = (handler: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: handler(sql) })),
    first: vi.fn(async () => handler(sql)[0] ?? null),
  })) },
} as any);

describe("/api/market", () => {
  it("aggregates groups with latest health + summary + insights", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups")) {
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      }
      if (sql.includes("FROM agg_summary")) {
        return [{ group_key: "plave", snapshot_at: "2026-05-04T14:00:00Z",
                  yt_total_views: 1, dc_total_posts: 2, theqoo_posts: 3,
                  instiz_posts: 4, naver_total_news: 5, twitter_posts: 6,
                  controversy_count: 0, yt_total_videos: 7, yt_subscribers: 8 }];
      }
      if (sql.includes("FROM agg_health_scores")) {
        return [{ group_key: "plave", snapshot_at: "x", total: 9.5, grade: "S",
                  label: "정상 궤도", breakdown_json: '{"subscribers":20}',
                  bonus_json: '{}', quality_method: "top10_avg" }];
      }
      if (sql.includes("FROM insights")) {
        return [{ id: 1, title: "T", body: "B", scope: "market", type: "insight",
                  source_refs_json: "[]", generated_at: "..." }];
      }
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.plave.health_score.total).toBe(9.5);
    expect(body.groups.plave.health_score.breakdown).toEqual({ subscribers: 20 });
    expect(body.market_insights).toHaveLength(1);
  });

  it("returns null health for groups without scores", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "miiwan", name: "MiiWAN", name_kr: "미완소년" }];
      if (sql.includes("FROM agg_summary"))
        return [{ group_key: "miiwan", snapshot_at: "x", yt_total_views: 0,
                  dc_total_posts: 0, theqoo_posts: 0, instiz_posts: 0,
                  naver_total_news: 0, twitter_posts: 0, controversy_count: 0,
                  yt_total_videos: 0, yt_subscribers: 0 }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.miiwan.health_score).toBeNull();
  });

  // P2b — Awareness Index surfaced on each group.
  it("includes awareness.{score,category_rank} for scored groups", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      if (sql.includes("FROM agg_awareness"))
        return [{ group_key: "plave", awareness_score: 87.4,
                  category_rank: 1, basis: "scored" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.plave.awareness).toEqual({
      score: 87.4, category_rank: 1,
      score_adj: null, category_rank_adj: null, organic_confidence: null,
    });
  });

  it("nulls awareness score/rank when basis=insufficient", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "wegosix", name: "WeGoSix", name_kr: "위고식스" }];
      if (sql.includes("FROM agg_awareness"))
        return [{ group_key: "wegosix", awareness_score: null,
                  category_rank: null, basis: "insufficient" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.wegosix.awareness).toEqual({
      score: null, category_rank: null,
      score_adj: null, category_rank_adj: null, organic_confidence: null,
    });
  });

  // V2.53 Organic Trust Layer — awareness adj (mig 0106).
  it("includes score_adj/category_rank_adj/organic_confidence when adj row present (basis=scored)", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      if (sql.includes("awareness_score_adj"))
        return [{ group_key: "plave", awareness_score_adj: 81.2,
                  category_rank_adj: 2, organic_confidence: 0.73 }];
      if (sql.includes("FROM agg_awareness"))
        return [{ group_key: "plave", awareness_score: 87.4,
                  category_rank: 1, basis: "scored" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.plave.awareness).toEqual({
      score: 87.4, category_rank: 1,
      score_adj: 81.2, category_rank_adj: 2, organic_confidence: 0.73,
    });
  });

  // mig 0106 미적용 D1 모사 — adj 전용 쿼리만 reject, 기존 awareness 응답 형태는 그대로 + adj는 null.
  it("agg_awareness adj query reject (mig 0106 미적용) → awareness score/rank intact, adj fields null", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      if (sql.includes("awareness_score_adj"))
        throw new Error("no such column: awareness_score_adj");
      if (sql.includes("FROM agg_awareness"))
        return [{ group_key: "plave", awareness_score: 87.4,
                  category_rank: 1, basis: "scored" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.groups.plave.awareness).toEqual({
      score: 87.4, category_rank: 1,
      score_adj: null, category_rank_adj: null, organic_confidence: null,
    });
  });

  it("awareness is null when no agg_awareness row exists", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "miiwan", name: "MiiWAN", name_kr: "미완소년" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.miiwan.awareness).toBeNull();
  });

  // P2a 전 그룹 확장 — core_fan_estimate 참고용 표기
  it("includes core_fan_estimate.{est_engaged_fans,est_active_core} for scored groups", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      if (sql.includes("FROM agg_core_fan_estimate"))
        return [{ group_key: "plave", est_engaged_fans: 12000,
                  est_active_core: 3500, basis: "scored" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.plave.core_fan_estimate).toEqual({
      est_engaged_fans: 12000, est_active_core: 3500,
      est_engaged_fans_adj: null, est_active_core_adj: null, basis: "scored",
    });
  });

  // V2.53 Organic Trust Layer — 유료 의심 영상 제외 후 표본 부족(원값만 보유)이어도
  // 카드에는 raw 값 표시 + adj는 null.
  it("core_fan_estimate basis=insufficient_organic exposes raw values with adj fields null", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "wegosix", name: "WeGoSix", name_kr: "위고식스" }];
      if (sql.includes("est_engaged_fans_adj"))
        return [];
      if (sql.includes("FROM agg_core_fan_estimate"))
        return [{ group_key: "wegosix", est_engaged_fans: 4200,
                  est_active_core: 900, basis: "insufficient_organic" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.wegosix.core_fan_estimate).toEqual({
      est_engaged_fans: 4200, est_active_core: 900,
      est_engaged_fans_adj: null, est_active_core_adj: null,
      basis: "insufficient_organic",
    });
  });

  it("returns core_fan_estimate=null when basis=insufficient (미표시)", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "wegosix", name: "WeGoSix", name_kr: "위고식스" }];
      if (sql.includes("FROM agg_core_fan_estimate"))
        return [{ group_key: "wegosix", est_engaged_fans: null,
                  est_active_core: null, basis: "insufficient" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    // 영상 없는 그룹은 카드에 '추정 코어팬'을 띄우지 않도록 null 반환.
    expect(body.groups.wegosix.core_fan_estimate).toBeNull();
  });

  it("core_fan_estimate is null when no agg_core_fan_estimate row exists", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "miiwan", name: "MiiWAN", name_kr: "미완소년" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.miiwan.core_fan_estimate).toBeNull();
  });

  it("agg_core_fan_estimate query reject (no such table) → 200 with core_fan_estimate:null, other data intact", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      if (sql.includes("FROM agg_core_fan_estimate"))
        throw new Error("no such table: agg_core_fan_estimate");
      if (sql.includes("FROM agg_summary"))
        return [{ group_key: "plave", snapshot_at: "2026-05-04T14:00:00Z",
                  yt_total_views: 100, dc_total_posts: 2, theqoo_posts: 3,
                  instiz_posts: 4, naver_total_news: 5, twitter_posts: 6,
                  controversy_count: 0, yt_total_videos: 7, yt_subscribers: 8 }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.groups.plave.core_fan_estimate).toBeNull();
    expect(body.groups.plave.summary?.yt_total_views).toBe(100);
  });

  // P2b Critical fix — migration 0097 미배포 환경에서 agg_awareness 테이블이 없어도
  // /api/market 전체가 500이 되지 않고 200 + awareness:null 로 응답해야 한다.
  it("agg_awareness query reject (no such table) → 200 with awareness:null, other data intact", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      if (sql.includes("FROM agg_awareness"))
        throw new Error("no such table: agg_awareness");
      if (sql.includes("FROM agg_summary"))
        return [{ group_key: "plave", snapshot_at: "2026-05-04T14:00:00Z",
                  yt_total_views: 100, dc_total_posts: 2, theqoo_posts: 3,
                  instiz_posts: 4, naver_total_news: 5, twitter_posts: 6,
                  controversy_count: 0, yt_total_videos: 7, yt_subscribers: 8 }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.groups.plave.awareness).toBeNull();
    // Other data still present
    expect(body.groups.plave.summary?.yt_total_views).toBe(100);
  });

  // 시청전환율 — agg_fan_loyalty.conversion_rate (median peak CCV / subscribers).
  it("includes view_conversion (floor only) for a group without a Weverse ceiling", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "owis", name: "OWIS", name_kr: "오위스" }];
      if (sql.includes("FROM agg_fan_loyalty"))
        return [{ group_key: "owis", conversion_rate: 0.04,
                  conversion_rate_ceiling: null, ccv_ceiling: null,
                  peak_ccv_median: 4200, broadcast_count: 6, basis: "scored" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.owis.view_conversion).toEqual({
      rate: 0.04, rate_ceiling: null, ccv_ceiling: null,
      peak_ccv: 4200, broadcasts: 6, basis: "scored",
    });
  });

  it("exposes rate_ceiling (유튜브+위버스 합산) for PLAVE", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      if (sql.includes("FROM agg_fan_loyalty"))
        return [{ group_key: "plave", conversion_rate: 0.0015,
                  conversion_rate_ceiling: 0.102, ccv_ceiling: 102000,
                  peak_ccv_median: 2000, broadcast_count: 8, basis: "scored" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.plave.view_conversion.rate).toBe(0.0015);          // YouTube floor
    expect(body.groups.plave.view_conversion.rate_ceiling).toBe(0.102);   // +Weverse ceiling
    expect(body.groups.plave.view_conversion.ccv_ceiling).toBe(102000);
  });

  it("view_conversion=null when basis=insufficient", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "isedol", name: "ISEGYE", name_kr: "이세계아이돌" }];
      if (sql.includes("FROM agg_fan_loyalty"))
        return [{ group_key: "isedol", conversion_rate: null,
                  peak_ccv_median: null, broadcast_count: 0, basis: "insufficient" }];
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.groups.isedol.view_conversion).toBeNull();
  });

  it("agg_fan_loyalty reject (no such table) → 200 with view_conversion:null", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브" }];
      if (sql.includes("FROM agg_fan_loyalty"))
        throw new Error("no such table: agg_fan_loyalty");
      return [];
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.groups.plave.view_conversion).toBeNull();
  });
});
