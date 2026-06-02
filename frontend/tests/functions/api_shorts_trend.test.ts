import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/shorts-trend";

// SQL 문자열로 분기해 가짜 row 반환 (api_market.test.ts 패턴).
const envWith = (handler: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: handler(sql) })),
    first: vi.fn(async () => handler(sql)[0] ?? null),
  })) },
} as any);

function baseEnv(over: Partial<Record<string, any[]>> = {}) {
  return envWith((sql) => {
    if (sql.includes("FROM groups")) {
      return over.groups ?? [
        { key: "plave", name: "PLAVE", name_kr: "플레이브", context_keywords: null, twitter_handles: null },
        { key: "miiwan", name: "MiiWAN", name_kr: "미완소년",
          context_keywords: '["미완","miiwan"]', twitter_handles: "[]" },
      ];
    }
    if (sql.includes("is_short = 1") && sql.includes("!=")) {
      return over.trend ?? [
        { video_id: "p1", group_key: "plave", title: "플레이브 댄스 챌린지",
          content_type: "Dance", published_at: "2026-05-30T00:00:00Z",
          views: 120000, likes: 9000, comments: 400,
          view_count_24h: 80000, viral_velocity_ratio: 4.2 },
      ];
    }
    if (sql.includes("is_short = 1") && !sql.includes("!=")) {
      return over.miiwanShorts ?? [
        { video_id: "m1", title: "˚₊‧꒰ა 내부 별명", published_at: "2026-05-20T00:00:00Z",
          views: 1100, likes: 70, comments: 5, viral_velocity_ratio: 1.1 },
      ];
    }
    if (sql.includes("FROM agg_summary") && sql.includes("<= datetime")) {
      return over.prevSummary ?? [{ group_key: "miiwan", naver_total_news: 13 }];
    }
    if (sql.includes("FROM agg_summary")) {
      return over.summary ?? [{ group_key: "miiwan", yt_subscribers: 1300,
        twitter_posts: 0, naver_total_news: 13, dc_total_posts: 38 }];
    }
    if (sql.includes("FROM agg_member_popularity")) {
      return over.members ?? [{ composite_score: 3 }, { composite_score: 2 }, { composite_score: 1 }];
    }
    return [];
  });
}

describe("/api/shorts-trend", () => {
  it("트렌드·그룹·진단을 한 번에 반환", async () => {
    const res = await onRequestGet({ env: baseEnv(), request: new Request("https://x/api/shorts-trend") } as any);
    const body = await res.json() as any;
    expect(body.trend).toHaveLength(1);
    expect(body.trend[0].group_name_kr).toBe("플레이브");
    expect(body.groups.some((g: any) => g.key === "plave")).toBe(true);
    expect(body.diagnostic.group_key).toBe("miiwan");
    expect(body.diagnostic.dimensions.discoverability.length).toBeGreaterThan(0);
  });

  it("MiiWAN 은 트렌드(경쟁사) 목록에서 제외", async () => {
    const res = await onRequestGet({ env: baseEnv(), request: new Request("https://x/api/shorts-trend") } as any);
    const body = await res.json() as any;
    expect(body.trend.every((r: any) => r.group_key !== "miiwan")).toBe(true);
  });

  it("MiiWAN 숏폼 0개여도 진단은 반환(크래시 없음)", async () => {
    const res = await onRequestGet({
      env: baseEnv({ miiwanShorts: [] }),
      request: new Request("https://x/api/shorts-trend"),
    } as any);
    const body = await res.json() as any;
    expect(body.diagnostic.shorts_n).toBe(0);
  });
});
