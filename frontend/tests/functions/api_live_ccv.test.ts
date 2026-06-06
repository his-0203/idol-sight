import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/live-ccv";

const envWith = (h: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: h(sql) })),
  })) },
} as any);

describe("/api/live-ccv", () => {
  it("returns latest-broadcast peak/avg per group with samples", async () => {
    const env = envWith((sql) => {
      if (sql.includes("GROUP BY group_key, video_id")) {
        return [
          { group_key: "miiwan", video_id: "v1", title: "데뷔", peak: 1500,
            avg: 1200.4, n: 5, last_at: "2026-06-06T13:00:00Z" },
          { group_key: "miiwan", video_id: "v0", title: "이전", peak: 800,
            avg: 700, n: 3, last_at: "2026-06-01T13:00:00Z" },
        ];
      }
      if (sql.includes("ORDER BY sampled_at")) {
        return [
          { video_id: "v1", sampled_at: "2026-06-06T12:30:00Z", concurrent_viewers: 900 },
          { video_id: "v1", sampled_at: "2026-06-06T13:00:00Z", concurrent_viewers: 1500 },
        ];
      }
      return [];
    });
    const res = await onRequestGet({ env } as any);
    const b = await res.json() as any;
    expect(b.groups).toHaveLength(1);
    expect(b.groups[0].video_id).toBe("v1");
    expect(b.groups[0].peak).toBe(1500);
    expect(b.groups[0].avg).toBe(1200);            // 1200.4 → Math.round
    expect(b.groups[0].samples).toHaveLength(2);
  });

  it("returns empty groups gracefully", async () => {
    const res = await onRequestGet({ env: envWith(() => []) } as any);
    const b = await res.json() as any;
    expect(b.groups).toEqual([]);
  });

  it("degrades to empty when the table is missing (pre-migration)", async () => {
    const env = {
      DB: { prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn(async () => { throw new Error("no such table: live_ccv_samples"); }),
      })) },
    } as any;
    const res = await onRequestGet({ env } as any);
    const b = await res.json() as any;
    expect(b.groups).toEqual([]);
  });
});
