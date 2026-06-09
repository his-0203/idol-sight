import { describe, it, expect } from "vitest";
import { trendLabel, fmtPct, barWidthPct, medianRowIndex } from "./FanLoyaltyCard";

type B = { video_id: string; peak: number; last_at: string };
const b = (peak: number): B => ({ video_id: `v${peak}`, peak, last_at: "2026-06-07T05:00:00Z" });

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

describe("barWidthPct", () => {
  it("max 기준 정규화 0~100", () => {
    expect(barWidthPct(1620, 1620)).toBe(100);
    expect(barWidthPct(810, 1620)).toBe(50);
    expect(barWidthPct(0, 1620)).toBe(0);
  });
  it("max 가 0/음수면 0 (0 나눗셈 가드)", () => {
    expect(barWidthPct(100, 0)).toBe(0);
    expect(barWidthPct(100, -5)).toBe(0);
  });
});

describe("medianRowIndex", () => {
  // broadcasts 는 최신-위 순서(렌더 순서)로 전달된다고 가정
  it("홀수 개수: peak_ccv_median 최근접 행", () => {
    // 값 [1620,1180,1050,910,820], median=1050 → index 2
    const rows = [b(1620), b(1180), b(1050), b(910), b(820)];
    expect(medianRowIndex(rows, 1050)).toBe(2);
  });
  it("median 값이 어떤 행과도 정확히 안 맞으면 가장 가까운 행", () => {
    const rows = [b(1620), b(1180), b(1050), b(910), b(820)];
    expect(medianRowIndex(rows, 1000)).toBe(2); // 1050 이 1000 에 가장 가까움
  });
  it("동률이면 첫(최신) 행", () => {
    const rows = [b(900), b(900), b(900)];
    expect(medianRowIndex(rows, 900)).toBe(0);
  });
  it("방송 3회 미만이면 null", () => {
    expect(medianRowIndex([b(900), b(800)], 850)).toBeNull();
    expect(medianRowIndex([b(900)], 900)).toBeNull();
  });
  it("peakMedian 이 null 이면 null", () => {
    const rows = [b(1620), b(1180), b(1050)];
    expect(medianRowIndex(rows, null)).toBeNull();
  });
});
