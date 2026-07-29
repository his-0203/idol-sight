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
    base_day: 0, base_value: 400, at_day: 43, base_source: "live",
    pre_multiple: 1.5, subs_per_1k_pre: 2.1, subs_per_1k_post: 1.4,
  }],
  miiwan_rank, cohort_size,
});

const org = (group_key: string, score: number | null, reference = false): OrgRow =>
  ({ group_key, score, video_count: 5, reference });

/** 유튜브가 아닌 지표(영상 판정과 무관) 자리표시자. */
const OTHER_METRIC = "naver_total_news";

function cohort(over: Partial<CohortData> = {}): CohortData {
  return {
    as_of_day: 43,
    // OTHER_METRIC = 유튜브가 아닌 지표 자리표시자. 현재 METRICS 는 전부
    // 유튜브지만 스코프 게이트가 지표 종류로 갈리는지 확인해야 하므로,
    // 비유튜브 지표가 하나 들어온 상황을 여기서 만든다.
    metrics: ["yt_subscribers", "yt_total_views", OTHER_METRIC],
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
        yt_total_views: sc(4, 4, 1.1),
      },
    }));
    expect(h.lead).toContain("D+43일 차");
    expect(h.strengths).toHaveLength(1);
    expect(h.strengths[0]).toContain("구독자 2.4×");
    expect(h.strengths[0]).toContain("4팀 중 1위");
    expect(h.weaknesses).toHaveLength(1);
    expect(h.weaknesses[0]).toContain("4팀 중 4위");
    // 순위만 던지지 않고 "그래서 뭘 하나"까지 — 보완 방향 맵이 붙는다.
    expect(h.weaknesses[0]).toContain("쇼츠 업로드 주기");
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

  test("유튜브가 강점이면 자연 유입 점수를 상대 표현으로 덧붙인다", () => {
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4), yt_total_views: sc(4, 4) },
      organicity: strong,
    }));
    expect(h.strengthWhy).toContain("82점");
    expect(h.strengthWhy).toContain("2팀 중 1위");
    expect(h.strengthWhy).toContain("낮은 편");
    // 단정 금지 — "광고가 아니라 팬이 만든 것" 류의 확정 표현은 쓰지 않는다.
    expect(h.strengthWhy).not.toContain("팬이 스스로 찾아와 만든 것");
  });

  test("강점이 비유튜브 지표뿐이고 유튜브가 약점이면 붙이지 않는다", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(4, 4),
        yt_total_views: sc(3, 4),
        [OTHER_METRIC]: sc(1, 4),
      },
      organicity: strong,
    }));
    expect(h.strengths).toHaveLength(1);
    expect(h.strengths[0]).toContain("4팀 중 1위");
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

  // 절대 임계 단독 조건을 뺀 이유: 점수 창을 데뷔 전까지 넓히면 모든 팀의
  // 절대값이 함께 내려갈 수 있는데, 그때 임계만 보면 문구가 통째로 사라지거나
  // (반대 방향이면) 과장된다. 순위는 창 변경에 함께 움직여 흔들림이 적다.
  test("코호트 상위 절반일 때만 붙는다 (절대 임계 단독으로는 안 붙음)", () => {
    const top = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [org("miiwan", 55), org("myrakl", 40), org("owis", 30)],
    }));
    // 임계(70) 아래여도 코호트 1위면 "의존이 낮은 편"은 사실이다.
    expect(top.strengthWhy).toContain("3팀 중 1위");

    const bottom = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [
        org("miiwan", ORG_AD_SUSPECT_THRESHOLD + 10),
        org("myrakl", 95), org("owis", 92),
      ],
    }));
    // 임계를 넘겨도 코호트 최하위면 "낮은 편"이라 말할 수 없다.
    expect(bottom.strengthWhy).toBeNull();
  });

  // 비교 대상이 자기 자신뿐이면 "n팀 중 1위"는 아무것도 말하지 않는다 —
  // 스코어카드 순위(cohort_size >= 2)와 같은 기준을 유기성 순위에도 건다.
  test("점수가 있는 팀이 미완이뿐이면(size 1) 붙지 않는다", () => {
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [org("miiwan", 95), org("myrakl", null), org("plave", 99, true)],
    }));
    expect(organicStanding(cohort({
      organicity: [org("miiwan", 95), org("myrakl", null), org("plave", 99, true)],
    }))).toEqual({ score: 95, rank: 1, size: 1 });
    expect(h.strengthWhy).toBeNull();
  });

  // 동점은 둘 다 같은 순위(경쟁 순위) — 4팀 중 공동 1위면 상위 절반이라 붙는다.
  test("점수 동률이면 같은 순위로 세고, 상위 절반이면 붙는다", () => {
    const tied = [
      org("miiwan", 80), org("myrakl", 80), org("owis", 50), org("bdawn", 40),
    ];
    expect(organicStanding(cohort({ organicity: tied })))
      .toEqual({ score: 80, rank: 1, size: 4 });
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: tied,
    }));
    expect(h.strengthWhy).toContain("4팀 중 1위");
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
