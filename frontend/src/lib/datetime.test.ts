import { describe, it, expect } from "vitest";
import { formatKSTMonthDayWeekday } from "./datetime";

describe("formatKSTMonthDayWeekday", () => {
  it("UTC 타임스탬프를 KST MM/DD 요일로", () => {
    // 2026-06-07T05:00:00Z = 2026-06-07 14:00 KST (일요일)
    expect(formatKSTMonthDayWeekday("2026-06-07T05:00:00Z")).toBe("06/07 일");
    // 2026-06-05T10:00:00Z = 2026-06-05 19:00 KST (금요일)
    expect(formatKSTMonthDayWeekday("2026-06-05T10:00:00Z")).toBe("06/05 금");
  });

  it("UTC 자정 경계가 KST 익일로 넘어감", () => {
    // 2026-06-07T15:30:00Z = 2026-06-08 00:30 KST (월요일)
    expect(formatKSTMonthDayWeekday("2026-06-07T15:30:00Z")).toBe("06/08 월");
  });

  it("SQLite naive datetime 도 UTC 로 해석", () => {
    // "2026-06-07 05:00:00" (naive) → UTC → 2026-06-07 14:00 KST (일)
    expect(formatKSTMonthDayWeekday("2026-06-07 05:00:00")).toBe("06/07 일");
  });

  it("null/빈 입력은 대시", () => {
    expect(formatKSTMonthDayWeekday(null)).toBe("—");
    expect(formatKSTMonthDayWeekday("")).toBe("—");
    expect(formatKSTMonthDayWeekday("nonsense")).toBe("—");
  });
});
