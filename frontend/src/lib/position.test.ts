import { describe, expect, it } from "vitest";
import {
  ageLabel, cohortForecast, demographicBars, momentumLine, sovPosition,
  subSplitLine, topCountriesLine, topDemographicLine,
  type DemographicRow, type ForwardData, type ShareRow,
} from "./position";

const row = (week_end: string, group_key: string, final: number, mom = final, cum = final): ShareRow =>
  ({ week_start: week_end, week_end, group_key, final, mom, cum });

const KPOP = new Set(["miiwan", "plave", "owis"]);

describe("sovPosition", () => {
  it("최신 완결주의 점유율·순위·모수를 K-POP 집합으로 한정해 계산한다", () => {
    const rows = [
      row("2026-07-25", "miiwan", 8), row("2026-07-25", "plave", 60), row("2026-07-25", "owis", 12),
      row("2026-08-01", "miiwan", 10), row("2026-08-01", "plave", 58), row("2026-08-01", "owis", 11),
      // 서브컬처 그룹은 집합 밖 → 순위 모수에서 제외
      row("2026-08-01", "isedol", 40),
    ];
    const p = sovPosition(rows, KPOP);
    expect(p.share).toBe(10);
    expect(p.rank).toBe(3);
    expect(p.teamCount).toBe(3);
    expect(p.deltaPp).toBe(2);
    expect(p.series).toEqual([8, 10]);
  });

  it("전주 데이터가 없으면 deltaPp=null, 빈 입력이면 전부 null/빈 배열", () => {
    const one = sovPosition([row("2026-08-01", "miiwan", 10)], KPOP);
    expect(one.deltaPp).toBeNull();
    expect(one.rank).toBe(1);
    const none = sovPosition([], KPOP);
    expect(none.share).toBeNull();
    expect(none.series).toEqual([]);
  });

  it("momentumGap = 최신 주 mom − cum", () => {
    const rows = [row("2026-08-01", "miiwan", 10, 14, 9)];
    expect(sovPosition(rows, KPOP).momentumGap).toBe(5);
  });
});

describe("momentumLine", () => {
  it("±0.5pp 임계로 확대/방어/유지를 가른다", () => {
    expect(momentumLine(2)).toContain("확대");
    expect(momentumLine(-2)).toContain("방어");
    expect(momentumLine(0.2)).toContain("비슷한 페이스");
    expect(momentumLine(null)).toBeNull();
  });
});

describe("demographics", () => {
  const rows: DemographicRow[] = [
    { age_group: "age18-24", gender: "female", viewer_pct: 32 },
    { age_group: "age18-24", gender: "male", viewer_pct: 11 },
    { age_group: "age25-34", gender: "female", viewer_pct: 20 },
    { age_group: "age13-17", gender: "female", viewer_pct: 8 },
    { age_group: "age65-", gender: "user_specified", viewer_pct: 1 },
    { age_group: "age35-44", gender: "male", viewer_pct: 0 },   // 0 → 제외
    { age_group: "age45-54", gender: "male", viewer_pct: null }, // null → 제외
  ];

  it("ageLabel — 'age18-24'→'18-24', 'age65-'→'65+', 미지 형식 원문 유지", () => {
    expect(ageLabel("age18-24")).toBe("18-24");
    expect(ageLabel("age65-")).toBe("65+");
    expect(ageLabel("unknown")).toBe("unknown");
  });

  it("demographicBars — 연령 오름차순 집계, 0/null 셀 제외", () => {
    const bars = demographicBars(rows);
    expect(bars.map((b) => b.age)).toEqual(["13-17", "18-24", "25-34", "65+"]);
    const b18 = bars.find((b) => b.age === "18-24")!;
    expect(b18.female).toBe(32);
    expect(b18.male).toBe(11);
    expect(b18.total).toBe(43);
    expect(bars.find((b) => b.age === "65+")!.other).toBe(1);
  });

  it("topDemographicLine — 최대 셀 헤드라인, 빈 입력 null", () => {
    expect(topDemographicLine(rows)).toBe("여성 18-24 (32%)");
    expect(topDemographicLine([])).toBeNull();
    expect(topDemographicLine(null)).toBeNull();
  });
});

describe("subSplitLine", () => {
  it("0.6 임계로 유입 우세/코어 우세/균형을 가른다, 결측은 null", () => {
    expect(subSplitLine(0.3, 0.7)).toContain("확장 중");
    expect(subSplitLine(0.65, 0.35)).toContain("코어는 단단");
    expect(subSplitLine(0.5, 0.5)).toContain("균형");
    expect(subSplitLine(null, 0.5)).toBeNull();
  });
});

describe("cohortForecast", () => {
  // asOfDay=40, forward 42일 → horizon=82. 시작점(day≤40)은 API가 본 곡선
  // 마지막 점을 앞에 끼워 보낸 것.
  const forward: ForwardData = {
    days: 42,
    curves: {
      yt_subscribers: {
        owis:  [{ day: 40, index: 200 }, { day: 60, index: 220 }, { day: 80, index: 240 }], // ×1.2
        bdawn: [{ day: 39, index: 150 }, { day: 82, index: 165 }],                          // ×1.1
        // 구간 60% 미달(끝점 day 50 < 40+25.2) → 제외
        bthd:  [{ day: 40, index: 100 }, { day: 50, index: 300 }],
      },
    },
  };

  it("60% 이상 진행된 선배 팀들의 비율 중앙값으로 투영한다", () => {
    const fc = cohortForecast(forward, "yt_subscribers", 40, 10_000)!;
    expect(fc.peerCount).toBe(2);
    expect(fc.medianRatio).toBeCloseTo(1.15, 5); // (1.2+1.1)/2
    expect(fc.horizonDay).toBe(82);
    expect(fc.projectedValue).toBe(11_500);
  });

  it("산입 가능한 팀이 2개 미만이거나 입력 결측이면 null", () => {
    const one: ForwardData = {
      days: 42,
      curves: { yt_subscribers: { owis: forward.curves.yt_subscribers!.owis! } },
    };
    expect(cohortForecast(one, "yt_subscribers", 40, 10_000)).toBeNull();
    expect(cohortForecast(null, "yt_subscribers", 40, 10_000)).toBeNull();
    expect(cohortForecast(forward, "yt_total_views", 40, 10_000)).toBeNull();
  });

  it("현재값이 없으면 비율만 내고 projectedValue=null", () => {
    const fc = cohortForecast(forward, "yt_subscribers", 40, null)!;
    expect(fc.medianRatio).toBeCloseTo(1.15, 5);
    expect(fc.projectedValue).toBeNull();
  });
});

describe("topCountriesLine", () => {
  it("watch_share 내림차순 상위 N을 퍼센트로 요약한다", () => {
    const line = topCountriesLine([
      { country: "JP", watch_share: 0.14 },
      { country: "KR", watch_share: 0.62 },
      { country: "US", watch_share: 0.08 },
      { country: "TH", watch_share: 0.04 },
    ]);
    expect(line).toBe("KR 62% · JP 14% · US 8%");
  });

  it("빈 입력은 null", () => {
    expect(topCountriesLine(null)).toBeNull();
    expect(topCountriesLine([])).toBeNull();
  });
});
