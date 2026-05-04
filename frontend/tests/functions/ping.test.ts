import { describe, expect, it } from "vitest";
import { onRequestGet } from "../../functions/api/ping";

describe("/api/ping", () => {
  it("returns ok text", async () => {
    const res = await onRequestGet({} as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
