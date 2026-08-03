import { describe, expect, it } from "vitest";
import { momentumLine, sovPosition, topCountriesLine, type ShareRow } from "./position";

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
