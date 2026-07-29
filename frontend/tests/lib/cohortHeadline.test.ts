// 동시기 성과 헤드라인 순수 로직 — 투자사에게 그대로 읽히는 문구라
// "언제 강점으로 세우고 언제 광고 근거를 붙이는가"를 테스트로 고정한다.
import { describe, expect, it, test } from "vitest";
import {
  AD_SUSPECT_METRICS, NEAR_TIE_RATIO, ORG_AD_SUSPECT_THRESHOLD,
  PRE_EFFICIENCY_OUTLIER_RATIO,
  adJudgeScore, cohortComposition, debutDateRange, exPaidNote, fmtDelta,
  headline, nearTieKeys, organicStanding,
  type CohortData, type OrgRow, type ScRow,
} from "../../src/lib/cohortHeadline";
import { VERDICT_THRESHOLDS } from "../../src/lib/organicity";

/** 스코어카드 행. 필요한 필드만 덮어쓴다. */
const row = (over: Partial<ScRow> & { group_key: string }): ScRow => ({
  value_at_day: 1000, growth_multiple: 2,
  source: "live", reference: false,
  base_day: 0, base_value: 400, at_day: 43, base_source: "live",
  pre_multiple: 1.5, subs_per_1k_pre: 2.1, subs_per_1k_post: 1.4,
  pre_value: 400, pre_day: -30, pre_source: "live",
  total_multiple: 5, total_anchor_day: -30, total_anchor_source: "live",
  ...over,
});

/** 순위·모수만 바꿔가며 쓰는 스코어카드 한 칸. */
const sc = (
  miiwan_rank: number | null,
  cohort_size: number,
  mult: number | null = 2,
  extraRows: ScRow[] = [],
) => ({
  rows: [row({ group_key: "miiwan", growth_multiple: mult }), ...extraRows],
  miiwan_rank, cohort_size,
});

const org = (
  group_key: string, score: number | null, reference = false,
  score_view_weighted?: number | null,
): OrgRow => ({ group_key, score, video_count: 5, reference, score_view_weighted });

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

describe("headline — 리드·한 줄 결론", () => {
  test("리드에 경과일과 달력 데뷔일을 함께 쓴다", () => {
    const h = headline(cohort({
      groups: { miiwan: { name: "MiiWAN", debut_date: "2026-06-16", reference: false } },
    }));
    expect(h.lead).toContain("D+43일 차");
    expect(h.lead).toContain("2026-06-16 데뷔");
  });

  test("데뷔일이 없으면 날짜를 지어내지 않는다", () => {
    const h = headline(cohort());
    expect(h.lead).toContain("D+43일 차");
    expect(h.lead).not.toContain("(");
  });

  // 배수·순위만 있으면 "3위 = 못했다"로 끝난다. 순증과 출발선 순위를 같은
  // 문장에 넣어야 "왜 배수가 낮은가"가 결론 안에서 풀린다.
  test("한 줄 결론 = 배수 · 순증 · 순위 · 출발선 순위", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(3, 4, 1.1, [
          row({ group_key: "owis", growth_multiple: 2.2, base_value: 900 }),
          row({ group_key: "bthd", growth_multiple: 1.5, base_value: 300 }),
          row({ group_key: "skinz", growth_multiple: 1.2, base_value: 200 }),
        ]),
      },
    }));
    expect(h.conclusion).toContain("구독자 1.1×");
    expect(h.conclusion).toContain("(+600명)"); // 1000 − 400
    expect(h.conclusion).toContain("4팀 중 3위");
    // 출발선 400 은 4팀 중 2위 규모 → 구조적 설명이 붙는다.
    expect(h.conclusion).toContain("4팀 중 2위 규모라 배수가 구조적으로 낮게 나온다");
  });

  test("출발선이 작은 편이면 '구조적으로 낮다'고 말하지 않는다", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(3, 3, 1.1, [
          row({ group_key: "owis", growth_multiple: 2.2, base_value: 90_000 }),
          row({ group_key: "bthd", growth_multiple: 1.5, base_value: 50_000 }),
        ]),
      },
    }));
    expect(h.conclusion).toContain("3팀 중 3위 규모");
    expect(h.conclusion).not.toContain("구조적으로");
  });

  test("배수가 없으면 결론을 만들지 않는다 (빈 값 위장 금지)", () => {
    expect(headline(cohort({ scorecard: { yt_subscribers: sc(null, 3, null) } })).conclusion)
      .toBeNull();
  });
});

