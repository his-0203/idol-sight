import { describe, expect, test } from "vitest";
import {
  daysSince, isFresh, velocityEligible, sortShorts,
  FRESH_DAYS, FRESH_VELOCITY, MIN_VIEWS_FLOOR, type TrendShort,
} from "../../src/lib/shortsTrend";

const NOW = Date.parse("2026-06-02T00:00:00Z");

function row(over: Partial<TrendShort>): TrendShort {
  return {
    video_id: "x", group_key: "plave", group_name_kr: "플레이브",
    title: "t", content_type: "Dance", published_at: "2026-05-30T00:00:00Z",
    views: 100000, likes: 0, comments: 0,
    view_count_24h: 50000, viral_velocity_ratio: 3.0, ...over,
  };
}

describe("daysSince", () => {
  test("UTC ISO 와 SQLite 공백 포맷 모두 처리", () => {
    expect(daysSince("2026-05-30T00:00:00Z", NOW)).toBe(3);
    expect(daysSince("2026-05-30 00:00:00", NOW)).toBe(3);
    expect(daysSince(null, NOW)).toBeNull();
  });
});

describe("isFresh", () => {
  test("최근 + 고velocity → true", () => {
    expect(isFresh(row({ published_at: "2026-05-30T00:00:00Z", viral_velocity_ratio: 2.5 }), NOW)).toBe(true);
  });
  test("오래됨 → false", () => {
    expect(isFresh(row({ published_at: "2026-04-01T00:00:00Z", viral_velocity_ratio: 9 }), NOW)).toBe(false);
  });
  test("velocity 낮음 → false", () => {
    expect(isFresh(row({ viral_velocity_ratio: 1.0 }), NOW)).toBe(false);
  });
});

describe("velocityEligible — 노이즈 floor", () => {
  test("floor 미만 조회 → 제외", () => {
    expect(velocityEligible(row({ views: MIN_VIEWS_FLOOR - 1 }))).toBe(false);
    expect(velocityEligible(row({ views: MIN_VIEWS_FLOOR }))).toBe(true);
    expect(velocityEligible(row({ viral_velocity_ratio: null }))).toBe(false);
  });
});

describe("sortShorts", () => {
  const fresh = row({ video_id: "fresh", published_at: "2026-05-30T00:00:00Z", viral_velocity_ratio: 5, views: 100000 });
  const old = row({ video_id: "old", published_at: "2026-04-01T00:00:00Z", viral_velocity_ratio: 9, views: 100000 });
  const tiny = row({ video_id: "tiny", views: 100, viral_velocity_ratio: 50 });

  test("fresh 정렬: 신선 영상이 위로", () => {
    const out = sortShorts([old, fresh], "fresh", NOW);
    expect(out[0]!.video_id).toBe("fresh");
  });
  test("velocity 정렬: floor 미만(tiny)은 뒤로", () => {
    const out = sortShorts([tiny, fresh], "velocity", NOW);
    expect(out[0]!.video_id).toBe("fresh");
    expect(out[1]!.video_id).toBe("tiny");
  });
  test("views 정렬 내림차순", () => {
    const a = row({ video_id: "a", views: 10 });
    const b = row({ video_id: "b", views: 999 });
    expect(sortShorts([a, b], "views", NOW)[0]!.video_id).toBe("b");
  });
});
