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
    const body = await res.json();
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
    const body = await res.json();
    expect(body.groups.miiwan.health_score).toBeNull();
  });
});
