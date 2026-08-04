import { describe, expect, it } from "vitest";
import {
  bandVerdict, buildKpiTable, officialProgress,
  KPI_METRICS, PACE_BANDS, type MonthlyKpiRow,
} from "./miiwanKpi";

const row = (month: string, over: Partial<MonthlyKpiRow> = {}): MonthlyKpiRow => ({
  month, yt_subscribers: null, avg_ccv: null,
  weverse_members: null, weverse_membership: null, in_progress: false, ...over,
});

describe("bandVerdict", () => {
  it("경계 포함 판정", () => {
    expect(bandVerdict(31999, [32000, 35000])).toBe("below");
    expect(bandVerdict(32000, [32000, 35000])).toBe("within");
    expect(bandVerdict(35000, [32000, 35000])).toBe("within");
    expect(bandVerdict(35001, [32000, 35000])).toBe("above");
  });
});

describe("buildKpiTable", () => {
  it("과거 월엔 판정, 당월엔 in_progress, 미래 월엔 밴드만", () => {
    const table = buildKpiTable([
      row("2026-06", { yt_subscribers: 27900 }),
      row("2026-07", { yt_subscribers: 28600 }),
      row("2026-08", { yt_subscribers: 29000, in_progress: true }),
    ]);
    const subs = table.find((r) => r.metric === "subscribers")!;
    const jun = subs.cells.find((c) => c.month === "2026-06")!;
    expect(jun.actual).toBe(27900);
    expect(jun.band).toBeNull();      // 6월 = 실측 기점, 밴드 없음
    expect(jun.verdict).toBeNull();
    const jul = subs.cells.find((c) => c.month === "2026-07")!;
    expect(jul.verdict).toBe("below"); // 28.6K < 32K
    const aug = subs.cells.find((c) => c.month === "2026-08")!;
    expect(aug.inProgress).toBe(true);
    expect(aug.verdict).toBeNull();    // 진행 중엔 판정 유보
    const dec = subs.cells.find((c) => c.month === "2026-12")!;
    expect(dec.actual).toBeNull();
    expect(dec.band).toEqual(PACE_BANDS["2026-12"]!.subscribers);
  });

  it("지표 4개 × 6~12월 셀을 항상 생성", () => {
    const table = buildKpiTable([]);
    expect(table.map((r) => r.metric)).toEqual([...KPI_METRICS]);
    for (const r of table) expect(r.cells).toHaveLength(7);
  });
});

describe("officialProgress", () => {
  it("최신 실측 대비 달성률", () => {
    const prog = officialProgress([
      row("2026-07", { yt_subscribers: 28600, avg_ccv: 369 }),
    ]);
    const aug = prog[0]!;
    expect(aug.label).toContain("8월");
    const subs = aug.items.find((i) => i.metric === "subscribers")!;
    expect(subs.actual).toBe(28600);
    expect(subs.target).toBe(30000);
    expect(subs.pct).toBe(95);
  });
});
