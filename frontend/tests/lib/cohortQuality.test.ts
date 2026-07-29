// "성장의 질" 산점도 데이터 준비 — 값이 없는 팀을 조용히 지우지 않는지,
// 참조 그룹이 중앙값을 오염시키지 않는지, 규모가 작은 점이 사라지지 않는지.
import { describe, expect, test } from "vitest";
import {
  MAX_RADIUS, MIN_RADIUS, PRE_BASE_WINDOW, QUALITY_METRIC, Y_AXIS_PADDING,
  MULTIPLE_CAVEAT,
  buildQualityScatter, isLooseAnchor, median, qualityVerdict, radiusFor, yRangeFor,
} from "../../src/lib/cohortQuality";
import {
  ORG_AD_SUSPECT_THRESHOLD, THRESHOLD_NEAR_BAND, fmtMultiple,
  type CohortData, type OrgRow, type ScRow,
} from "../../src/lib/cohortHeadline";
// M1 — 프런트가 미러링한 PRE_BASE_WINDOW 가 서버 원본과 갈리지 않는지
// 직접 비교한다(organicity.ts 헤더가 경고하는 hand-copy desync 방지와 동일 패턴,
// 다른 테스트도 이미 functions/lib 순수 로직을 이렇게 크로스 임포트한다).
import { PRE_BASE_WINDOW as SERVER_PRE_BASE_WINDOW } from "../../functions/lib/cohortReport";

// x축은 total_multiple(데뷔 전 앵커 대비 총 성장배수) — growth_multiple(데뷔 후
// 배수)이 아니다. 기본 앵커는 D-30(데뷔 전)이고, D0 폴백을 테스트하려면
// total_anchor_day 를 명시로 넘긴다.
const row = (
  group_key: string,
  total_multiple: number | null,
  value_at_day: number | null,
  reference = false,
  total_anchor_day: number | null = -30,
): ScRow => ({
  group_key, value_at_day,
  // growth_multiple(데뷔 후 배수)은 이 스위트가 안 쓰는 필드라 total_multiple과
  // 다른 값으로 채워 "growth는 total_multiple에서 온다"는 것도 별도 테스트로 검증한다.
  growth_multiple: total_multiple,
  source: "live", reference,
  base_day: 0, base_value: 1000, at_day: 43, base_source: "live",
  pre_multiple: null, subs_per_1k_pre: null, subs_per_1k_post: null,
  pre_value: null, pre_day: null, pre_source: null,
  total_multiple, total_anchor_day,
  total_anchor_source: total_anchor_day == null ? null : "live",
});

const org = (
  group_key: string, score: number | null, reference = false,
  score_view_weighted?: number | null,
): OrgRow => ({ group_key, score, video_count: 5, reference, score_view_weighted });

/**
 * 문장 수 = "마침표 + 공백/끝"의 개수. 소수점(15.0)은 뒤에 숫자가 오므로 세지
 * 않는다. cohortHeadline.test.ts 의 같은 헬퍼와 규칙이 같다 — 절을 이어 붙여
 * 결론 줄이 불어난 회귀(G4)를 잡는 용도.
 */
