import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/admin/status";

const HOUR = 3_600_000;
function isoAgo(h: number): string {
  return new Date(Date.now() - h * HOUR).toISOString();
}

const envWith = (h: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: h(sql) })),
    first: vi.fn(async () => h(sql)[0] ?? null),
  })) },
} as any);

describe("/api/admin/status", () => {
  it("rolls up to critical when a job failed", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM crawl_meta")) {
        return [
          { job: "youtube:plave", source: "youtube", group_key: "plave",
            expected_interval_h: 6, last_success_at: isoAgo(2),
            status: "ok", error_msg: null },
          { job: "dc:skinz", source: "dc", group_key: "skinz",
            expected_interval_h: 6, last_success_at: isoAgo(1),
            status: "failed", error_msg: "Timeout" },
        ];
      }
      if (sql.includes("FROM agg_summary") && sql.includes("MAX")) return [{ m: isoAgo(3) }];
      if (sql.includes("FROM alerts")) return [{ m: isoAgo(20) }];
      if (sql.includes("COUNT(*)")) return [{ videos: 100, snapshots: 5 }];
      return [];
    });
    const res = await onRequestGet({ env } as any);
    const b = await res.json() as any;
    expect(b.overall).toBe("critical");
    const failed = b.jobs.find((j: any) => j.job === "dc:skinz");
    expect(failed.state).toBe("failed");
  });

  it("flags a job stale when last success exceeds interval × 4", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM crawl_meta")) {
        return [
          // 6h interval → stale after 24h; 30h ago = stale.
          { job: "naver:owis", source: "naver", group_key: "owis",
            expected_interval_h: 6, last_success_at: isoAgo(30),
            status: "ok", error_msg: null },
        ];
      }
      return [];
    });
    const res = await onRequestGet({ env } as any);
    const b = await res.json() as any;
    expect(b.jobs[0].state).toBe("stale");
    expect(b.overall).toBe("warn");
  });

  it("is ok when every job is fresh", async () => {
    const env = envWith((sql) => {
      if (sql.includes("FROM crawl_meta")) {
        return [{ job: "youtube:plave", source: "youtube", group_key: "plave",
          expected_interval_h: 6, last_success_at: isoAgo(1),
          status: "ok", error_msg: null }];
      }
      return [];
    });
    const res = await onRequestGet({ env } as any);
    const b = await res.json() as any;
    expect(b.overall).toBe("ok");
  });
});
