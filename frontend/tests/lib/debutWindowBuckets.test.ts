import { describe, expect, it } from "vitest";
import {
  WINDOW_SIZE,
  bucketIndexForAge,
  currentBucket,
  debutAgeDaysKST,
  displayBuckets,
  isValidBucketLabel,
  labelForIndex,
} from "../../functions/lib/debutWindowBuckets";

// worker bucket_for 와 같은 경계 fixture. worker 쪽은
// worker/tests/unit/test_debut_window.py 의 parametrize 가 같은 표를 핀
// (cross-language 가드 — 한쪽만 바꾸면 양쪽 테스트가 같이 깨져야 함).
const BOUNDARY_FIXTURE: Array<[number, string]> = [
  [-70, "D-60"], [-51, "D-60"],
  [-50, "D-40"], [-31, "D-40"],
  [-30, "D-20"], [-11, "D-20"],
  [-10, "D-Day"], [0, "D-Day"], [9, "D-Day"],
  [10, "D+20"], [29, "D+20"],
  [30, "D+40"], [49, "D+40"],
  [50, "D+60"], [69, "D+60"],
  [70, "D+80"], [89, "D+80"],
  [90, "D+100"], [200, "D+200"], [400, "D+400"],
];

describe("bucket arithmetic (worker bucket_for parity)", () => {
  it.each(BOUNDARY_FIXTURE)("day %i → %s", (day, label) => {
    expect(labelForIndex(bucketIndexForAge(day))).toBe(label);
  });

  it("currentBucket is the label of today's bucket", () => {
    expect(currentBucket(-5)).toBe("D-Day");
    expect(currentBucket(75)).toBe("D+80");
  });

  it("labelForIndex throws on negative or fractional index", () => {
    expect(() => labelForIndex(-1)).toThrow();
    expect(() => labelForIndex(0.5)).toThrow();
  });
});

describe("displayBuckets (rolling 7-bucket window)", () => {
  const FIXED = ["D-60", "D-40", "D-20", "D-Day", "D+20", "D+40", "D+60"];

  it("pre-debut and up to D+69 → fixed legacy window", () => {
    expect(displayBuckets(-100)).toEqual(FIXED);
    expect(displayBuckets(-5)).toEqual(FIXED);
    expect(displayBuckets(0)).toEqual(FIXED);
    expect(displayBuckets(69)).toEqual(FIXED);
  });

  it("D+70 → first slide (D-60 out, D+80 in)", () => {
    expect(displayBuckets(70)).toEqual(
      ["D-40", "D-20", "D-Day", "D+20", "D+40", "D+60", "D+80"],
    );
    expect(displayBuckets(89)).toEqual(displayBuckets(70));
  });

  it("D+130 → D-Day has rolled out", () => {
    expect(displayBuckets(130)).toEqual(
      ["D+20", "D+40", "D+60", "D+80", "D+100", "D+120", "D+140"],
    );
  });

  it("window is always WINDOW_SIZE consecutive buckets", () => {
    for (const age of [-50, 0, 69, 70, 150, 365]) {
      expect(displayBuckets(age)).toHaveLength(WINDOW_SIZE);
    }
  });
});

describe("isValidBucketLabel", () => {
  it("accepts named + arithmetic labels", () => {
    for (const l of ["D-60", "D-40", "D-20", "D-Day", "D+20", "D+80", "D+400"]) {
      expect(isValidBucketLabel(l)).toBe(true);
    }
  });
  it("rejects everything else", () => {
    for (const l of ["Post", "Pre", "Undated", "D+30", "D+0", "D-80", "D+20k", "", "x"]) {
      expect(isValidBucketLabel(l)).toBe(false);
    }
  });
});

describe("debutAgeDaysKST", () => {
  it("debut day itself in KST is age 0", () => {
    // 2026-06-16 00:30 KST = 2026-06-15T15:30Z
    expect(debutAgeDaysKST("2026-06-16", new Date("2026-06-15T15:30:00Z"))).toBe(0);
  });
  it("UTC date lag does not understate age (KST is the calendar)", () => {
    // 2026-06-17 08:00 KST = 2026-06-16T23:00Z — UTC 는 아직 16일이지만 KST 는 17일
    expect(debutAgeDaysKST("2026-06-16", new Date("2026-06-16T23:00:00Z"))).toBe(1);
  });
  it("pre-debut is negative", () => {
    expect(debutAgeDaysKST("2026-06-16", new Date("2026-06-11T03:00:00Z"))).toBe(-5);
  });
});
