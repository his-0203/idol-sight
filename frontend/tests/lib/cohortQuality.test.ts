// "성장의 질" 산점도 데이터 준비 — 값이 없는 팀을 조용히 지우지 않는지,
// 참조 그룹이 중앙값을 오염시키지 않는지, 규모가 작은 점이 사라지지 않는지.
import { describe, expect, test } from "vitest";
import {
  MAX_RADIUS, MIN_RADIUS, PRE_BASE_WINDOW, QUALITY_METRIC, Y_AXIS_PADDING,
  buildQualityScatter, isLooseAnchor, median, radiusFor, scatterNote, yRangeFor,
} from "../../src/lib/cohortQuality";
import {
  ORG_AD_SUSPECT_THRESHOLD, type CohortData, type OrgRow, type ScRow,
} from "../../src/lib/cohortHeadline";
import { VERDICT_THRESHOLDS } from "../../src/lib/organicity";
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
    // F5 — 분모는 표의 '출발선(데뷔일 값)' 컬럼이 아니라 데뷔 전 앵커다.
    expect(note).toContain("데뷔 전 출발선(약 30일 전 값)이 큰 팀은 배수가 작아");
    // 임계 부근이면 판정이 갈릴 수 있음을 밝힌다.
    expect(note).toContain("판정이 갈릴 수 있다");
    // 규모는 속도와 다른 이야기 — 느려도 규모는 1위일 수 있다.
    expect(note).toContain("3팀 중 1위");
    // 총 성장배수의 분모(앵커) 시점을 문장에 명시한다 — row() 기본값은 D-30.
    expect(note).toContain("데뷔 30일 전 값 대비");
  });

  // F6 — 왼쪽 분기에만 캐비앗이 있으면 오른쪽(작은 앵커 효과로 배수가 부풀
  // 수 있음)일 때는 유리하게만 읽힌다. 반대쪽에도 같은 구조적 캐비앗을 단다.
  test("중앙값 오른쪽이어도 반대 방향 캐비앗(작은 출발선 효과)을 함께 쓴다", () => {
    const s = buildQualityScatter(cohort(
      [row("miiwan", 3, 100), row("owis", 1, 100)],
      [org("miiwan", 95), org("owis", 90)],
    ));
    const note = scatterNote(s)!;
    expect(note).toContain("오른쪽");
    expect(note).toContain("반대로 데뷔 전 출발선이 작은 팀은 같은 성장이라도 배수가 크게 나온다");
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

  // F4 — 기준선은 organic(70) 이 아니라 광고 과다 컷 suspect(40) 이다.
  // "위 = 광고 없이 컸다"라고 하면 40~69점(광고 과다는 아니지만 자연 유입
  // 우세도 아닌 회색 지대)까지 결백으로 읽혀, 막대 캡션("70점부터 우세")과
  // 정면으로 모순된다.
  describe("F4 — 기준선 위/아래 서술이 organic 등급과 일관된다", () => {
    test("기준선 위지만 organic 미만이면 '과다 없음'까지만 말하고 우세는 아니라고 덧붙인다", () => {
      const s = buildQualityScatter(cohort(
        [row("miiwan", 3, 100), row("owis", 1, 100)],
        [org("miiwan", 55), org("owis", 20)], // 40 < 55 < 70, THRESHOLD_NEAR_BAND(10) 밖
      ));
      const note = scatterNote(s)!;
      expect(note).toContain("광고 과다 기준선(40점) 위");
      expect(note).toContain("광고 과다 사용 정황은 없는 쪽이다");
      expect(note).not.toContain("광고 없이");
      expect(note).toContain(`자연 유입 우세 기준 ${VERDICT_THRESHOLDS.organic}점에는 못 미친다`);
    });

    test("organic 이상이면 '못 미친다' 단서 없이 결백 문구만 낸다", () => {
      const s = buildQualityScatter(cohort(
        [row("miiwan", 3, 100), row("owis", 1, 100)],
        [org("miiwan", 95), org("owis", 90)],
      ));
      const note = scatterNote(s)!;
      expect(note).toContain("광고 과다 사용 정황은 없는 쪽이다");
      expect(note).not.toContain("못 미친다");
    });

    test("기준선 아래면 '과다 사용 정황이 있는 쪽'이라고 말한다", () => {
      const s = buildQualityScatter(cohort(
        [row("miiwan", 3, 100), row("owis", 1, 100)],
        [org("miiwan", 15), org("owis", 90)], // 15 < 40 - THRESHOLD_NEAR_BAND(10)
      ));
      const note = scatterNote(s)!;
      expect(note).toContain("광고 과다 기준선(40점) 아래");
      expect(note).toContain("광고 과다 사용 정황이 있는 쪽이다");
    });
  });

  test("MiiWAN 앵커가 데뷔 전이 아니면(D0 폴백) 그 사실을 문장에 붙인다", () => {
    const s = buildQualityScatter(cohort(
      [
        row("miiwan", 1.1, 26_400, false, 0), // 데뷔 전 측정 없음 → 데뷔일 폴백
        row("owis", 2.2, 5_000),
        row("bthd", 3.0, 3_000),
      ],
      [org("miiwan", 45), org("owis", 40), org("bthd", 90)],
    ));
    const note = scatterNote(s)!;
    expect(note).toContain("데뷔일 값 대비");
    expect(note).not.toContain("데뷔 0일 전");
  });

  test("자사 점이 없으면 null (없는 위치를 서술하지 않는다)", () => {
    const s = buildQualityScatter(cohort([row("owis", 2, 100)], [org("owis", 80)]));
    expect(scatterNote(s)).toBeNull();
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

  test("창보다 더 이전(반대쪽)은 느슨하다고 보지 않는다 — 보수적인 방향", () => {
    expect(isLooseAnchor(-50, 30)).toBe(false);
  });
});

describe("PRE_BASE_WINDOW — 서버 원본과 드리프트 방지", () => {
  test("프런트 미러 값이 functions/lib/cohortReport.ts 원본과 같다", () => {
    expect(PRE_BASE_WINDOW).toBe(SERVER_PRE_BASE_WINDOW);
    expect(PRE_BASE_WINDOW).toBe(7);
  });
});
