import { describe, it, expect } from "vitest";
import { fmtAwareness, sortByAwareness } from "./MarketOverview";

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
