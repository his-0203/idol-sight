import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../../functions/_middleware";
import { hmacSign } from "../../functions/lib/hmac";
import { dayBucket } from "../../functions/lib/cookies";

const ENV = { COOKIE_SECRET: "0123456789abcdef0123456789abcdef" } as any;

const next = vi.fn(async () => new Response("ok"));

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
