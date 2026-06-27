import { describe, expect, it } from "vitest";
import { NAV_MODEL, isItemActive, type NavItem } from "../../src/lib/nav";

const item = (p: Partial<NavItem> & { tab: any }): NavItem => ({ label: "x", ...p });

describe("NAV_MODEL", () => {
  it("has the four intent groups in order", () => {
    expect(NAV_MODEL.map((g) => g.id)).toEqual(["pulse", "cohort", "miiwan", "system"]);
  });
  it("marks the MiiWAN group as own (privileged)", () => {
    expect(NAV_MODEL.find((g) => g.id === "miiwan")!.own).toBe(true);
  });
  it("cohort group carries kpop + subculture market items", () => {
    const cats = NAV_MODEL.find((g) => g.id === "cohort")!.items.map((i) => i.category);
    expect(cats).toEqual(["kpop", "subculture"]);
  });
});

describe("isItemActive", () => {
  it("non-market item active iff tab matches", () => {
    expect(isItemActive(item({ tab: "insights" }), { tab: "insights", category: "all" })).toBe(true);
    expect(isItemActive(item({ tab: "insights" }), { tab: "weekly", category: "all" })).toBe(false);
  });
  it("market item active requires matching category", () => {
    const kpop = item({ tab: "market", category: "kpop" });
    expect(isItemActive(kpop, { tab: "market", category: "kpop" })).toBe(true);
    expect(isItemActive(kpop, { tab: "market", category: "all" })).toBe(false);
  });
  it("market overview (no category) active only at category 'all'", () => {
    const overview = item({ tab: "market" });
    expect(isItemActive(overview, { tab: "market", category: "all" })).toBe(true);
    expect(isItemActive(overview, { tab: "market", category: "subculture" })).toBe(false);
  });
});
