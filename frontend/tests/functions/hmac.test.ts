import { describe, expect, it } from "vitest";
import { hmacSign, hmacVerify } from "../../functions/lib/hmac";

describe("hmac", () => {
  it("sign produces stable hex with same secret + message", async () => {
    const a = await hmacSign("secret", "msg");
    const b = await hmacSign("secret", "msg");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verify accepts genuine signature", async () => {
    const sig = await hmacSign("k", "auth|2026-05-04");
    expect(await hmacVerify("k", sig, "auth|2026-05-04")).toBe(true);
  });

  it("verify rejects forged signature", async () => {
    const sig = await hmacSign("k", "auth|2026-05-04");
    expect(await hmacVerify("k", sig.replace(/.$/, "0"), "auth|2026-05-04")).toBe(false);
  });

  it("verify is timing-safe length-aware", async () => {
    expect(await hmacVerify("k", "deadbeef", "x")).toBe(false);
  });
});
