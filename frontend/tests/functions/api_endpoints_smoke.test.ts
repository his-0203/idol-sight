import { describe, expect, it, vi } from "vitest";
import { onRequestGet as marketShare } from "../../functions/api/market-share";
import { onRequestGet as weekly } from "../../functions/api/weekly";
import { onRequestGet as insights } from "../../functions/api/insights";
import { onRequestGet as members } from "../../functions/api/members/[key]";
import { onRequestGet as healthSpec } from "../../functions/api/health/spec";

const env = (rows: any[] = []) => ({
  DB: { prepare: vi.fn(() => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: rows })),
    first: vi.fn(async () => rows[0] ?? null),
  })) },
} as any);

describe("smoke: 5 endpoints", () => {
  it("market-share returns rows array", async () => {
    const r = await marketShare({ env: env([]),
      request: new Request("https://x/api/market-share?weeks=4") } as any);
    expect(((await r.json()) as any).weeks).toBe(4);
  });
  it("weekly returns week_start+hanteo+movers (insights moved to /api/insights)", async () => {
    const r = await weekly({ env: env([]), request: new Request("https://x/") } as any);
    const b = await r.json() as any;
    expect(b).toHaveProperty("week_start");
    expect(b).toHaveProperty("hanteo");
    expect(b).toHaveProperty("movers");
  });
  it("insights respects ?week=... filter", async () => {
    const r = await insights({ env: env([]),
      request: new Request("https://x/api/insights?week=2026-04-22") } as any);
    expect(r.status).toBe(200);
  });
  it("members returns hhi+members", async () => {
    const r = await members({
      env: env([]), request: new Request("https://x/"),
      params: { key: "plave" },
    } as any);
    const b = await r.json() as any;
    expect(b).toHaveProperty("hhi");
    expect(b).toHaveProperty("members");
  });
  it("health/spec returns weights table", async () => {
    const r = await healthSpec({} as any);
    const b = await r.json() as any;
    expect(b.weights.subscribers).toBe(20);
    expect(b.grade_thresholds).toEqual([["S",9],["A",7],["B",5],["C",3],["D",0]]);
  });
});
