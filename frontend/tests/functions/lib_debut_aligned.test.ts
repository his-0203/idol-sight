// frontend/tests/functions/lib_debut_aligned.test.ts
//
// 데뷔일 정렬 버킷팅 규칙 고정: (group, day_offset)당 MAX 값 유지
// (누적 지표는 단조증가 — 같은 날 backfill/live 혼재 시 큰 값이 신뢰값).
import { describe, expect, it } from "vitest";
import { alignByDebut } from "../../functions/lib/debutAligned";

const row = (over: Partial<Parameters<typeof alignByDebut>[0][number]>) => ({
  group_key: "g", debut_date: "2026-06-16", snapshot_at: "2026-06-16T09:00:00Z",
  value: 1, source: "live", ...over,
});

describe("alignByDebut", () => {
  it("day_offset = 스냅샷 날짜 - 데뷔일 (정수일)", () => {
    const out = alignByDebut([
      row({ snapshot_at: "2026-06-16T01:00:00Z", value: 10 }),
      row({ snapshot_at: "2026-06-26T23:00:00Z", value: 20 }),
    ], 0, 60);
    expect([...out.g!.keys()].sort((a, b) => a - b)).toEqual([0, 10]);
    expect(out.g!.get(10)).toEqual({ value: 20, source: "live" });
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