const sentenceCount = (s: string) => (s.match(/\.(\s|$)/g) ?? []).length;

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
    // 총 성장배수(데뷔 전 앵커 포함) 기준 사유 문구.
    expect(reasons.bthd).toBe("데뷔 전·데뷔일 값이 없어 성장배수를 낼 수 없음");
    expect(reasons.skinz).toContain("자연 유입 점수");
    expect(reasons.bdawn).toBe("성장배수·자연 유입 점수 모두 없음");
    // 이름은 그대로 실어 캡션이 키가 아니라 팀 이름을 쓸 수 있게.
    expect(s.excluded.find((e) => e.group_key === "bthd")?.name).toBe("BTHD");
  });

  test("growth 는 growth_multiple 이 아니라 total_multiple 에서 온다", () => {
    // row()는 total_multiple = growth_multiple로 채우므로, 두 필드를 일부러
    // 다르게 둬서 어느 쪽을 읽는지 구분한다.
    const r: ScRow = { ...row("miiwan", 5, 100), growth_multiple: 2 };
    const s = buildQualityScatter(cohort([r], [org("miiwan", 80)]));
    expect(s.points[0]?.growth).toBe(5);
  });

  test("total_multiple 이 없으면(growth_multiple만 있어도) 제외된다", () => {
    const r: ScRow = { ...row("miiwan", null, 100), growth_multiple: 2 };
    const s = buildQualityScatter(cohort([r], [org("miiwan", 80)]));
    expect(s.points).toEqual([]);
    expect(s.excluded[0]?.reason).toBe("데뷔 전·데뷔일 값이 없어 성장배수를 낼 수 없음");
  });

  // F2 — total_multiple == null 의 원인을 뭉뚱그리면 표와 모순된 사유가 뜬다
  // (bthd 케이스: 데뷔 전 값·출발선은 표에 멀쩡히 있는데 D+N 값만 없음).
  // r.value_at_day 가 total_multiple 의 분자(백엔드 `at`)와 같은 값이라,
  // 이게 null 인지 아닌지로 두 원인을 정확히 가른다.
  describe("F2 — total_multiple 제외 사유 구분", () => {
    test("D+N 값(value_at_day)이 없으면 그 사유를 낸다 — 앵커 사유와 다르다", () => {
      const r: ScRow = { ...row("bthd", null, null), growth_multiple: 2 };
      const s = buildQualityScatter(cohort([r], [org("bthd", 70)]));
      expect(s.excluded[0]?.reason).toBe("D+43 시점 값이 아직 없어 성장배수를 낼 수 없음");
    });

    test("D+N 값은 있는데 앵커·데뷔일 값이 없으면 기존 사유를 유지한다", () => {
      // value_at_day = 500 → D+N 값 자체는 있음. total_multiple 이 null 인
      // 원인은 앵커(preAnchor)/데뷔일 기준값 쪽이라 문구가 달라야 한다.
      const r: ScRow = { ...row("bthd", null, 500), growth_multiple: 2 };
      const s = buildQualityScatter(cohort([r], [org("bthd", 70)]));
      expect(s.excluded[0]?.reason).toBe("데뷔 전·데뷔일 값이 없어 성장배수를 낼 수 없음");
    });
  });

  test("anchorDay가 그대로 실린다 — 데뷔 전 앵커(D-30)와 데뷔일 폴백(D0) 각각", () => {
    const s = buildQualityScatter(cohort(
      [
        row("miiwan", 2, 100, false, -30),
        row("owis", 3, 100, false, null), // total_anchor_day 없음 → 0 폴백
      ],
      [org("miiwan", 80), org("owis", 80)],
    ));
    expect(s.points.find((p) => p.group_key === "miiwan")?.anchorDay).toBe(-30);
    expect(s.points.find((p) => p.group_key === "owis")?.anchorDay).toBe(0);
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

// R5 — scatterNote(舊)를 흡수 — 그림만 두면 "왼쪽 = 뒤처짐"이 가장 흔한
// 오독이다. 결론(순위·임계 근접)은 손으로 적지 않고 전부 데이터에서 낸다.
// good = 총 성장 배수·원 크기 순위, weak = 자연 유입 기준선 관계(우선) 또는
// 배수 과대해석 주의.
describe("qualityVerdict", () => {
  test("good — 총 성장 배수와 순위, 1위면 강조 문장을 덧붙인다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 5.0, 10_000), row("owis", 2.0, 40_000), row("bthd", 1.5, 3_000)],
      [org("miiwan", 80), org("owis", 60), org("bthd", 50)],
    ));
    const v = qualityVerdict(s);
    expect(v.good).toContain(`총 성장 배수 ${fmtMultiple(5.0)}`);
    expect(v.good).toContain("3팀 중 1위");
    expect(v.good).toContain("가장 빠르게 팬덤을 키웠다");
    // 원 크기(현재 팬 규모)는 miiwan 10,000 < owis 40,000 → 2위.
    expect(v.good).toContain("2위다");
    // C2 — 배수 캐비앗은 1위 강조와 **같은 블록**에 항상 붙는다. 예전엔
    // weak 의 마지막 분기라 자연 유입 점수가 기준선 근처면 도달하지 못했고,
    // "가장 빠르게 팬덤을 키웠다"만 캐비앗 없이 나갔다.
    // G4(R3b) — 부착 위치만 good → sub(보조 위계)로 내려갔다. 같은 블록이라
    // 한 번도 떨어지지 않고, 결론 줄은 순위 사실만 남는다.
    expect(v.sub).toContain(MULTIPLE_CAVEAT);
  });

  // G4(R3b 타이포 리뷰) — good 이 "순위 문장 · 분해 문장 · 원 크기 문장 ·
  // 캐비앗" 네 문장으로 불어난 회귀를 잡는다. 읽는 법(분해·캐비앗)은 sub 로,
  // good 은 순위 사실만.
  test("good — 결론 줄은 두 문장을 넘지 않는다 (읽는 법은 sub 로)", () => {
    const mine: ScRow = {
      ...row("miiwan", 15.0, 10_000), pre_multiple: 13.8, growth_multiple: 1.08,
    };
    const s = buildQualityScatter(cohort([mine, row("owis", 2.0, 40_000)],
      [org("miiwan", 80), org("owis", 60)]));
    const v = qualityVerdict(s);
    expect(sentenceCount(v.good!)).toBeLessThanOrEqual(2);
    // 문장은 하나도 지워지지 않았다 — 자리만 옮겼다.
    expect(v.sub).toContain("얹힌 값이다");
    expect(v.sub).toContain(MULTIPLE_CAVEAT);
  });

  // C2 — 캐비앗은 구조적 사실이라 순위 방향과 무관하게 양방향 상시.
  test("good — 배수 순위가 낮아도 배수 캐비앗은 그대로 붙는다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 1.2, 10_000), row("owis", 5.0, 40_000), row("bthd", 4.0, 30_000)],
      [org("miiwan", 90), org("owis", 60), org("bthd", 50)],
    ));
    const v = qualityVerdict(s);
    expect(v.good).toContain("3팀 중 3위");
    expect(v.sub).toContain(MULTIPLE_CAVEAT);
  });

  // C2 — 자연 유입 점수가 기준선 부근이면(실측 상황) weak 은 그 이야기를
  // 하고, 캐비앗은 sub 로 따로 나간다 — 둘 중 하나만 나오는 예전 구조는
  // "1위" 주장이 캐비앗 없이 화면에 남는 경로를 만들었다.
  test("good — 자연 유입 경고가 weak을 차지해도 캐비앗은 sub에 남는다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 5.0, 10_000), row("owis", 2.0, 40_000)],
      [org("miiwan", ORG_AD_SUSPECT_THRESHOLD + THRESHOLD_NEAR_BAND), org("owis", 90)],
    ));
    const v = qualityVerdict(s);
    expect(v.good).toContain("가장 빠르게 팬덤을 키웠다");
    expect(v.sub).toContain(MULTIPLE_CAVEAT);
    expect(v.weak).toContain("부근이라");
  });

  // M4 — 비교 대상이 미완이뿐이면 "1팀 중 1위 — 가장 빠르게 …"·"원 크기 1위"
  // 는 자기 자신을 이긴 것을 강점으로 파는 문장이다. 순위 절 자체를 뺀다.
  test("good — 비참조 비교 대상이 1팀뿐이면 순위 절을 붙이지 않는다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 5.0, 10_000), row("plave", 9.0, 90_000, true)],
      [org("miiwan", 80), org("plave", 90, true)],
    ));
    const v = qualityVerdict(s);
    expect(v.good).toContain(`총 성장 배수 ${fmtMultiple(5.0)}.`);
    expect(v.good).not.toContain("팀 중");
    expect(v.good).not.toContain("원 크기");
    expect(v.sub).toContain(MULTIPLE_CAVEAT);
  });

  test("good — 1위가 아니면 강조 문장을 붙이지 않는다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 2.0, 10_000), row("owis", 5.0, 40_000)],
      [org("miiwan", 80), org("owis", 60)],
    ));
    const v = qualityVerdict(s);
    expect(v.good).toContain("2팀 중 2위");
    expect(v.good).not.toContain("가장 빠르게");
  });

  test("weak — 자연 유입 점수가 기준선 아래면 명시한다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 2.0, 10_000), row("owis", 5.0, 40_000)],
      [org("miiwan", ORG_AD_SUSPECT_THRESHOLD - 1), org("owis", 90)],
    ));
    const v = qualityVerdict(s);
    expect(v.weak).toContain(`${ORG_AD_SUSPECT_THRESHOLD}점) 아래다`);
  });

  test("weak — 기준선 부근(±THRESHOLD_NEAR_BAND)이면 확정 어려움을 말한다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 2.0, 10_000), row("owis", 5.0, 40_000)],
      // gap = THRESHOLD_NEAR_BAND(경계값, <= 이므로 여전히 부근으로 판정된다).
      [org("miiwan", ORG_AD_SUSPECT_THRESHOLD + THRESHOLD_NEAR_BAND), org("owis", 90)],
    ));
    const v = qualityVerdict(s);
    expect(v.weak).toContain("부근이라");
    expect(v.weak).toContain("광고 영향이 없다고 확정하기 어렵다");
  });

  // C2 — 예전엔 이 조합(기준선에서 충분히 위 + 배수 1~2위)에서만 캐비앗이
  // weak 으로 나왔다. 이제 캐비앗은 sub 상시라 weak 은 자연 유입 이야기만
  // 하고, 할 말이 없으면 null 이다.
  test("weak — 기준선에서 충분히 위면 배수 순위가 1위여도 null (캐비앗은 sub로)", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 5.0, 10_000), row("owis", 2.0, 40_000), row("bthd", 1.5, 3_000)],
      // gap = 90 - 40 = 50 > THRESHOLD_NEAR_BAND, growthRank = 1위.
      [org("miiwan", 90), org("owis", 60), org("bthd", 50)],
    ));
    const v = qualityVerdict(s);
    expect(v.weak).toBeNull();
    expect(v.sub).toContain(MULTIPLE_CAVEAT);
  });

  test("weak — 기준선도 멀고 배수 순위도 낮으면 null", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 1.2, 10_000), row("owis", 5.0, 40_000), row("bthd", 4.0, 30_000)],
      [org("miiwan", 90), org("owis", 60), org("bthd", 50)],
    ));
    const v = qualityVerdict(s);
    expect(v.weak).toBeNull();
  });

  test("자사 점이 없으면 good·weak 모두 null", () => {
    const s = buildQualityScatter(cohort([row("owis", 2, 100)], [org("owis", 80)]));
    expect(qualityVerdict(s)).toEqual({ good: null, weak: null });
  });

  // B1(R1 투자 리뷰) — 총 배수만 있으면 "15배가 데뷔 후에 일어났다"로 읽힌다.
  // 실제 구성은 데뷔 전에 쌓인 몫 위에 데뷔 후 몫이 얹힌 것이라, 분해 없이는
  // 둘을 구분할 수 없다 — 이 대비가 이 화면의 결론 자체다.
  test("sub — 총 성장 배수의 데뷔 전/데뷔 후 구간 분해를 보조 줄로 병기한다", () => {
    const mine: ScRow = {
      ...row("miiwan", 15.0, 10_000), pre_multiple: 13.8, growth_multiple: 1.08,
    };
    const s = buildQualityScatter(cohort([mine, row("owis", 2.0, 40_000)],
      [org("miiwan", 80), org("owis", 60)]));
    const v = qualityVerdict(s);
    expect(v.good).toContain(`총 성장 배수 ${fmtMultiple(15.0)}`);
    expect(v.sub).toContain(
      `데뷔 전 ${fmtMultiple(13.8)}를 쌓은 위에 데뷔 후 ${fmtMultiple(1.08)}가 얹힌 값이다.`,
    );
    // 분해는 보조 위계로 내려갔으므로 결론 줄에는 남지 않는다.
    expect(v.good).not.toContain("얹힌 값이다");
  });

  // F2(R3 투자 리뷰) — 분해를 곱셈 등식으로 쓰면 화면이 스스로 틀린 산수를
  // 보여준다: 표시값은 소수 1자리 반올림이라 13.8 × 1.1 = 15.2 ≠ 15.0 이다.
  // 배수의 '×'와 곱셈의 '×'가 붙어 글리프가 겹치는 문제도 같은 표기에서 왔다.
  test("분해를 곱셈 등식으로 주장하지 않는다 (반올림 탓에 곱이 총 배수와 다르다)", () => {
    // 반올림 후 곱이 총 배수와 어긋나는 실측형 조합.
    const mine: ScRow = {
      ...row("miiwan", 15.0, 10_000), pre_multiple: 13.8, growth_multiple: 1.08,
    };
    const s = buildQualityScatter(cohort([mine, row("owis", 2.0, 40_000)],
      [org("miiwan", 80), org("owis", 60)]));
    const v = qualityVerdict(s);
    // 반올림 표시값끼리는 등식이 성립하지 않는다는 사실 자체를 고정한다.
    expect(Math.round(13.8 * 1.08 * 10) / 10).not.toBe(15.0);
    for (const line of [v.good!, v.sub!]) {
      expect(line).not.toContain("× ×");   // 글리프 겹침
      expect(line).not.toContain("× 데뷔 후"); // 곱셈 등식 표기
    }
  });

  test("sub — 분해 값이 없으면 그 절만 빠지고 캐비앗은 남는다", () => {
    const mine: ScRow = { ...row("miiwan", 15.0, 10_000), pre_multiple: null };
    const s = buildQualityScatter(cohort([mine, row("owis", 2.0, 40_000)],
      [org("miiwan", 80), org("owis", 60)]));
    const v = qualityVerdict(s);
    expect(v.good).toContain(`총 성장 배수 ${fmtMultiple(15.0)}로`);
    expect(v.sub).not.toContain("얹힌 값이다");
    expect(v.sub).not.toContain("데뷔 후 ");
    // 캐비앗은 분해 유무와 무관하게 상시 — sub 가 빈 문자열이 되지 않는다.
    expect(v.sub).toBe(MULTIPLE_CAVEAT);
  });

  test("분해 값은 계산하지 않고 응답 필드를 그대로 싣는다", () => {
    // pre × post 가 total 과 정확히 맞지 않아도(앵커·허용폭이 달라서) 화면이
    // 그 어긋남을 숨기지 않는다 — 여기서 곱을 다시 만들지 않는 이유.
    const mine: ScRow = {
      ...row("miiwan", 15.0, 10_000), pre_multiple: 13.8, growth_multiple: 1.08,
    };
    const s = buildQualityScatter(cohort([mine], [org("miiwan", 80)]));
    expect(s.points[0]?.preMultiple).toBe(13.8);
    expect(s.points[0]?.postMultiple).toBe(1.08);
    expect(s.points[0]?.growth).toBe(15.0);
  });

  // 공통 가드 — 결론은 하드코딩이 아니라 픽스처에서 파생된다. 배수를
  // 바꾸면 good 문장의 숫자도 함께 바뀌어야 한다.
  test("숫자는 픽스처에서 파생 — 성장 배수를 바꾸면 문장 숫자도 바뀐다", () => {
    const build = (growth: number) => buildQualityScatter(cohort(
      [row("miiwan", growth, 10_000), row("owis", 2.0, 40_000)],
      [org("miiwan", 80), org("owis", 60)],
    ));
    expect(qualityVerdict(build(3.0)).good).toContain(fmtMultiple(3.0));
    expect(qualityVerdict(build(7.0)).good).toContain(fmtMultiple(7.0));
  });
});

