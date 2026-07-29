// frontend/tests/functions/lib_cohort_report.test.ts
//
// 투자사 보고에 들어가는 수치라 계산 규칙을 테스트로 고정한다:
// 인덱스 = D0 기준값 100 정규화, 성장배수 = D+N/D0, 순위 = 내림차순.
import { describe, expect, it } from "vitest";
import {
  baseValueAt, indexCurve, growthMultiple, rankOf,
} from "../../functions/lib/cohortReport";

const pts = (entries: Array<[number, number, string?]>) =>
  new Map(entries.map(([d, v, s]) => [d, { value: v, source: s ?? "live" }]));

describe("baseValueAt", () => {
  it("targetDay 정확 일치 우선, 없으면 윈도 내 최근접(동률은 이른 날)", () => {
    expect(baseValueAt(pts([[0, 10]]), 0, 3)).toEqual({ day: 0, value: 10, source: "live" });
    expect(baseValueAt(pts([[-2, 5], [2, 7]]), 0, 3)!.day).toBe(-2); // |−2|=|2| → 이른 날
    expect(baseValueAt(pts([[5, 9]]), 0, 3)).toBeNull(); // 윈도 밖
  });
});

describe("indexCurve", () => {
  it("D0=100 정규화, day 0..asOfDay만 포함", () => {
    const out = indexCurve(pts([[-5, 999], [0, 200], [10, 300], [43, 500], [60, 900]]), 43).curve!;
    expect(out[0]).toEqual({ day: 0, index: 100, source: "live" });
    expect(out.find((p) => p.day === 10)!.index).toBe(150);
    expect(out.find((p) => p.day === 43)!.index).toBe(250);
    expect(out.some((p) => p.day < 0 || p.day > 43)).toBe(false);
  });
  it("기준점이 음수일이면 곡선도 그 날부터 (합성 D0 포인트 만들지 않음)", () => {
    const out = indexCurve(pts([[-2, 50], [10, 100]]), 43).curve!;
    expect(out[0]).toEqual({ day: -2, index: 100, source: "live" });
    expect(out.some((p) => p.day === 0)).toBe(false); // D0 스냅샷 없음 → 합성 금지
    expect(out.find((p) => p.day === 10)!.index).toBe(200);
  });
  it("D0 기준값 없음/0이면 no_d0_baseline (가짜 수치 생성 금지)", () => {
    expect(indexCurve(pts([[20, 300]]), 43)).toEqual({ curve: null, reason: "no_d0_baseline" });
    expect(indexCurve(pts([[0, 0], [10, 5]]), 43))
      .toEqual({ curve: null, reason: "no_d0_baseline" });
  });
  it("기준값은 있는데 창 안에 점이 없으면 empty_window (두 사유를 뭉치지 않음)", () => {
    // 기준값은 D+2 (D0±3 안) 인데 asOfDay=1 이라 fromDay..asOfDay 창이 빈다.
    const out = indexCurve(pts([[2, 500]]), 1);
    expect(out).toEqual({ curve: null, reason: "empty_window" });
  });
});

describe("growthMultiple", () => {
  it("D+asOfDay 최근접값 / D0 기준값", () => {
    expect(growthMultiple(pts([[0, 100], [42, 350]]), 43)).toBeCloseTo(3.5);
  });
  it("기준 또는 도달값 없으면 null", () => {
    expect(growthMultiple(pts([[0, 100]]), 43)).toBeNull(); // D+43 근방 없음
    expect(growthMultiple(pts([[43, 100]]), 43)).toBeNull(); // D0 없음
  });
});

describe("rankOf", () => {
  it("내림차순 1-based: 나보다 큰 값 개수 + 1", () => {
    expect(rankOf(3.5, [1.2, 5.0, 2.0])).toBe(2);
    expect(rankOf(9, [1, 2])).toBe(1);
    expect(rankOf(1, [2, 3, 4])).toBe(4);
  });
});
