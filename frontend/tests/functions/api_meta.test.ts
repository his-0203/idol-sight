import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/meta";

function envWithRows(rows: any[]) {
  const stmt = { bind: vi.fn().mockReturnThis(), all: vi.fn(async () => ({ results: rows })) };
  return { DB: { prepare: vi.fn(() => stmt) } } as any;
}

describe("/api/meta", () => {
  it("returns by_job + global_last_success_at", async () => {
    const env = envWithRows([
      { job: "naver:plave", last_success_at: "2026-05-04T14:00:00Z",
        expected_interval_h: 1, status: "ok", error_msg: null },
      { job: "dc:bdawn", last_success_at: "2026-05-04T08:00:00Z",
        expected_interval_h: 6, status: "failed", error_msg: "cf 403" },
    ]);
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.by_job).toHaveLength(2);
    expect(body.global_last_success_at).toBe("2026-05-04T14:00:00Z");   // newest
  });

  it("global_last_success_at is null when no rows", async () => {
    const env = envWithRows([]);
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.by_job).toEqual([]);
    expect(body.global_last_success_at).toBeNull();
  });
});
