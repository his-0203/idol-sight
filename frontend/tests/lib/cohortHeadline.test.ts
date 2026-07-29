// 동시기 성과 헤드라인 순수 로직 — 투자사에게 그대로 읽히는 문구라
// "언제 강점으로 세우고 언제 광고 근거를 붙이는가"를 테스트로 고정한다.
import { describe, expect, it, test } from "vitest";
import {
  AD_SUSPECT_METRICS, NEAR_TIE_RATIO, ORG_AD_SUSPECT_THRESHOLD, THRESHOLD_NEAR_BAND,
  adJudgeScore, cohortComposition, curveVerdict, debutDateRange, exPaidNote, fmtDelta,
  fmtMultiple, headline, nearTieKeys, organicStanding, organicityVerdict, scorecardVerdict,
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
  });
});

// B1 — 판정 점수는 두 기준 중 낮은 쪽. 조회수가 광고성 영상 몇 편에 쏠려
// 편수 점수만 깨끗한 팀이 통과하면 안 된다. (organicNote 를 통한 간접
// 검증은 헤드라인 보조 문장 제거와 함께 정리 — 이 함수 자체는 adScoreMap·
// organicStanding 이 계속 쓴다.)
describe("adJudgeScore", () => {
  test("판정 점수는 편수·조회수 중 낮은 쪽", () => {
    expect(adJudgeScore(org("x", 90, false, 30))).toBe(30);
    expect(adJudgeScore(org("x", 30, false, 90))).toBe(30);
    expect(adJudgeScore(org("x", 55))).toBe(55);          // 조회수 점수 없음
    expect(adJudgeScore(org("x", null, false, 40))).toBeNull();
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

// 성장곡선(③)의 MiiWAN 읽기 — 곡선은 기울기만 보이고 "그래서 우리는?"이
// 없다. PRIMARY_METRIC 고정 — 탭을 바꿔도 이 카드의 결론은 안 바뀐다.
describe("curveVerdict", () => {
  test("순증>0 — good에 순증·정체 팀 수, weak에 배수·하위권", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", value_at_day: 1000, base_value: 400, growth_multiple: 2.5 }),
            row({ group_key: "owis", growth_multiple: 1.0 }),   // 정체(<=1)
            row({ group_key: "bthd", growth_multiple: 3.0 }),   // 정체 아님
          ],
          miiwan_rank: 3, cohort_size: 3,
        },
      },
    });
    const v = curveVerdict(d);
    expect(v.good).toContain(fmtDelta(600, "명")!);
    expect(v.good).toContain("1팀과 대비된다");
    expect(v.weak).toContain(fmtMultiple(2.5));
    expect(v.weak).toContain("하위권");
  });

  test("순증>0인데 정체 팀이 0이면 대비 문구를 붙이지 않는다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [row({ group_key: "miiwan", value_at_day: 1000, base_value: 400, growth_multiple: 2.5 })],
          miiwan_rank: 1, cohort_size: 1,
        },
      },
    });
    const v = curveVerdict(d);
    expect(v.good).toContain("증가를 유지하고 있다.");
    expect(v.good).not.toContain("대비된다");
  });

  test("순증<=0 — good은 null, weak엔 감소를 명시", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [row({ group_key: "miiwan", value_at_day: 400, base_value: 500, growth_multiple: 0.8 })],
          miiwan_rank: 1, cohort_size: 1,
        },
      },
    });
    const v = curveVerdict(d);
    expect(v.good).toBeNull();
    expect(v.weak).toContain(fmtDelta(-100, "명")!);
    expect(v.weak).toContain("증가가 멈춰 있다");
  });

  test("순증을 낼 값(출발선·D+N 값)이 없으면 배수만으로 하위권을 말한다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [row({ group_key: "miiwan", value_at_day: null, base_value: null, growth_multiple: 0.9 })],
          miiwan_rank: 1, cohort_size: 1,
        },
      },
    });
    const v = curveVerdict(d);
    expect(v.good).toBeNull();
    expect(v.weak).toContain(fmtMultiple(0.9));
    expect(v.weak).toContain("하위권");
  });

  test("데이터 없음(미완 행·배수 모두) — good·weak 모두 null", () => {
    expect(curveVerdict(cohort())).toEqual({ good: null, weak: null });
    const d = cohort({
      scorecard: { yt_subscribers: { rows: [row({ group_key: "miiwan", growth_multiple: null })], miiwan_rank: null, cohort_size: 1 } },
    });
    expect(curveVerdict(d)).toEqual({ good: null, weak: null });
  });

  test("숫자는 픽스처에서 파생 — D+N 값을 바꾸면 순증 문구도 바뀐다", () => {
    const build = (valueAtDay: number) => cohort({
      scorecard: {
        yt_subscribers: {
          rows: [row({ group_key: "miiwan", value_at_day: valueAtDay, base_value: 400, growth_multiple: 2.0 })],
          miiwan_rank: 1, cohort_size: 1,
        },
      },
    });
    expect(curveVerdict(build(1000)).good).toContain(fmtDelta(600, "명")!);
    expect(curveVerdict(build(2000)).good).toContain(fmtDelta(1600, "명")!);
  });
});