// M1 — 앵커가 "데뷔 D-preDebutDays±PRE_BASE_WINDOW" 정찰 창 밖에서 잡히면
// (D0 폴백 포함) 그 사실을 공시해야 한다. 이전엔 anchorDay === 0만 공시해
// D-21처럼 창 밖이지만 데뷔 전인 느슨한 앵커는 조용히 "정상"으로 지나갔다.
describe("isLooseAnchor", () => {
  test("정찰 창(D-30±7) 안이면 느슨하지 않다", () => {
    expect(isLooseAnchor(-30, 30)).toBe(false); // 정확히 D-30
    expect(isLooseAnchor(-23, 30)).toBe(false); // 창의 안쪽 경계(-30+7)
    expect(isLooseAnchor(-37, 30)).toBe(false); // 창의 바깥쪽 경계(-30-7)
  });

  test("창보다 데뷔일에 가까우면(예: D-21) 느슨한 앵커로 본다", () => {
    expect(isLooseAnchor(-22, 30)).toBe(true); // 창 경계 바로 안쪽(데뷔 쪽)
    expect(isLooseAnchor(-21, 30)).toBe(true); // 리뷰가 든 예시
  });

  test("데뷔일(0) 폴백은 항상 느슨한 앵커다", () => {
    expect(isLooseAnchor(0, 30)).toBe(true);
  });

  // B3(R1 투자 리뷰) — 예전엔 창보다 더 이전에서 잡힌 앵커를 "보수적인
  // 방향"이라며 공시하지 않았다. 그건 우리 쪽에 유리한 이탈을 숨긴 것이다:
  // 앵커가 이를수록 분모가 작아져 총 성장 배수는 **커진다**.
  test("창보다 더 이전(반대쪽)도 느슨한 앵커로 공시한다 — 배수를 키우는 방향", () => {
    expect(isLooseAnchor(-38, 30)).toBe(true);  // 창 바깥쪽 경계(-37) 바로 밖
    expect(isLooseAnchor(-50, 30)).toBe(true);
  });
});

describe("PRE_BASE_WINDOW — 서버 원본과 드리프트 방지", () => {
  test("프런트 미러 값이 functions/lib/cohortReport.ts 원본과 같다", () => {
    expect(PRE_BASE_WINDOW).toBe(SERVER_PRE_BASE_WINDOW);
    expect(PRE_BASE_WINDOW).toBe(7);
  });
});
