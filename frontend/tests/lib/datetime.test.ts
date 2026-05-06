// Tests for the user-facing KST formatter helpers in src/lib/datetime.ts.
//
// Why these particular cases:
//   - 05:23 UTC ↔ 14:23 KST is the canonical "9-hour offset" sanity check.
//     Anything that breaks this regresses the entire user request.
//   - Pre-midnight UTC times (e.g. 22:00 UTC = 07:00 next-day KST) are
//     where naive `slice(0, 10)` formatting flips the calendar day; the
//     formatter must produce the *KST* day, not the UTC day.
//   - Bare `YYYY-MM-DD` inputs (event_date / week_start) round-trip as
//     date-only KST without spuriously rolling +/- a day.
//   - Relative phrases hit each band boundary so off-by-one rounding
//     surfaces immediately.

import { describe, expect, test } from "vitest";
import {
  formatKST,
  formatKSTDate,
  formatKSTRelative,
  todayKST,
  daysBetweenKST,
} from "../../src/lib/datetime";

describe("formatKST", () => {
  test("UTC ISO converts to KST wall clock with suffix", () => {
    // 05:23:45 UTC == 14:23 KST same day.
    expect(formatKST("2026-05-07T05:23:45Z")).toBe("2026-05-07 14:23 KST");
  });

  test("late-UTC roll forwards into next KST day", () => {
    // 22:00 UTC May 7 == 07:00 KST May 8.
    expect(formatKST("2026-05-07T22:00:00Z")).toBe("2026-05-08 07:00 KST");
  });

  test("date-only input renders as KST same calendar day", () => {
    // The implementation pins bare YYYY-MM-DD to noon UTC (21:00 KST)
    // so date-only inputs round-trip to the same calendar day in KST.
    expect(formatKST("2026-05-07")).toBe("2026-05-07 21:00 KST");
  });

  test("withTime: false drops time, keeps date in KST", () => {
    expect(formatKST("2026-05-07T22:00:00Z", { withTime: false })).toBe(
      "2026-05-08 KST",
    );
  });

  test("withSuffix: false drops the KST tag", () => {
    expect(formatKST("2026-05-07T05:23:45Z", { withSuffix: false })).toBe(
      "2026-05-07 14:23",
    );
  });

  test("null / undefined / empty render as em dash", () => {
    expect(formatKST(null)).toBe("—");
    expect(formatKST(undefined)).toBe("—");
    expect(formatKST("")).toBe("—");
  });

  test("SQLite-style 'YYYY-MM-DD HH:MM:SS' (no Z) is treated as UTC", () => {
    expect(formatKST("2026-05-07 05:23:45")).toBe("2026-05-07 14:23 KST");
  });
});

describe("formatKSTDate", () => {
  test("YYYY-MM-DD pass-through", () => {
    expect(formatKSTDate("2026-05-07")).toBe("2026-05-07");
  });

  test("UTC late-day rolls into KST next day", () => {
    expect(formatKSTDate("2026-05-07T22:00:00Z")).toBe("2026-05-08");
  });
});

describe("formatKSTRelative", () => {
  const NOW = Date.parse("2026-05-07T12:00:00Z"); // 21:00 KST

  test("< 60s → '방금 전'", () => {
    expect(formatKSTRelative("2026-05-07T11:59:30Z", { now: NOW })).toBe("방금 전");
  });

  test("minutes ago", () => {
    expect(formatKSTRelative("2026-05-07T11:55:00Z", { now: NOW })).toBe("5분 전");
  });

  test("hours ago", () => {
    expect(formatKSTRelative("2026-05-07T08:00:00Z", { now: NOW })).toBe("4시간 전");
  });

  test("days ago", () => {
    expect(formatKSTRelative("2026-05-04T12:00:00Z", { now: NOW })).toBe("3일 전");
  });

  test(">30d falls back to KST date", () => {
    expect(formatKSTRelative("2026-03-01T12:00:00Z", { now: NOW })).toBe(
      "2026-03-01",
    );
  });

  test("null → 마지막 갱신 없음", () => {
    expect(formatKSTRelative(null, { now: NOW })).toBe("마지막 갱신 없음");
  });
});

describe("todayKST", () => {
  test("matches KST calendar day for late-UTC moment", () => {
    // 22:00 UTC May 7 is already May 8 in KST.
    const lateUtc = Date.parse("2026-05-07T22:00:00Z");
    expect(todayKST(lateUtc)).toBe("2026-05-08");
  });
});

describe("daysBetweenKST", () => {
  test("future debut from KST today is positive", () => {
    const now = Date.parse("2026-05-07T03:00:00Z"); // 12:00 KST 2026-05-07
    expect(daysBetweenKST("2026-06-16", now)).toBe(40);
  });

  test("same-day in KST returns 0", () => {
    const now = Date.parse("2026-05-07T03:00:00Z");
    expect(daysBetweenKST("2026-05-07", now)).toBe(0);
  });

  test("past debut returns negative", () => {
    const now = Date.parse("2026-05-07T03:00:00Z");
    expect(daysBetweenKST("2026-05-01", now)).toBe(-6);
  });

  test("rollover: 22:00 UTC is already next day in KST", () => {
    const now = Date.parse("2026-05-07T22:00:00Z"); // 07:00 KST 2026-05-08
    // From KST 2026-05-08 → 2026-05-08 == 0 (not -1 like a UTC-naive impl).
    expect(daysBetweenKST("2026-05-08", now)).toBe(0);
  });
});
