import { describe, expect, it } from "vitest";
import { liveDateIndex, monthMatrix } from "./liveChatCalendar";

describe("monthMatrix", () => {
  it("2026-06(0-based month=5) 는 일요일 시작 6주 격자, 1일은 월요일", () => {
    const weeks = monthMatrix(2026, 5);
    const first = weeks[0]!;
    expect(first).toHaveLength(7);
    // 2026-06-01 은 월요일 → 첫 주 [null(일), 2026-06-01(월), ...]
    expect(first[0]).toBeNull();
    expect(first[1]).toBe("2026-06-01");
    // 마지막 실제 날짜는 2026-06-30
    const flat = weeks.flat().filter(Boolean);
    expect(flat[0]).toBe("2026-06-01");
    expect(flat[flat.length - 1]).toBe("2026-06-30");
    expect(flat).toHaveLength(30);
  });

  it("모든 주는 7칸으로 패딩된다", () => {
    for (const w of monthMatrix(2026, 1)) expect(w).toHaveLength(7); // 2월
  });
});

describe("liveDateIndex", () => {
  it("ended_at(UTC) 을 KST 날짜로 묶어 Set + video_id 매핑을 만든다", () => {
    // 2026-06-16T16:00:00Z = KST 2026-06-17 01:00 → 17일로 잡혀야 함
    const idx = liveDateIndex([
      { video_id: "a", title: null, ended_at: "2026-06-16T16:00:00Z" },
      { video_id: "b", title: null, ended_at: "2026-06-10T05:00:00Z" },
    ]);
    expect(idx.dates.has("2026-06-17")).toBe(true);
    expect(idx.dates.has("2026-06-10")).toBe(true);
    expect(idx.byDate.get("2026-06-17")).toBe("a");
  });

  it("ended_at 누락은 무시", () => {
    const idx = liveDateIndex([{ video_id: "x", title: null, ended_at: null }]);
    expect(idx.dates.size).toBe(0);
  });
});
