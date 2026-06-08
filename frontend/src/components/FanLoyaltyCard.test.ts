import { describe, it, expect } from "vitest";
import { trendLabel, fmtPct } from "./FanLoyaltyCard";

describe("trendLabel", () => {
  it("rising/falling/flat/unknown 라벨", () => {
    expect(trendLabel("rising", 0.25)).toBe("▲ +25%");
    expect(trendLabel("falling", -0.3)).toBe("▼ -30%");
    expect(trendLabel("flat", 0.05)).toBe("→ 유지");
    expect(trendLabel("unknown", null)).toBe("추세 보류");
    expect(trendLabel("flat", -0.05)).toBe("→ 유지");      // 음수 flat 도 유지
    expect(trendLabel("unknown", 0.5)).toBe("추세 보류");   // pct 있어도 unknown 이면 보류
  });
});

describe("fmtPct", () => {
  it("전환율을 소수 1자리 %로", () => {
    expect(fmtPct(0.015)).toBe("1.5%");
    expect(fmtPct(0.0008)).toBe("0.1%");
    expect(fmtPct(null)).toBe("—");
  });
});