describe("headline — 강·약점 분류", () => {
  test("상위 절반은 강점, 하위 절반은 1위 수치·보완 방향까지 붙여 약점", () => {
    const h = headline(cohort({
      groups: { owis: { name: "OWIS", debut_date: null, reference: false } },
      scorecard: {
        yt_subscribers: sc(1, 4, 2.4),
        yt_total_views: sc(4, 4, 1.1, [
          row({ group_key: "owis", growth_multiple: 2.2 }),
        ]),
      },
    }));
    expect(h.strengths.some((s) => s.includes("구독자 2.4×"))).toBe(true);
    const weak = h.weaknesses.find((w) => w.includes("누적 조회수"))!;
    expect(weak).toContain("4팀 중 4위");
    // H5 — 1위가 누구인지·얼마인지 없이는 격차를 논의할 수 없다.
    expect(weak).toContain("1위 OWIS 2.2×");
    // H7 — 은어 없이 결정 지향으로.
    expect(weak).toContain("제작 회의");
    expect(weak).not.toContain("후킹");
    expect(h.neutral).toBeNull();
  });

  // H2 — 데뷔 후 배수만 보면 "데뷔 시점에 이미 팬덤이 있었다"가 사라진다.
  // H6 — 데뷔 전 값이 없는 팀은 이 순위 모수에서 빠지므로 분모가 데뷔 후
  // 순위와 달라진다. 그래서 분모를 그 자리에서 스스로 설명하게 쓴다.
  test("데뷔 전 성장이 상위면 강점 + 의미 부연, 분모는 자기 설명", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(3, 4, 1.1, [
          row({ group_key: "owis", growth_multiple: 2.2, pre_multiple: 1.0 }),
          row({ group_key: "bthd", growth_multiple: 1.5, pre_multiple: 1.2 }),
          // 데뷔 전 값이 없는 팀 → 데뷔 전 순위 모수(4팀 아님)에서 빠진다.
          row({ group_key: "skinz", growth_multiple: 1.2, pre_multiple: null }),
        ]),
      },
    }));
    const pre = h.strengths.find((s) => s.includes("데뷔 전 성장"))!;
    expect(pre).toContain("데뷔 전 값이 있는 3팀 중 1위");
    expect(pre).toContain("데뷔 시점에 이미 팬덤을 만들었다");
  });

  test("데뷔 전 성장이 하위 절반이면 약점으로 — 강점 자리에 넣지 않는다", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(3, 4, 1.1, [
          row({ group_key: "owis", growth_multiple: 2.2, pre_multiple: 9 }),
          row({ group_key: "bthd", growth_multiple: 1.5, pre_multiple: 8 }),
          row({ group_key: "skinz", growth_multiple: 1.2, pre_multiple: null }),
        ]),
      },
    }));
    expect(h.strengths.find((s) => s.includes("데뷔 전 성장"))).toBeUndefined();
    expect(h.weaknesses.some((w) => w.includes("데뷔 전 값이 있는 3팀 중 3위"))).toBe(true);
  });

  // H3 — 빈 블록은 '숨김'으로 읽힌다.
  test("강점이 없으면 빈 블록 대신 없다고 쓴다", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(4, 4, 1.1, [
          row({ group_key: "owis", growth_multiple: 2.2, pre_multiple: 9 }),
          row({ group_key: "bthd", growth_multiple: 2.0, pre_multiple: 8 }),
        ]),
      },
    }));
    expect(h.strengths).toEqual([]);
    expect(h.strengthsEmpty).toContain("상위 절반에 든 항목이 없다");
  });

  test("비교 대상이 1팀뿐이면(자기 자신) 순위를 세지 않는다", () => {
    const h = headline(cohort({ scorecard: { yt_subscribers: sc(1, 1) } }));
    expect(h.strengths).toEqual([]);
    expect(h.weaknesses).toEqual([]);
    expect(h.neutral).not.toBeNull();
    // 한 줄 결론도 같은 가드를 쓴다 — "1팀 중 1위"가 렌더되면 표 각주의
    // "비교 대상 부족"과 화면 안에서 정면 충돌한다. 배수·순증은 사실이라 남긴다.
    expect(h.conclusion).toBe("구독자 2.0× (+600명).");
    expect(h.conclusion).not.toContain("위");
  });

  test("강·약점 둘 다 없으면 중립 문구로 폴백", () => {
    const h = headline(cohort({ scorecard: { yt_subscribers: sc(null, 3, null) } }));
    expect(h.strengths).toEqual([]);
    expect(h.weaknesses).toEqual([]);
    expect(h.neutral).toContain("데뷔일 시점 데이터");
    expect(h.organicNote).toBeNull();
  });
});

