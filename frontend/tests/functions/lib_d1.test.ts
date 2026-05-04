import { describe, expect, it, vi } from "vitest";
import { d1Query, d1QueryOne } from "../../functions/lib/d1";
import { jsonResponse } from "../../functions/lib/jsonResponse";

function fakeDb(rows: any[]) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: rows })),
    first: vi.fn(async () => rows[0] ?? null),
  };
  return { prepare: vi.fn(() => stmt), _stmt: stmt } as any;
}

describe("d1 wrappers", () => {
  it("d1Query binds params and returns rows", async () => {
    const db = fakeDb([{ a: 1 }, { a: 2 }]);
    const rows = await d1Query<{ a: number }>(db, "SELECT a FROM t WHERE x=?", ["x"]);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(db.prepare).toHaveBeenCalledWith("SELECT a FROM t WHERE x=?");
    expect(db._stmt.bind).toHaveBeenCalledWith("x");
  });

  it("d1QueryOne returns first row or null", async () => {
    const db = fakeDb([{ a: 7 }]);
    expect(await d1QueryOne(db, "SELECT 1")).toEqual({ a: 7 });
    const empty = fakeDb([]);
    expect(await d1QueryOne(empty, "SELECT 1")).toBeNull();
  });
});

describe("jsonResponse", () => {
  it("returns 200 application/json", async () => {
    const r = jsonResponse({ ok: 1 });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.json()).toEqual({ ok: 1 });
  });

  it("respects status override", () => {
    expect(jsonResponse({ x: 1 }, 404).status).toBe(404);
  });

  it("sets Cache-Control: no-store by default", () => {
    expect(jsonResponse({}).headers.get("cache-control")).toBe("no-store");
  });
});
