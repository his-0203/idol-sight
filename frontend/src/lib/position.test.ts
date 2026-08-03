import { describe, expect, it } from "vitest";
import {
  ageLabel, demographicBars, momentumLine, sovPosition, topCountriesLine,
  topDemographicLine, type DemographicRow, type ShareRow,
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
