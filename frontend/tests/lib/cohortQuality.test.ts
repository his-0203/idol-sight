// "성장의 질" 산점도 데이터 준비 — 값이 없는 팀을 조용히 지우지 않는지,
// 참조 그룹이 중앙값을 오염시키지 않는지, 규모가 작은 점이 사라지지 않는지.
import { describe, expect, test } from "vitest";
import {
  MAX_RADIUS, MIN_RADIUS, QUALITY_METRIC, Y_AXIS_PADDING,
  buildQualityScatter, median, radiusFor, scatterNote, yRangeFor,
} from "../../src/lib/cohortQuality";
import {
  ORG_AD_SUSPECT_THRESHOLD, type CohortData, type OrgRow, type ScRow,
} from "../../src/lib/cohortHeadline";

const row = (
  group_key: string,
  growth_multiple: number | null,
  value_at_day: number | null,
  reference = false,
): ScRow => ({
  group_key, value_at_day, growth_multiple,
  source: "live", reference,
  base_day: 0, base_value: 1000, at_day: 43, base_source: "live",
  pre_multiple: null, subs_per_1k_pre: null, subs_per_1k_post: null,
});

const org = (
  group_key: string, score: number | null, reference = false,
  score_view_weighted?: number | null,
): OrgRow => ({ group_key, score, video_count: 5, reference, score_view_weighted });

function cohort(rows: ScRow[], organicity: OrgRow[]): CohortData {
  const groups: CohortData["groups"] = {};
  for (const r of rows) {
    groups[r.group_key] = {
      name: r.group_key.toUpperCase(), debut_date: "2026-06-01", reference: r.reference,
    };
  }
  return {
    as_of_day: 43,
    metrics: [QUALITY_METRIC],
    groups,
    curves: {},
    scorecard: { [QUALITY_METRIC]: { rows, miiwan_rank: 1, cohort_size: rows.length } },
    organicity,
    excluded: [],
  };
}

describe("median", () => {
  test("홀수는 가운데, 짝수는 가운데 두 값의 평균", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  test("빈 배열은 null (0 으로 위장하지 않는다)", () => {
    expect(median([])).toBeNull();
  });
});

describe("radiusFor", () => {
  test("최대 규모가 MAX, 넓이가 규모에 비례(sqrt 스케일)", () => {
    expect(radiusFor(100, 100)).toBe(MAX_RADIUS);
    // 규모 1/4 → 반경 비율 1/2 지점
    expect(radiusFor(25, 100)).toBeCloseTo(MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * 0.5);
  });
  test("규모 0·최대 0 이어도 점은 남는다 (최소 반경 보장)", () => {
    expect(radiusFor(0, 100)).toBe(MIN_RADIUS);
    expect(radiusFor(0, 0)).toBe(MIN_RADIUS);
    expect(radiusFor(-5, 100)).toBe(MIN_RADIUS);
  });
  test("최대값을 넘겨도 MAX 를 벗어나지 않는다", () => {
    expect(radiusFor(400, 100)).toBe(MAX_RADIUS);
  });
});

describe("buildQualityScatter", () => {
  test("두 값이 다 있는 팀만 점, 나머지는 사유와 함께 제외 목록으로", () => {
    const s = buildQualityScatter(cohort(
      [
        row("miiwan", 2.0, 10_000),
        row("owis", 5.0, 40_000),
        row("bthd", null, 500),    // 성장배수 없음
        row("skinz", 1.5, 2_000),  // 자연 유입 점수 없음
        row("bdawn", null, null),  // 둘 다 없음
      ],
      [org("miiwan", 82), org("owis", 40), org("bthd", 70), org("bdawn", null)],
    ));
    expect(s.points.map((p) => p.group_key)).toEqual(["miiwan", "owis"]);
    const reasons = Object.fromEntries(s.excluded.map((e) => [e.group_key, e.reason]));
    expect(reasons.bthd).toContain("성장배수");
    expect(reasons.skinz).toContain("자연 유입 점수");
    expect(reasons.bdawn).toBe("성장배수·자연 유입 점수 모두 없음");
    // 이름은 그대로 실어 캡션이 키가 아니라 팀 이름을 쓸 수 있게.
    expect(s.excluded.find((e) => e.group_key === "bthd")?.name).toBe("BTHD");
  });

  test("임계 미만이면 adSuspect, 임계값 자체는 아니다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 2, 100), row("owis", 3, 100)],
      [
        org("miiwan", ORG_AD_SUSPECT_THRESHOLD),
        org("owis", ORG_AD_SUSPECT_THRESHOLD - 1),
      ],
    ));
    expect(s.points.find((p) => p.group_key === "miiwan")?.adSuspect).toBe(false);
    expect(s.points.find((p) => p.group_key === "owis")?.adSuspect).toBe(true);
    expect(s.threshold).toBe(ORG_AD_SUSPECT_THRESHOLD);
  });

  test("참조(PLAVE)는 점으로는 남되 중앙값 모수에서는 빠진다", () => {
    const s = buildQualityScatter(cohort(
      [
        row("miiwan", 2, 100),
        row("owis", 4, 100),
        row("plave", 100, 1_000_000, true),
      ],
      [org("miiwan", 80), org("owis", 50), org("plave", 90, true)],
    ));
    expect(s.points).toHaveLength(3);
    expect(s.points.find((p) => p.group_key === "plave")?.reference).toBe(true);
    // plave 를 세면 4× 가 중앙값이 되지만, 참조 제외 후 [2,4] → 3.
    expect(s.medianGrowth).toBe(3);
  });

  test("원 크기는 D+N 절대값 기준 — 가장 큰 팀이 MAX", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 2, 2_500), row("owis", 3, 10_000)],
      [org("miiwan", 80), org("owis", 80)],
    ));
    const mi = s.points.find((p) => p.group_key === "miiwan")!;
    const ow = s.points.find((p) => p.group_key === "owis")!;
    expect(ow.radius).toBe(MAX_RADIUS);
    expect(mi.scale).toBe(2_500);
    // 규모 1/4 → sqrt 로 반경 비율 1/2
    expect(mi.radius).toBeCloseTo(MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * 0.5);
  });

  test("점이 하나도 없으면 중앙값은 null (빈 화면을 0 으로 채우지 않는다)", () => {
    const s = buildQualityScatter(cohort([row("miiwan", null, null)], []));
    expect(s.points).toEqual([]);
    expect(s.medianGrowth).toBeNull();
    expect(s.excluded).toHaveLength(1);
  });

  test("스코어카드에 해당 지표가 없으면 조용히 빈 결과", () => {
    const d = cohort([row("miiwan", 2, 100)], [org("miiwan", 80)]);
    d.scorecard = {};
    const s = buildQualityScatter(d);
    expect(s.points).toEqual([]);
    expect(s.excluded).toEqual([]);
  });

  // Q1/B1 — y축도 배지·흐린 선과 같은 min 기준. 세 화면이 다른 숫자를 쓰면
  // "산점도에선 위인데 표에선 의심 표시" 같은 자기모순이 난다.
  test("y축 점수 = 편수·조회수 중 낮은 쪽", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 2, 100), row("owis", 3, 100)],
      [
        org("miiwan", 90, false, 30), // 조회수로는 30 → 판정 30
        org("owis", 55),              // 조회수 점수 없음 → 편수 55
      ],
    ));
    const mi = s.points.find((p) => p.group_key === "miiwan")!;
    expect(mi.organic).toBe(30);
    expect(mi.adSuspect).toBe(true);
    expect(s.points.find((p) => p.group_key === "owis")!.organic).toBe(55);
  });
});

