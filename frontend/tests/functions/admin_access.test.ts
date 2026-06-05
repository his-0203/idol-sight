import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/admin/access";

const ADMIN_KEY = "s3cret-admin-key";

const envWith = (h: (sql: string) => any[], adminKey: string | undefined = ADMIN_KEY) =>
  ({
    ADMIN_KEY: adminKey,
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn(async () => ({ results: h(sql) })),
        first: vi.fn(async () => h(sql)[0] ?? null),
      })),
    },
  }) as any;

const rows = (sql: string) => {
  if (sql.includes("COUNT(DISTINCT client_id)")) {
    return [{ wk: "2026-22", visitors: 12, hits: 80 }];
  }
  if (sql.includes("GROUP BY client_id")) {
    return [{ client_id: "abc123def-456-789", hits: 9 }];
  }
  return [];
};

// adminKey: env 의 ADMIN_KEY 값. "" 를 넘기면 env 미설정(falsy) 상황을 재현.
const call = (key: string | null, adminKey: string = ADMIN_KEY) =>
  onRequestGet({
    env: envWith(rows, adminKey),
    request: new Request(
      `https://x/admin/access${key === null ? "" : `?key=${encodeURIComponent(key)}`}`,
    ),
  } as any);

describe("/admin/access", () => {
  it("404 when key missing", async () => {
    expect((await call(null)).status).toBe(404);
  });
  it("404 when key wrong", async () => {
    expect((await call("nope")).status).toBe(404);
  });
  it("404 when ADMIN_KEY env unset (even with a key)", async () => {
    expect((await call(ADMIN_KEY, "")).status).toBe(404);
  });
  it("200 + HTML with stats when key correct", async () => {
    const res = await call(ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("2026-22");
    expect(body).toContain("12");
    expect(body).toContain("#abc123");
    expect(body).toContain("9");
  });
});