// 팀별 상세표(④)의 MiiWAN 읽기 — 표의 5개 숫자 중 무엇이 강점/약점인지
// 표만 봐서는 안 읽힌다. null-안전(값·순위 모수가 없으면 그 절만 null).
describe("scorecardVerdict", () => {
  test("good — 출발선·데뷔 전 배수 순위, 1위면 부연 문장을 붙인다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 900, pre_multiple: 3.0 }),
            row({ group_key: "owis", base_value: 400, pre_multiple: 1.5 }),
            row({ group_key: "bthd", base_value: 200, pre_multiple: 1.2 }),
          ],
          miiwan_rank: 1, cohort_size: 3,
        },
      },
    });
    const v = scorecardVerdict(d, "yt_subscribers");
    expect(v.good).toContain("3팀 중 1위");
    expect(v.good).toContain(fmtMultiple(3.0));
    expect(v.good).toContain("이미 팬덤을 쌓아둔 팀이다");
  });

  test("good — 데뷔 전 배수 1위가 아니면 부연 문장이 없다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 900, pre_multiple: 1.2 }),
            row({ group_key: "owis", base_value: 400, pre_multiple: 3.0 }),
          ],
          miiwan_rank: 1, cohort_size: 2,
        },
      },
    });
    const v = scorecardVerdict(d, "yt_subscribers");
    // 출발선(base_value)은 900 > 400 이라 1위지만, 데뷔 전 배수(pre_multiple)는
    // 1.2 < 3.0 이라 2위 — 두 순위가 갈리는 걸 그대로 보여준다.
    expect(v.good).toContain("2팀 중 1위");
    expect(v.good).toContain(`${fmtMultiple(1.2)}는 2위`);
    expect(v.good).not.toContain("이미 팬덤을 쌓아둔 팀이다");
  });

  test("weak — 데뷔 후 배수 순위 + 저베이스 각주 취지", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", growth_multiple: 1.1 }),
            row({ group_key: "owis", growth_multiple: 3.0 }),
          ],
          miiwan_rank: 2, cohort_size: 2,
        },
      },
    });
    const v = scorecardVerdict(d, "yt_subscribers");
    expect(v.weak).toContain(fmtMultiple(1.1));
    expect(v.weak).toContain("2팀 중 2위다");
    expect(v.weak).toContain("출발선이 큰 만큼");
  });

  test("null-안전 — 순위 모수(miiwan_rank·cohort_size)가 없으면 weak는 null", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: { rows: [row({ group_key: "miiwan" })], miiwan_rank: null, cohort_size: 1 },
      },
    });
    expect(scorecardVerdict(d, "yt_subscribers").weak).toBeNull();
  });

  test("null-안전 — 출발선·데뷔 전 배수 중 하나라도 없으면 good은 null", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: { rows: [row({ group_key: "miiwan", base_value: null })], miiwan_rank: 1, cohort_size: 1 },
      },
    });
    expect(scorecardVerdict(d, "yt_subscribers").good).toBeNull();
  });

  test("미완 행이 없으면 good·weak 모두 null", () => {
    const d = cohort({ scorecard: { yt_subscribers: { rows: [], miiwan_rank: null, cohort_size: 0 } } });
    expect(scorecardVerdict(d, "yt_subscribers")).toEqual({ good: null, weak: null });
  });
});

