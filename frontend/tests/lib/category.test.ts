import { describe, expect, it } from "vitest";
import { categoryOf, groupsByCategory } from "../../src/lib/category";

describe("categoryOf", () => {
  it("maps segmentary/confederation to subculture", () => {
    expect(categoryOf("segmentary")).toBe("subculture");
    expect(categoryOf("confederation")).toBe("subculture");
  });
  it("maps corporate / unknown / null to kpop", () => {
    expect(categoryOf("corporate")).toBe("kpop");
    expect(categoryOf(null)).toBe("kpop");
    expect(categoryOf(undefined)).toBe("kpop");
    expect(categoryOf("weird")).toBe("kpop");
  });
});

describe("groupsByCategory", () => {
  it("splits groups into kpop/subculture, preserving input order", () => {
    const out = groupsByCategory([
      { key: "plave", name: "PLAVE", group_model: "corporate" },
      { key: "isedol", name: "ISEGYE", group_model: "confederation" },
      { key: "miiwan", name: "MiiWAN", group_model: "corporate" },
      { key: "stellive", name: "StelLive", group_model: "confederation" },
    ]);
    expect(out.kpop.map((g) => g.key)).toEqual(["plave", "miiwan"]);
    expect(out.subculture.map((g) => g.key)).toEqual(["isedol", "stellive"]);
    expect(out.kpop[0]!.category).toBe("kpop");
    expect(out.subculture[0]!.category).toBe("subculture");
  });
  it("treats missing group_model as kpop", () => {
    const out = groupsByCategory([{ key: "x", name: "X" }]);
    expect(out.kpop.map((g) => g.key)).toEqual(["x"]);
    expect(out.subculture).toEqual([]);
  });
});
