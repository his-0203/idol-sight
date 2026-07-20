import { describe, it, expect } from "vitest";
import { fmtAwareness, sortByAwareness, tableSortValue, awarenessDisplay, coreDisplay } from "./MarketOverview";

const g = (name: string, rank: number | null, score: number | null = rank) =>
  [name.toLowerCase(), { name, awareness: { score, category_rank: rank } }] as [string, any];

describe("fmtAwareness", () => {
  it("점수를 문자열로, null/undefined 는 '—'", () => {
    expect(fmtAwareness(87.4)).toBe("87.4");
    expect(fmtAwareness(0)).toBe("0");           // 0 점도 표시(falsy 가드)
    expect(fmtAwareness(null)).toBe("—");        // basis=insufficient
    expect(fmtAwareness(undefined)).toBe("—");   // awareness 행 없음
  });
});

describe("sortByAwareness", () => {
  it("category_rank 오름차순(1=최상위)", () => {
    const sorted = sortByAwareness([g("B", 2), g("A", 1), g("C", 3)]);
    expect(sorted.map(([k]) => k)).toEqual(["a", "b", "c"]);
  });
  it("순위 없는 그룹(insufficient/무행)은 맨 뒤로, 그다음 이름순", () => {
    const sorted = sortByAwareness([g("Zeta", null), g("Alpha", null), g("Ranked", 1)]);
    expect(sorted.map(([k]) => k)).toEqual(["ranked", "alpha", "zeta"]);
  });
  it("awareness 객체 자체가 없어도(=null) 안전하게 뒤로", () => {
    const noAw = ["nope", { name: "Nope" }] as [string, any];
    const sorted = sortByAwareness([noAw, g("Ranked", 2)]);
    expect(sorted.map(([k]) => k)).toEqual(["ranked", "nope"]);
  });
  it("입력 배열을 변형하지 않는다(순수)", () => {
    const input = [g("B", 2), g("A", 1)];
    const before = input.map(([k]) => k);
    sortByAwareness(input);
    expect(input.map(([k]) => k)).toEqual(before);
  });
});

describe("V2.53 organic trust display", () => {
  it("awarenessDisplay prefers adj and marks discounted", () => {
    expect(awarenessDisplay({ score: 76.1, category_rank: 3, score_adj: 38.4, category_rank_adj: 7, organic_confidence: 0.506 }))
      .toEqual({ score: 38.4, rank: 7, discounted: true });
  });
  it("awarenessDisplay falls back to raw when adj null (unmigrated)", () => {
    expect(awarenessDisplay({ score: 50, category_rank: 2, score_adj: null, category_rank_adj: null, organic_confidence: null }))
      .toEqual({ score: 50, rank: 2, discounted: false });
  });
  it("coreDisplay hides value on insufficient_organic", () => {
    expect(coreDisplay({ est_engaged_fans: 218, est_active_core: 18, est_engaged_fans_adj: null, est_active_core_adj: null, basis: "insufficient_organic" }))
      .toEqual({ value: null, insufficientOrganic: true });
  });
  it("coreDisplay prefers adj value", () => {
    expect(coreDisplay({ est_engaged_fans: 218, est_active_core: 18, est_engaged_fans_adj: 120, est_active_core_adj: 9, basis: "scored" }))
      .toEqual({ value: 120, insufficientOrganic: false });
  });
  it("tableSortValue awareness/core use adjusted values", () => {
    const g = { awareness: { score: 76.1, score_adj: 38.4 }, core_fan_estimate: { est_engaged_fans: 218, est_engaged_fans_adj: 120, basis: "scored" } };
    expect(tableSortValue("awareness", "k", g, {})).toBe(38.4);
    expect(tableSortValue("core", "k", g, {})).toBe(120);
  });
});
