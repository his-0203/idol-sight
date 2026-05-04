import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/group/[key]";

const envWith = (h: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: h(sql) })),
    first: vi.fn(async () => h(sql)[0] ?? null),
  })) },
} as any);

describe("/api/group/[key]", () => {
  it("returns 404 when group does not exist", async () => {
    const env = envWith(() => []);
    const res = await onRequestGet({
      env, request: new Request("https://x/api/group/nope"),
      params: { key: "nope" },
    } as any);
    expect(res.status).toBe(404);
  });

  it("returns full group payload", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups WHERE key")) {
        return [{ key: "plave", name: "PLAVE", name_kr: "플레이브",
                  debut_date: "2023-03-12" }];
      }
      if (sql.includes("FROM agg_summary")) {
        return [{ group_key: "plave", snapshot_at: "2026-05-04T14:00:00Z",
                  yt_total_views: 100, dc_total_posts: 50, theqoo_posts: 0,
                  instiz_posts: 0, naver_total_news: 5, twitter_posts: 1,
                  controversy_count: 0, yt_total_videos: 24, yt_subscribers: 999 }];
      }
      if (sql.includes("FROM agg_health_scores")) {
        return [{ total: 9.0, grade: "A", label: "안정적",
                  breakdown_json: "{}", bonus_json: "{}",
                  quality_method: "top10_avg" }];
      }
      if (sql.includes("FROM youtube_videos")) {
        return [{ video_id: "v1", title: "MV", published_at: "2026-04-13",
                  content_type: "MV", views: 1000000, likes: 50000,
                  comments: 5000 }];
      }
      if (sql.includes("FROM community_posts")) {
        return [{ url: "u1", title: "t1", platform: "dc", posted_at: "2026-05-04",
                  views: 100, likes: 10, comments: 5 }];
      }
      if (sql.includes("FROM naver_articles")) {
        return [{ title: "n1", url: "u", source: "Naver", published_at: "2026-05-04" }];
      }
      if (sql.includes("FROM twitter_posts")) {
        return [{ tweet_id: "t1", title: "tw", author_handle: "x",
                  url: "u", posted_at: "2026-05-04", type: "content" }];
      }
      return [];
    });
    const res = await onRequestGet({
      env, request: new Request("https://x/api/group/plave"),
      params: { key: "plave" },
    } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.group_key).toBe("plave");
    expect(body.summary.yt_total_views).toBe(100);
    expect(body.health_score.grade).toBe("A");
    expect(body.yt_top15).toHaveLength(1);
    expect(body.community_top).toHaveLength(1);
    expect(body.naver_articles).toHaveLength(1);
    expect(body.twitter_posts).toHaveLength(1);
  });
});
