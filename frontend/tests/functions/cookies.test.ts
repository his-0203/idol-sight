import { describe, expect, it } from "vitest";
import { getCookie, dayBucket } from "../../functions/lib/cookies";

describe("cookies", () => {
  it("getCookie returns value when present", () => {
    const req = new Request("http://x/", {
      headers: { cookie: "a=1; idol_radar_auth=abc; b=2" },
    });
    expect(getCookie(req, "idol_radar_auth")).toBe("abc");
  });

  it("getCookie returns null when missing", () => {
    const req = new Request("http://x/");
    expect(getCookie(req, "idol_radar_auth")).toBeNull();
  });

  it("dayBucket returns YYYY-MM-DD UTC", () => {
    const v = dayBucket(new Date("2026-05-04T23:00:00Z"));
    expect(v).toBe("2026-05-04");
  });
});
