import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/search";

const envWith = (h: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: h(sql) })),
  })) },
} as any);

describe("/api/search", () => {
  it("returns 400 when q is empty", async () => {
    const env = envWith(() => []);
    const r = await onRequestGet({ env, request: new Request("https://x/api/search") } as any);
    expect(r.status).toBe(400);
  });

  it("returns hits across categories", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM groups"))   return [{ key:"plave", name:"PLAVE", name_kr:"플레이브" }];
      if (sql.includes("FROM members"))  return [{ id: 1, name: "노아", group_key: "plave" }];
      if (sql.includes("FROM naver_articles"))  return [{ url: "u", title: "PLAVE 신곡" }];
      if (sql.includes("FROM community_posts")) return [{ url: "u", title: "플레이브 후기", platform: "dc" }];
      return [];
    });
    const r = await onRequestGet({
      env, request: new Request("https://x/api/search?q=plave"),
    } as any);
    const b = await r.json() as any;
    expect(b.groups).toHaveLength(1);
    expect(b.members).toHaveLength(1);
    expect(b.naver).toHaveLength(1);
    expect(b.community).toHaveLength(1);
  });
});