// H4 — 자연 유입 위치는 강·약점과 독립이다. 자기 점수가 기준 아래면
// 상위권이어도 그 사실을 먼저 말한다(상위권이라고 자기 약점을 생략하면 숨김).
describe("headline — 자연 유입 문장(H4)", () => {
  test("기준 위 + 상위 절반이면 상대 표현으로 덧붙인다", () => {
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [org("miiwan", 82), org("myrakl", 60)],
    }));
    expect(h.organicNote).toContain("82점");
    expect(h.organicNote).toContain("판정 가능한 2팀 중 1위");
    expect(h.organicNote).toContain("낮은 편");
    // 단정 금지 — "광고가 아니라 팬이 만든 것" 류의 확정 표현은 쓰지 않는다.
    expect(h.organicNote).not.toContain("팬이 스스로 찾아와 만든 것");
  });

  test("강점이 하나도 없어도 노출된다 (게이트 제거)", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(4, 4, 1.1, [
          row({ group_key: "owis", growth_multiple: 2.2, pre_multiple: 9 }),
          row({ group_key: "bthd", growth_multiple: 2.0, pre_multiple: 8 }),
        ]),
      },
      organicity: [org("miiwan", 82), org("myrakl", 60)],
    }));
    expect(h.strengths).toEqual([]);
    expect(h.organicNote).toContain("판정 가능한 2팀 중 1위");
  });

  test("자기 점수가 기준 아래면 상위권이어도 그 사실을 먼저 쓴다", () => {
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [
        org("miiwan", ORG_AD_SUSPECT_THRESHOLD - 5),
        org("myrakl", 30),
      ],
    }));
    // 완성 문장으로 고정한다 — "다만 …2팀 중 1위로 상대적으로는 낮은 편"처럼
    // 주어가 빠지면 "순위가 낮다"로 읽혀 뜻이 정반대가 된다.
    expect(h.organicNote).toBe(
      `자연 유입 점수 ${ORG_AD_SUSPECT_THRESHOLD - 5}점으로 자체 기준`
      + `(${ORG_AD_SUSPECT_THRESHOLD}점) 아래라 우리 성장에도 광고 몫이 섞여 있을 수 있다.`
      + " 다만 판정 가능한 2팀 중 1위로, 유료 광고에 기댄 정도는 상대적으로 낮은 편이다.",
    );
  });

  // F1 — 회색 지대(suspect ≤ score < organic)는 순위와 무관하게 항상 노출돼야
  // 한다. 이전엔 "기준 미만" 분기도 "상위권" 분기도 못 걸려 H4 줄 자체가
  // 통째로 사라졌다 — 2026-07-29 실측(miiwan 41.4점 · 판정 가능 6팀 중 4위)이
  // 정확히 이 구간이다.
  test("회색 지대(기준 이상·organic 미만)면 순위와 무관하게 경계 문구를 낸다", () => {
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [
        org("bdawn", 37.4), org("bthd", 45.6), org("miiwan", 41.4),
        org("myrakl", 29.8), org("owis", 46.7), org("skinz", 43.6),
      ],
    }));
    // 판정 가능 6팀 중 miiwan(41.4)보다 큰 값은 45.6·46.7·43.6 → 4위,
    // 상위 절반(3위 이내) 밖이라 예전 "상위권" 분기 조건도 만족 못 한다.
    expect(h.organicNote).toBe(
      "자연 유입 점수 41.4점 — 광고 과다 기준선(40점)은 넘었지만 자연 유입 우세"
      + " 기준(70점)에는 못 미쳐, 우리 성장에도 광고 몫이 섞여 있을 수 있다.",
    );
  });

  test("회색 지대 경계값(기준 자체)도 회색 지대 문구를 낸다 — 기준 미만 분기와 안 겹친다", () => {
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [org("miiwan", ORG_AD_SUSPECT_THRESHOLD), org("myrakl", 90)],
    }));
    expect(h.organicNote).toContain(`${ORG_AD_SUSPECT_THRESHOLD}점`);
    expect(h.organicNote).toContain("넘었지만 자연 유입 우세");
  });

  test("점수가 null 인 그룹은 근거 없이 광고 판정을 하지 않는다", () => {
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      organicity: [org("miiwan", null), org("myrakl", 60)],
    }));
    expect(h.organicNote).toBeNull();
  });

  // B1 — 판정 점수는 두 기준 중 낮은 쪽. 조회수가 광고성 영상 몇 편에 쏠려
  // 편수 점수만 깨끗한 팀이 통과하면 안 된다.
  test("판정 점수는 편수·조회수 중 낮은 쪽", () => {
    expect(adJudgeScore(org("x", 90, false, 30))).toBe(30);
    expect(adJudgeScore(org("x", 30, false, 90))).toBe(30);
    expect(adJudgeScore(org("x", 55))).toBe(55);          // 조회수 점수 없음
    expect(adJudgeScore(org("x", null, false, 40))).toBeNull();
    const h = headline(cohort({
      scorecard: { yt_subscribers: sc(1, 4) },
      // 편수로는 기준 위(90)지만 조회수로는 아래(30) → 판정은 30.
      organicity: [org("miiwan", 90, false, 30), org("myrakl", 20)],
    }));
    expect(h.organicNote).toContain("30점");
    expect(h.organicNote).toContain("자체 기준");
  });
});

