// frontend/tests/functions/lib_debut_aligned.test.ts
//
// 데뷔일 정렬 버킷팅 규칙 고정: (group, day_offset)당 MAX 값 유지
// (누적 지표는 단조증가 — 같은 날 backfill/live 혼재 시 큰 값이 신뢰값).
// day_offset 의 달력 기준은 KST — debut_date·as_of_day 와 같은 관례여야
// 축·앵커가 하루 어긋나지 않는다.
import { describe, expect, it } from "vitest";
import { alignByDebut, dayOffsetKST } from "../../functions/lib/debutAligned";

const row = (over: Partial<Parameters<typeof alignByDebut>[0][number]>) => ({
  group_key: "g", debut_date: "2026-06-16", snapshot_at: "2026-06-16T09:00:00Z",
  value: 1, source: "live", ...over,
});

describe("dayOffsetKST", () => {
  it("KST 자정 경계 = 15:00Z — 이후 스냅샷은 다음날로 센다", () => {
    // 2026-06-16T14:59Z = KST 06-16 23:59 → D+0
    expect(dayOffsetKST("2026-06-16T14:59:00Z", "2026-06-16")).toBe(0);
    // 2026-06-16T15:30Z = KST 06-17 00:30 → D+1
    expect(dayOffsetKST("2026-06-16T15:30:00Z", "2026-06-16")).toBe(1);
  });

  it("파싱 불가한 타임스탬프·데뷔일은 null (NaN 버킷 키 방지)", () => {
    expect(dayOffsetKST("not-a-date", "2026-06-16")).toBeNull();
    expect(dayOffsetKST("2026-06-16T00:00:00Z", "nope")).toBeNull();
  });
});

describe("alignByDebut", () => {
  it("day_offset = 스냅샷의 KST 달력일 - 데뷔일 (정수일)", () => {
    const out = alignByDebut([
      row({ snapshot_at: "2026-06-16T01:00:00Z", value: 10 }),  // KST 06-16 → 0
      row({ snapshot_at: "2026-06-26T23:00:00Z", value: 20 }),  // KST 06-27 → 11
    ], 0, 60);
    expect([...out.g!.keys()].sort((a, b) => a - b)).toEqual([0, 11]);
    expect(out.g!.get(11)).toEqual({ value: 20, source: "live" });
  });

  it("KST 경계를 넘는 스냅샷은 다음 day_offset 버킷으로 간다", () => {
    const out = alignByDebut([
      row({ snapshot_at: "2026-06-16T14:59:00Z", value: 10 }),
      row({ snapshot_at: "2026-06-16T15:30:00Z", value: 20 }),
    ], 0, 60);
    expect(out.g!.get(0)).toEqual({ value: 10, source: "live" });
    expect(out.g!.get(1)).toEqual({ value: 20, source: "live" });
  });

  it("파싱 불가한 snapshot_at 행은 제외 (NaN 키 금지)", () => {
    const out = alignByDebut([row({ snapshot_at: "garbage" })], 0, 60);
    expect(Object.keys(out)).toEqual([]);
  });

  it("같은 날 여러 스냅샷이면 MAX 값을 유지", () => {
    const out = alignByDebut([
      row({ value: 100, source: "live" }),
      row({ value: 900, source: "backfill_estimate" }),
      row({ value: 500, source: "live" }),
    ], 0, 60);
    expect(out.g!.get(0)).toEqual({ value: 900, source: "backfill_estimate" });
  });

  it("debut_date null / value null / 범위 밖 행은 제외", () => {
    const out = alignByDebut([
      row({ group_key: "a", debut_date: null }),
      row({ group_key: "b", value: null }),
      row({ group_key: "c", snapshot_at: "2027-06-16T00:00:00Z" }), // D+365 > to
    ], 0, 60);
    expect(Object.keys(out)).toEqual([]);
  });
});
