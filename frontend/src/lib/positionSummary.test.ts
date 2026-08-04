import { describe, expect, it } from "vitest";
import { buildPositionSummary, type PositionSummaryInput } from "./positionSummary";
import type { MonthlyKpiRow } from "./miiwanKpi";

const kpiRow = (month: string, over: Partial<MonthlyKpiRow> = {}): MonthlyKpiRow => ({
  month, yt_subscribers: null, avg_ccv: null,
  weverse_members: null, weverse_membership: null, in_progress: false, ...over,
});

const base: PositionSummaryInput = {
  sovTier: 2, momentumGap: 0.8,
  quadrant: "niche", postureLabel: "유지", orgScore: 75,
  monthlyKpi: [
    kpiRow("2026-07", { yt_subscribers: 28600, avg_ccv: 369, weverse_members: 8447, weverse_membership: 111 }),
    kpiRow("2026-08", { yt_subscribers: 29000, in_progress: true }),
  ],
  riskLevel: "정상",
  strength: "동시기 대비 반응 밀도 1위",
};

describe("buildPositionSummary", () => {
  it("데이터가 다 있으면 5줄 — 위치·방향·KPI·팬덤·위기 순", () => {
    const lines = buildPositionSummary(base);
    expect(lines.map((l) => l.label)).toEqual(
      ["시장 위치", "성장 방향", "월간 KPI", "팬덤 질", "위기 상태"]);
    // v3.1: 헤드 = 사분면 판정 + 규모 티어. %·순위는 헤드라인에 없음
    // (은퇴 — 수치는 방향과 속도·시장 개요 상세에 잔존).
    expect(lines[0]!.text).toContain("좁지만 깊은 팬덤");
    expect(lines[0]!.text).toContain("추격 그룹");
    expect(lines[0]!.text).not.toMatch(/\d+위/);
    expect(lines[1]!.tone).toBe("good");          // momentumGap > 0.5 = 확대 국면
    expect(lines[4]!.tone).toBe("good");          // 정상
  });

  it("KPI 줄은 마지막 확정 월의 지표별 판정을 요약한다", () => {
    const kpi = buildPositionSummary(base).find((l) => l.label === "월간 KPI")!;
    // 2026-07 확정: 구독 28.6K<32K ⚠️ · 동접 369<700 ⚠️ · 위버스 8447>4600 🔵 · 멤버십 111>80 🔵
    expect(kpi.text).toContain("7월");
    expect(kpi.text).toContain("구독 ⚠️");
    expect(kpi.text).toContain("위버스 🔵");
    expect(kpi.tone).toBe("warn");                // 미달 지표 존재 → warn
  });

  it("결측 섹션은 줄을 생략한다 (가짜 수치 금지)", () => {
    const lines = buildPositionSummary({
      ...base, sovTier: null, quadrant: null,
      monthlyKpi: [], orgScore: null, strength: null, momentumGap: null,
      postureLabel: null,
    });
    expect(lines.map((l) => l.label)).toEqual(["위기 상태"]);
  });

  it("위기 주의/심각은 tone 이 warn/bad", () => {
    expect(buildPositionSummary({ ...base, riskLevel: "주의" }).at(-1)!.tone).toBe("warn");
    expect(buildPositionSummary({ ...base, riskLevel: "심각" }).at(-1)!.tone).toBe("bad");
  });

  it("자연 유입 40 미만이면 팬덤 질 tone 이 warn", () => {
    const fan = buildPositionSummary({ ...base, orgScore: 30 })
      .find((l) => l.label === "팬덤 질")!;
    expect(fan.tone).toBe("warn");
  });
});