// H8 — 팀명은 쓰지 않는다. 우리가 질 수 없는 주장이라 수치는 표에만 둔다.
describe("headline — 유가 정황 종합(H8)", () => {
  test("기준 아래 경쟁 팀이 있으면 정황을 한 줄로, 팀명 없이", () => {
    const h = headline(cohort({
      groups: { owis: { name: "OWIS", debut_date: null, reference: false } },
      scorecard: {
        yt_subscribers: sc(1, 3, 2, [row({ group_key: "owis", growth_multiple: 3 })]),
      },
      organicity: [org("miiwan", 82), org("owis", 30)],
    }));
    expect(h.paidSignalNote).toContain("유료 캠페인 정황");
    expect(h.paidSignalNote).not.toContain("OWIS");
  });

  test("데뷔 전 구독 효율이 자사 대비 배수 이상인 팀도 정황으로 본다", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(1, 3, 2, [row({
          group_key: "owis", growth_multiple: 3,
          subs_per_1k_pre: 2.1 * PRE_EFFICIENCY_OUTLIER_RATIO,
        })]),
      },
      organicity: [org("miiwan", 82), org("owis", 90)],
    }));
    expect(h.paidSignalNote).not.toBeNull();
  });

  test("정황이 없으면 문장을 만들지 않는다", () => {
    const h = headline(cohort({
      scorecard: {
        yt_subscribers: sc(1, 3, 2, [row({ group_key: "owis", growth_multiple: 3 })]),
      },
      organicity: [org("miiwan", 82), org("owis", 90)],
    }));
    expect(h.paidSignalNote).toBeNull();
  });
});

