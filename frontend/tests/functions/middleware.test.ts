import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../../functions/_middleware";
import { hmacSign } from "../../functions/lib/hmac";
import { dayBucket } from "../../functions/lib/cookies";

const ENV = { COOKIE_SECRET: "0123456789abcdef0123456789abcdef" } as any;

const next = vi.fn(async () => new Response("ok"));

function dbMock() {
  const run = vi.fn(async () => ({}));
  const bind = vi.fn(() => ({ run }));
  const prepare = vi.fn(() => ({ bind }));
  return { DB: { prepare }, run, bind, prepare };
}

describe("_middleware", () => {
  it("lets /__auth POST through without cookie", async () => {
    next.mockClear();
    const req = new Request("https://x/__auth", { method: "POST" });
    const res = await onRequest({ request: req, next, env: ENV } as any);
    expect(next).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("blocks /api/* without cookie with 401", async () => {
    next.mockClear();
    const req = new Request("https://x/api/ping");
    const res = await onRequest({ request: req, next, env: ENV } as any);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("allows /api/* with valid cookie", async () => {
    next.mockClear();
    const sig = await hmacSign(ENV.COOKIE_SECRET, `auth|${dayBucket()}`);
    const req = new Request("https://x/api/ping", {
      headers: { cookie: `idol_radar_auth=${sig}` },
    });
    const res = await onRequest({ request: req, next, env: ENV } as any);
    expect(next).toHaveBeenCalled();
  });

  it("rejects /api/* with forged cookie", async () => {
    next.mockClear();
    const req = new Request("https://x/api/ping", {
      headers: { cookie: "idol_radar_auth=deadbeef" },
    });
    const res = await onRequest({ request: req, next, env: ENV } as any);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("does NOT block static asset paths (only /api and /__auth go through here in this test)", async () => {
    next.mockClear();
    const req = new Request("https://x/somepage.html");
    const res = await onRequest({ request: req, next, env: ENV } as any);
    // Middleware lets static through; static is served by Pages directly.
    expect(next).toHaveBeenCalled();
  });
});

describe("_middleware access tracking", () => {
  it("sets a cid cookie when absent", async () => {
    next.mockClear();
    const res = await onRequest({
      request: new Request("https://x/somepage.html"),
      next,
      env: ENV,
    } as any);
    expect(res.headers.get("set-cookie") ?? "").toContain("idol_radar_cid=");
  });

  it("does NOT reset cid cookie when already present", async () => {
    next.mockClear();
    const res = await onRequest({
      request: new Request("https://x/somepage.html", {
        headers: { cookie: "idol_radar_cid=keep-me" },
      }),
      next,
      env: ENV,
    } as any);
    expect(res.headers.get("set-cookie") ?? "").not.toContain("idol_radar_cid=");
  });

  it("logs a visit on authed document load", async () => {
    next.mockClear();
    const db = dbMock();
    const sig = await hmacSign(ENV.COOKIE_SECRET, `auth|${dayBucket()}`);
    const tasks: Promise<unknown>[] = [];
    await onRequest({
      request: new Request("https://x/", {
        headers: {
          cookie: `idol_radar_auth=${sig}; idol_radar_cid=abc-123`,
          "sec-fetch-dest": "document",
        },
      }),
      next,
      env: { ...ENV, ...db },
      waitUntil: (p: Promise<unknown>) => tasks.push(p),
    } as any);
    await Promise.all(tasks);
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO access_log"),
    );
    expect(db.bind).toHaveBeenCalledWith("abc-123");
  });

  it("does NOT log for /api requests", async () => {
    next.mockClear();
    const db = dbMock();
    const sig = await hmacSign(ENV.COOKIE_SECRET, `auth|${dayBucket()}`);
    await onRequest({
      request: new Request("https://x/api/ping", {
        headers: { cookie: `idol_radar_auth=${sig}; idol_radar_cid=abc-123` },
      }),
      next,
      env: { ...ENV, ...db },
      waitUntil: (p: Promise<unknown>) => p,
    } as any);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("does NOT log on document load when unauthenticated", async () => {
    next.mockClear();
    const db = dbMock();
    await onRequest({
      request: new Request("https://x/", {
        headers: { "sec-fetch-dest": "document", cookie: "idol_radar_cid=abc-123" },
      }),
      next,
      env: { ...ENV, ...db },
      waitUntil: (p: Promise<unknown>) => p,
    } as any);
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
