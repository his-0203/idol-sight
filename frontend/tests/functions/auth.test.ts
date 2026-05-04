import { describe, expect, it } from "vitest";
import { onRequestPost } from "../../functions/__auth";
import { computePasswordHash } from "../../functions/lib/hmac";

function makeEnv(hash: string, secret = "0123456789abcdef0123456789abcdef") {
  return { SITE_PASSWORD_HASH: hash, COOKIE_SECRET: secret } as any;
}

async function makeReq(password: string) {
  const fd = new FormData();
  fd.set("password", password);
  return new Request("https://x/__auth", { method: "POST", body: fd });
}

describe("__auth", () => {
  it("redirects with set-cookie on correct password", async () => {
    const hash = await computePasswordHash("Virtual2026");
    const res = await onRequestPost({ request: await makeReq("Virtual2026"), env: makeEnv(hash) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const cookie = res.headers.get("Set-Cookie") || "";
    expect(cookie).toMatch(/^idol_radar_auth=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("redirects to /?err=1 on wrong password", async () => {
    const hash = await computePasswordHash("Virtual2026");
    const res = await onRequestPost({ request: await makeReq("nope"), env: makeEnv(hash) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?err=1");
  });
});