describe("organicStanding", () => {
  test("참조 그룹(PLAVE)은 순위 모수에서 빠진다", () => {
    const s = organicStanding(cohort({
      organicity: [org("miiwan", 70), org("myrakl", 90), org("plave", 95, true)],
    }));
    // plave 를 세면 3팀 중 3위가 되지만, 표·곡선과 같은 규칙으로 제외.
    expect(s).toEqual({ score: 70, judgeScore: 70, rank: 2, size: 2 });
  });

  test("순위도 판정 점수(min) 기준 — 배지와 다른 숫자로 줄 세우지 않는다", () => {
    const s = organicStanding(cohort({
      // 편수로는 miiwan 90 > myrakl 80 이지만, 판정 점수는 40 < 80.
      organicity: [org("miiwan", 90, false, 40), org("myrakl", 80)],
    }));
    expect(s).toEqual({ score: 90, judgeScore: 40, rank: 2, size: 2 });
  });

  test("점수 없는 팀은 분모에 넣지 않는다", () => {
    const s = organicStanding(cohort({
      organicity: [org("miiwan", 80), org("myrakl", null), org("owis", null)],
    }));
    expect(s).toEqual({ score: 80, judgeScore: 80, rank: 1, size: 1 });
  });

  test("미완이 점수 자체가 없으면 null", () => {
    expect(organicStanding(cohort({ organicity: [org("myrakl", 80)] }))).toBeNull();
    expect(organicStanding(cohort())).toBeNull();
  });

  test("점수 동률이면 같은 순위 (경쟁 순위)", () => {
    expect(organicStanding(cohort({
      organicity: [org("miiwan", 80), org("myrakl", 80), org("owis", 50)],
    }))).toEqual({ score: 80, judgeScore: 80, rank: 1, size: 3 });
  });
});

// E2 — 추정치가 낀 근소한 차이는 순서를 확정하지 않는다. 실측끼리의 차이는
// 작아도 그대로 둔다(표기용 휴리스틱이지 오차 모형이 아니다).
describe("nearTieKeys", () => {
  test("est 가 낀 인접 쌍의 배수 차이가 임계 이하면 둘 다 표시", () => {
    const rows = [
      row({ group_key: "a", growth_multiple: 2.0 }),
      row({ group_key: "b", growth_multiple: 1.95, source: "backfill_estimate" }),
      row({ group_key: "c", growth_multiple: 1.0 }),
    ];
    expect([...nearTieKeys(rows)].sort()).toEqual(["a", "b"]);
  });

  test("실측끼리의 근소한 차이는 표시하지 않는다", () => {
    const rows = [
      row({ group_key: "a", growth_multiple: 2.0 }),
      row({ group_key: "b", growth_multiple: 1.95 }),
    ];
    expect(nearTieKeys(rows).size).toBe(0);
  });

  test("차이가 임계를 넘으면 est 가 껴도 표시하지 않는다", () => {
    const rows = [
      row({ group_key: "a", growth_multiple: 2.0 }),
      row({ group_key: "b", growth_multiple: 2.0 * (1 - NEAR_TIE_RATIO) - 0.01,
            base_source: "backfill_estimate" }),
    ];
    expect(nearTieKeys(rows).size).toBe(0);
  });

  test("참조 그룹은 순위 밖이라 쌍을 만들지 않는다", () => {
    const rows = [
      row({ group_key: "a", growth_multiple: 2.0 }),
      row({ group_key: "plave", growth_multiple: 1.98, reference: true,
            source: "backfill_estimate" }),
    ];
    expect(nearTieKeys(rows).size).toBe(0);
  });
});

