// 동시기 성과 헤드라인 순수 로직 — 투자사에게 그대로 읽히는 문구라
// "언제 강점으로 세우고 언제 광고 근거를 붙이는가"를 테스트로 고정한다.
import { describe, expect, test } from "vitest";
import {
  AD_SUSPECT_METRICS, ORG_AD_SUSPECT_THRESHOLD,
  headline, organicStanding,
  type CohortData, type OrgRow,
} from "../../src/lib/cohortHeadline";
import { VERDICT_THRESHOLDS } from "../../src/lib/organicity";

/** 순위·모수만 바꿔가며 쓰는 스코어카드 한 칸 (행은 미완이 배수만 쓰인다). */
const sc = (miiwan_rank: number | null, cohort_size: number, mult = 2) => ({
  rows: [{
    group_key: "miiwan", value_at_day: 1000, growth_multiple: mult,
    source: "live", reference: false,
    base_day: 0, at_day: 43, base_source: "live",
  }],
  miiwan_rank, cohort_size,
});

const org = (group_key: string, score: number | null, reference = false): OrgRow =>
  ({ group_key, score, video_count: 5, reference });

function cohort(over: Partial<CohortData> = {}): CohortData {
  return {
    as_of_day: 43,
    metrics: ["yt_subscribers", "yt_total_views", "naver_total_news"],
    groups: {},
    curves: {},
    scorecard: {},
    organicity: [],
    excluded: [],
    ...over,
  };
}

describe("headline — 강·약점 분류", () => {
  test("상위 절반은 강점, 하위 절반은 보완 방향까지 붙여 약점", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(1, 4, 2.4),
        naver_total_news: sc(4, 4, 1.1),
      },
    }));
    expect(h.lead).toContain("D+43일 차");
    expect(h.strengths).toHaveLength(1);
    expect(h.strengths[0]).toContain("구독자 2.4×");
    expect(h.strengths[0]).toContain("4팀 중 1위");
    expect(h.weaknesses).toHaveLength(1);
    expect(h.weaknesses[0]).toContain("4팀 중 4위");
    // 순위만 던지지 않고 "그래서 뭘 하나"까지 — 보완 방향 맵이 붙는다.
    expect(h.weaknesses[0]).toContain("보도자료");
    expect(h.neutral).toBeNull();
  });

  test("비교 대상이 1팀뿐이면(자기 자신) 순위를 세지 않는다", () => {
    const h = headline(cohort({ scorecard: { yt_subscribers: sc(1, 1) } }));
    expect(h.strengths).toEqual([]);
    expect(h.weaknesses).toEqual([]);
    expect(h.neutral).not.toBeNull();
  });

  test("강·약점 둘 다 없으면 중립 문구로 폴백", () => {
    const h = headline(cohort({ scorecard: { yt_subscribers: sc(null, 3) } }));
    expect(h.strengths).toEqual([]);
    expect(h.weaknesses).toEqual([]);
    expect(h.neutral).toContain("데뷔일 시점 데이터");
    expect(h.strengthWhy).toBeNull();
  });
});

// 자연 유입 점수는 "영상"이 유료로 밀렸는지를 잰 값이라 유튜브 성장만
// 변호할 수 있다. 뉴스 순위에 이 근거를 붙이면 바로 아래 보완 목록
// (유튜브가 약점)과 자기모순이 된다.
describe("headline — strengthWhy 스코프", () => {
  const strong = [org("miiwan", 82), org("myrakl", 60)];

  test("유튜브가 강점이면 자연 유입 점수를 근거로 붙인다", () => {
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4), naver_total_news: sc(4, 4) },
      organicity: strong,
    }));
    expect(h.strengthWhy).toContain("82점");
    expect(h.strengthWhy).toContain("팬이 스스로 찾아와 만든 것");
    // 코호트 상위권이면 유기성 순위도 함께.
    expect(h.strengthWhy).toContain("2팀 중 1위");
  });

  test("강점이 뉴스뿐이고 유튜브가 약점이면 붙이지 않는다", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(4, 4),
        yt_total_views: sc(3, 4),
        naver_total_news: sc(1, 4),
      },
      organicity: strong,
    }));
    expect(h.strengths).toHaveLength(1);
    expect(h.strengths[0]).toContain("뉴스 노출");
    expect(h.strengthWhy).toBeNull();
  });

  test("점수가 null 인 그룹은 근거 없이 광고 판정을 하지 않는다", () => {
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [org("miiwan", null), org("myrakl", 60)],
    }));
    expect(h.strengths).toHaveLength(1);
    expect(h.strengthWhy).toBeNull();
  });

  test("임계 경계: 기준값이면 붙고, 1점 아래면 안 붙는다", () => {
    const at = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [org("miiwan", ORG_AD_SUSPECT_THRESHOLD)],
    }));
    expect(at.strengthWhy).toContain(`${ORG_AD_SUSPECT_THRESHOLD}점`);

    const below = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [org("miiwan", ORG_AD_SUSPECT_THRESHOLD - 1)],
    }));
    expect(below.strengthWhy).toBeNull();
  });
});

describe("organicStanding", () => {
  test("참조 그룹(PLAVE)은 순위 모수에서 빠진다", () => {
    const s = organicStanding(cohort({
      organicity: [org("miiwan", 70), org("myrakl", 90), org("plave", 95, true)],
    }));
    // plave 를 세면 3팀 중 3위가 되지만, 표·곡선과 같은 규칙으로 제외.
    expect(s).toEqual({ score: 70, rank: 2, size: 2 });
  });

  test("점수 없는 팀은 분모에 넣지 않는다", () => {
    const s = organicStanding(cohort({
      organicity: [org("miiwan", 80), org("myrakl", null), org("owis", null)],
    }));
    expect(s).toEqual({ score: 80, rank: 1, size: 1 });
  });

  test("미완이 점수 자체가 없으면 null", () => {
    expect(organicStanding(cohort({ organicity: [org("myrakl", 80)] }))).toBeNull();
    expect(organicStanding(cohort())).toBeNull();
  });
});

describe("상수", () => {
  // 손으로 적은 70 이 아니라 organic 등급 컷을 재사용해야 한다 —
  // organicity.ts 헤더가 경고하는 hand-copy desync 방지.
  test("광고 의심 임계 = organicity.ts 의 organic 등급 컷", () => {
    expect(ORG_AD_SUSPECT_THRESHOLD).toBe(VERDICT_THRESHOLDS.organic);
  });

  test("광고 의심 대상은 유튜브 지표만 (뉴스는 영상 판정과 무관)", () => {
    expect([...AD_SUSPECT_METRICS].sort()).toEqual(["yt_subscribers", "yt_total_views"]);
    expect(AD_SUSPECT_METRICS.has("naver_total_news")).toBe(false);
  });
});
