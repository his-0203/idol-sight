import { describe, expect, it, beforeEach } from "vitest";
import { readState, writeState } from "../../src/router";

describe("router category param", () => {
  // vitest environment is "node" — no DOM. router.ts uses only location.hash
  // (get/set) + URLSearchParams, so a minimal mutable location shim suffices.
  beforeEach(() => { (globalThis as any).location = { hash: "" }; });

  it("defaults category to 'all'", () => {
    expect(readState().category).toBe("all");
  });

  it("round-trips a non-default category through the hash", () => {
    writeState({ tab: "market", category: "kpop" });
    expect(location.hash).toContain("category=kpop");
    expect(readState().category).toBe("kpop");
  });

  it("omits category from the hash when 'all' (default)", () => {
    writeState({ tab: "market", category: "all" });
    expect(location.hash).not.toContain("category=");
    expect(readState().category).toBe("all");
  });
});