describe("코호트 구성·데뷔일 범위", () => {
  test("후보·확보·제외·참고 팀 수를 응답에서 센다", () => {
    const c = cohortComposition(cohort({
      groups: {
        miiwan: { name: "MiiWAN", debut_date: "2026-06-16", reference: false },
        owis: { name: "OWIS", debut_date: "2026-05-02", reference: false },
        plave: { name: "PLAVE", debut_date: "2023-03-12", reference: true },
      },
      scorecard: { yt_subscribers: sc(1, 2) },
      excluded: [
        { group_key: "bthd", metric: "yt_subscribers", reason: "no_at_day_value" },
        { group_key: "bthd", metric: "yt_total_views", reason: "no_at_day_value" },
      ],
    }), "yt_subscribers");
    expect(c).toEqual({
      candidates: 2, withData: 2, excluded: 1, referenceNames: ["PLAVE"],
    });
  });

  test("데뷔일 범위는 참조 제외 실데이터에서 — 없으면 null", () => {
    expect(debutDateRange(cohort({
      groups: {
        miiwan: { name: "MiiWAN", debut_date: "2026-06-16", reference: false },
        owis: { name: "OWIS", debut_date: "2026-05-02", reference: false },
        plave: { name: "PLAVE", debut_date: "2023-03-12", reference: true },
      },
    }))).toEqual({ from: "2026-05-02", to: "2026-06-16" });
    expect(debutDateRange(cohort())).toBeNull();
  });
});

describe("ORG_AD_SUSPECT_THRESHOLD", () => {
  it("과다 사용 티어(suspect 컷) 미만만 광고 의심으로 본다", () => {
    // 2026-07-29 실측: min 판정점수가 전 그룹 29.8~58.9라 organic(70) 컷은
    // 참조 PLAVE까지 전원을 걸어 배지가 정보를 잃었다. suspect(40) 컷이면
    // 뚜렷한 하위 2팀(myrakl 29.8 · bdawn 37.4)만 남는다.
    expect(ORG_AD_SUSPECT_THRESHOLD).toBe(VERDICT_THRESHOLDS.suspect);
    expect(ORG_AD_SUSPECT_THRESHOLD).toBe(40);
  });
});

describe("상수·표기", () => {
  // 손으로 적은 40 이 아니라 suspect 등급 컷을 재사용해야 한다 —
  // organicity.ts 헤더가 경고하는 hand-copy desync 방지.
  test("광고 의심 임계 = organicity.ts 의 suspect 등급 컷", () => {
    expect(ORG_AD_SUSPECT_THRESHOLD).toBe(VERDICT_THRESHOLDS.suspect);
  });

  test("광고 의심 대상은 유튜브 지표만", () => {
    expect([...AD_SUSPECT_METRICS].sort()).toEqual(["yt_subscribers", "yt_total_views"]);
    expect(AD_SUSPECT_METRICS.has(OTHER_METRIC)).toBe(false);
  });

  test("순증 표기 — 감소도 숨기지 않는다", () => {
    expect(fmtDelta(2200, "명")).toBe("+2,200명");
    expect(fmtDelta(-30, "명")).toBe("−30명");
    expect(fmtDelta(null, "명")).toBeNull();
  });
});

describe("exPaidNote", () => {
  const base = { group_key: "miiwan", score: 74, video_count: 122, reference: false,
    score_view_weighted: 41.4, window_video_count: 122, paid_video_count: 14,
    paid_view_share: 0.712, score_view_weighted_ex_paid: 69.5 };
  test("유료 판정 편수·조회수 점유·제외 점수를 한 문장으로 만든다", () => {
    const note = exPaidNote(base as OrgRow);
    expect(note).toContain("14편");
    expect(note).toContain("71%");
    expect(note).toContain("69.5점");
  });
  test("유료 판정이 0편이거나 필드가 없으면 null", () => {
    expect(exPaidNote({ ...base, paid_video_count: 0 } as OrgRow)).toBeNull();
    expect(exPaidNote({ ...base, score_view_weighted_ex_paid: null } as OrgRow)).toBeNull();
    expect(exPaidNote(undefined)).toBeNull();
  });
});
