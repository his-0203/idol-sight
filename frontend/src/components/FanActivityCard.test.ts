// frontend/src/components/FanActivityCard.test.ts
//
// FanActivityCard 의 순수 포맷/막대 헬퍼 단위 검증 (FanLoyaltyCard.test.ts 미러).
// JSX 렌더는 검증하지 않고 export 헬퍼만 — environment:node 컨벤션 유지.

import { describe, it, expect } from "vitest";
import { fmtRate, fmtInt, fmtDecimal, barWidthPct } from "./FanActivityCard";

describe("fmtRate", () => {
  it("비율을 소수 1자리 %로", () => {
    expect(fmtRate(0.635)).toBe("63.5%");
    expect(fmtRate(0.0008)).toBe("0.1%");
    expect(fmtRate(null)).toBe("—");
    expect(fmtRate(undefined)).toBe("—");
  });
});

describe("fmtInt", () => {
  it("반올림 정수, null/undefined 는 대시", () => {
    expect(fmtInt(99.4)).toBe("99");
    expect(fmtInt(99.5)).toBe("100");   // est_active_core 등 x.5 median 가드
    expect(fmtInt(0)).toBe("0");
    expect(fmtInt(null)).toBe("—");
    expect(fmtInt(undefined)).toBe("—");
  });
});

describe("fmtDecimal", () => {
  it("소수 1자리, null 은 대시", () => {
    expect(fmtDecimal(60.49)).toBe("60.5");
    expect(fmtDecimal(7)).toBe("7.0");
    expect(fmtDecimal(null)).toBe("—");
  });
});

describe("barWidthPct", () => {
  it("max 기준 0~100 정규화", () => {
    expect(barWidthPct(99, 99)).toBe(100);
    expect(barWidthPct(49.5, 99)).toBe(50);
    expect(barWidthPct(0, 99)).toBe(0);
  });
  it("max 가 0/음수면 0 (0 나눗셈 가드)", () => {
    expect(barWidthPct(10, 0)).toBe(0);
    expect(barWidthPct(10, -3)).toBe(0);
  });
});