describe("yRangeFor", () => {
  test("데이터에 맞춰 좁히되 임계선은 항상 화면 안", () => {
    // 전 팀이 72~78 이어도 임계 70 이 잘리지 않는다.
    const r = yRangeFor([72, 78], 70);
    expect(r.min).toBeLessThanOrEqual(70);
    expect(r.max).toBeGreaterThanOrEqual(78);
    expect(r.min).toBe(70 - Y_AXIS_PADDING);
    expect(r.max).toBe(78 + Y_AXIS_PADDING);
  });
  test("0~100 밖으로는 나가지 않는다", () => {
    const r = yRangeFor([2, 99], 70);
    expect(r.min).toBe(0);
    expect(r.max).toBe(100);
  });
  test("점이 없으면 0~100 (빈 축을 지어내지 않는다)", () => {
    expect(yRangeFor([], 70)).toEqual({ min: 0, max: 100 });
  });
});

// R5 — 그림만 두면 "왼쪽 = 뒤처짐"이 가장 흔한 오독이고, 왼쪽인 이유가
// 화면에서 사라진다. 좌표·임계 근접은 전부 데이터에서 — 손으로 안 적는다.
describe("scatterNote", () => {
  test("중앙값 왼쪽이면 이유(출발선)까지 함께 쓴다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 1.1, 26_400), row("owis", 2.2, 5_000), row("bthd", 3.0, 3_000)],
      [org("miiwan", 45), org("owis", 40), org("bthd", 90)],
    ));
    const note = scatterNote(s)!;
    expect(note).toContain("왼쪽");
    expect(note).toContain("출발선이 큰 팀은 배수가 작아");
    // 임계 부근이면 판정이 갈릴 수 있음을 밝힌다.
    expect(note).toContain("판정이 갈릴 수 있다");
    // 규모는 속도와 다른 이야기 — 느려도 규모는 1위일 수 있다.
    expect(note).toContain("3팀 중 1위");
  });

  test("임계에서 충분히 떨어져 있으면 '갈릴 수 있다'고 하지 않는다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 3, 100), row("owis", 1, 100)],
      [org("miiwan", 95), org("owis", 90)],
    ));
    const note = scatterNote(s)!;
    expect(note).toContain("오른쪽");
    expect(note).not.toContain("판정이 갈릴 수 있다");
  });

  test("자사 점이 없으면 null (없는 위치를 서술하지 않는다)", () => {
    const s = buildQualityScatter(cohort([row("owis", 2, 100)], [org("owis", 80)]));
    expect(scatterNote(s)).toBeNull();
  });
});