// 자연 유입 섹션(⑤)의 MiiWAN 읽기 — 헤드라인에서 뺀 자기공시(판정 점수 ↔
// 기준선 관계, 광고 영향을 배제하기 어렵다는 사실)가 여기로 옮겨온다.
// 이 이동을 보존하는 가드 테스트: weak에 그 문구가 반드시 들어가야 한다.
describe("organicityVerdict", () => {
  test("good — 편수 점수·순위, organic 이상이면 우세 등급 문구", () => {
    const d = cohort({ organicity: [org("miiwan", 75), org("owis", 60), org("bthd", 50)] });
    const v = organicityVerdict(d);
    expect(v.good).toContain("75점");
    expect(v.good).toContain("3팀 중 1위");
    expect(v.good).toContain("자연 유입 우세 등급이다");
  });

  test("good — organic 미만이면 우세 등급 문구를 붙이지 않는다", () => {
    const d = cohort({ organicity: [org("miiwan", 55), org("owis", 60)] });
    const v = organicityVerdict(d);
    expect(v.good).not.toContain("우세 등급");
    expect(v.good).toContain("콘텐츠 대부분은 자연 소비되고 있다");
  });

  // 자기공시 이동 보존 가드 — 헤드라인에서 지운 organicNote 의 핵심
  // 내용(기준선 관계 + 광고 영향 배제 어려움)이 이 함수의 weak로 옮겨왔다.
  test("weak — 판정 점수가 기준선 아래면 기준선 관계 + 배제 어려움을 반드시 포함한다", () => {
    // score=55, score_view_weighted=35 → judge=min(55,35)=35 < suspect(40).
    const d = cohort({ organicity: [org("miiwan", 55, false, 35), org("owis", 90)] });
    const v = organicityVerdict(d);
    expect(v.weak).toContain(`${ORG_AD_SUSPECT_THRESHOLD}점`);
    expect(v.weak).toContain("35점");
    expect(v.weak).toContain("광고 영향을 배제하기 어렵다");
    expect(v.weak).toContain("조회수가 소수 광고성 영상에 쏠린");
  });

  test("weak — 판정 점수가 기준선 부근(±THRESHOLD_NEAR_BAND)이면 '부근이라'", () => {
    // judge=45 (score_view_weighted 없음) → 45 - suspect(40) = 5 <= THRESHOLD_NEAR_BAND(10).
    const d = cohort({ organicity: [org("miiwan", 45), org("owis", 90)] });
    const v = organicityVerdict(d);
    expect(v.weak).toContain("부근이라");
    expect(v.weak).toContain("광고 영향을 배제하기 어렵다");
  });

  test("weak — 기준선 위지만 organic 미만이면 '자연 유입 우세에는 못 미쳐'", () => {
    // judge=55, 55 - suspect(40) = 15 > THRESHOLD_NEAR_BAND(10), 55 < organic(70).
    const d = cohort({ organicity: [org("miiwan", 55), org("owis", 90)] });
    const v = organicityVerdict(d);
    expect(v.weak).toContain("위지만");
    expect(v.weak).toContain("못 미쳐");
  });

  test("weak — 판정 점수가 organic 이상이면 null", () => {
    const d = cohort({ organicity: [org("miiwan", 90), org("owis", 80)] });
    expect(organicityVerdict(d).weak).toBeNull();
  });

  test("점수가 없으면 good·weak 모두 null", () => {
    expect(organicityVerdict(cohort({ organicity: [org("miiwan", null)] }))).toEqual({ good: null, weak: null });
    expect(organicityVerdict(cohort())).toEqual({ good: null, weak: null });
  });

  test("숫자는 픽스처에서 파생 — 점수를 바꾸면 good 문구의 숫자도 바뀐다", () => {
    const v1 = organicityVerdict(cohort({ organicity: [org("miiwan", 65), org("owis", 50)] }));
    const v2 = organicityVerdict(cohort({ organicity: [org("miiwan", 72), org("owis", 50)] }));
    expect(v1.good).toContain("65점");
    expect(v2.good).toContain("72점");
  });

  test("THRESHOLD_NEAR_BAND는 cohortQuality.ts의 산점도 판단과 값이 같다", () => {
    // 브리프 지시: THRESHOLD_NEAR_BAND는 삭제하지 않고 재사용 — cohortHeadline.ts로
    // 옮긴 뒤에도 값 자체(10)는 그대로다.
    expect(THRESHOLD_NEAR_BAND).toBe(10);
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
  // 제외 점수(69.5)가 판정 점수(41.4)보다 한참 높게 나오는 게 정상이라
  // (제외 기준 = 판정선) 앵커가 없으면 투자사 독자가 제외 점수를 결론
  // 점수로 가져간다. 앵커 숫자는 데이터 파생(min 규칙)이지 상수가 아니다.
  test("판정 점수 앵커를 붙여 판정·배지가 그대로임을 못 박는다", () => {
    const note = exPaidNote(base as OrgRow)!;
    expect(note).toContain("판정 점수 41.4점");   // = min(편수 74, 조회수 41.4)
    expect(note).toContain("광고 의심");
  });
  test("판정 점수가 없으면 숫자 없이 앵커만 (없는 값을 지어내지 않는다)", () => {
    const note = exPaidNote({ ...base, score: null } as OrgRow)!;
    expect(note).toContain("위 판정 점수와");
    expect(note).not.toMatch(/판정 점수 [\d.]+점/);
  });
  // 데이터에서 파생되지 않는 결론("나머지는 자연 소비")은 문장에 없다 —
  // 제외 뒤 남은 조회수에도 의심 대역이 섞여 있어 단정할 수 없다.
  test("고정 해석 문구를 덧붙이지 않는다", () => {
    const note = exPaidNote(base as OrgRow)!;
    expect(note).not.toContain("자연 소비");
    expect(note).not.toContain("자연 유입에 가깝");
  });
});
