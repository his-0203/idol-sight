// 동시기 성과 헤드라인 순수 로직 — 투자사에게 그대로 읽히는 문구라
// "언제 강점으로 세우고 언제 광고 근거를 붙이는가"를 테스트로 고정한다.
import { describe, expect, it, test } from "vitest";
import {
  AD_SUSPECT_METRICS, EX_PAID_LABEL, NEAR_TIE_RATIO, NEXT_REPORT_ACTIONS,
  ORG_ACTION_HINT, ORG_AD_SUSPECT_THRESHOLD, THRESHOLD_NEAR_BAND,
  nextReportCard,
  activityRows, activityVerdict,
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

/**
 * 유기성 한 행. videos 는 영상 단위 집계(창 내 판정 편수 / 그중 유료 편수) —
 * N8 이후 organicityVerdict 의 "대부분 ~" 절이 편수 점수 평균이 아니라 이
 * 실제 비율로 게이트되므로, 그 절을 다루는 테스트만 이 값을 넘긴다.
 */
const org = (
  group_key: string, score: number | null, reference = false,
  score_view_weighted?: number | null,
  videos?: { window: number; paid: number },
): OrgRow => ({
  group_key, score, video_count: 5, reference, score_view_weighted,
  ...(videos ? { window_video_count: videos.window, paid_video_count: videos.paid } : {}),
});

/** 유튜브가 아닌 지표(영상 판정과 무관) 자리표시자. */
const OTHER_METRIC = "naver_total_news";

/**
 * 문장 수 = "마침표 + 공백/끝"의 개수. 소수점(41.4)은 뒤에 숫자가 오므로
 * 세지 않는다. K5(문장 다이어트) 가드가 절을 이어 붙인 회귀를 잡는 용도.
 */
const sentenceCount = (s: string) => (s.match(/\.(\s|$)/g) ?? []).length;

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
    // B4 — 이 배수는 growth_multiple(데뷔 후)이라 라벨이 붙는다. 같은 카드의
    // "데뷔 전 성장"·산점도의 "총 성장 배수"와 같은 축으로 읽히면 안 된다.
    expect(h.conclusion).toContain("구독자 데뷔 후 성장 1.1×");
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
    // B4 — 강·약점 항목의 배수에도 "데뷔 후" 수식이 붙는다(같은 목록에
    // "데뷔 전 성장 …" 항목이 나란히 서므로 수식이 없으면 축이 섞인다).
    expect(h.strengths.some((s) => s.includes("구독자 데뷔 후 성장 2.4×"))).toBe(true);
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
    expect(h.conclusion).toBe("구독자 데뷔 후 성장 2.0× (+600명).");
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
    expect(s).toEqual({ score: 70, judgeScore: 70, rank: 2, scoreRank: 2, size: 2 });
  });

  test("순위도 판정 점수(min) 기준 — 배지와 다른 숫자로 줄 세우지 않는다", () => {
    const s = organicStanding(cohort({
      // 편수로는 miiwan 90 > myrakl 80 이지만, 판정 점수는 40 < 80.
      organicity: [org("miiwan", 90, false, 40), org("myrakl", 80)],
    }));
    // 편수 순위(scoreRank)와 판정 순위(rank)가 갈리는 자리 — 같은 모수(size)
    // 안에서 둘 다 나와야 "편수로는 1위인데 판정으로는 2위"를 한 화면에서
    // 모순 없이 쓸 수 있다(C1).
    expect(s).toEqual({ score: 90, judgeScore: 40, rank: 2, scoreRank: 1, size: 2 });
  });

  test("점수 없는 팀은 분모에 넣지 않는다", () => {
    const s = organicStanding(cohort({
      organicity: [org("miiwan", 80), org("myrakl", null), org("owis", null)],
    }));
    expect(s).toEqual({ score: 80, judgeScore: 80, rank: 1, scoreRank: 1, size: 1 });
  });

  test("미완이 점수 자체가 없으면 null", () => {
    expect(organicStanding(cohort({ organicity: [org("myrakl", 80)] }))).toBeNull();
    expect(organicStanding(cohort())).toBeNull();
  });

  test("점수 동률이면 같은 순위 (경쟁 순위)", () => {
    expect(organicStanding(cohort({
      organicity: [org("miiwan", 80), org("myrakl", 80), org("owis", 50)],
    }))).toEqual({ score: 80, judgeScore: 80, rank: 1, scoreRank: 1, size: 3 });
  });
});

// 성장곡선(③)의 MiiWAN 읽기 — 곡선은 기울기만 보이고 "그래서 우리는?"이
// 없다. PRIMARY_METRIC 고정 — 탭을 바꿔도 이 카드의 결론은 안 바뀐다.
describe("curveVerdict", () => {
  test("순증>0 — good에 순증·정체 팀 수, weak에 배수·순위 사실", () => {
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
    // I1 — 예전엔 배수와 무관하게 "완만하다 · 하위권"이 나갔다. 평가어 없이
    // 응답이 준 순위 사실만 쓴다.
    expect(v.weak).toContain("3팀 중 3위다");
    expect(v.weak).not.toContain("완만");
    expect(v.weak).not.toContain("하위권");
  });

  // I1 가드 — 순위는 하드코딩이 아니라 scorecard 에서 파생된다. 같은 shape
  // 에서 miiwan_rank 만 바꾸면 문장의 순위도 따라가야 한다.
  test("weak의 순위는 픽스처의 miiwan_rank를 따라간다", () => {
    const build = (rank: number, size: number) => cohort({
      scorecard: {
        yt_subscribers: {
          rows: [row({ group_key: "miiwan", value_at_day: 1000, base_value: 400, growth_multiple: 2.5 })],
          miiwan_rank: rank, cohort_size: size,
        },
      },
    });
    expect(curveVerdict(build(1, 6)).weak).toContain("6팀 중 1위다");
    expect(curveVerdict(build(5, 6)).weak).toContain("6팀 중 5위다");
  });

  test("비교 대상이 1팀뿐이면 순위 절 없이 배수만 말한다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [row({ group_key: "miiwan", value_at_day: 1000, base_value: 400, growth_multiple: 2.5 })],
          miiwan_rank: 1, cohort_size: 1,
        },
      },
    });
    expect(curveVerdict(d).weak).toBe(`증가 폭은 ${fmtMultiple(2.5)}.`);
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

  test("순증을 낼 값(출발선·D+N 값)이 없으면 배수·순위만 말한다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [row({ group_key: "miiwan", value_at_day: null, base_value: null, growth_multiple: 0.9 })],
          miiwan_rank: 2, cohort_size: 4,
        },
      },
    });
    const v = curveVerdict(d);
    expect(v.good).toBeNull();
    expect(v.weak).toContain(fmtMultiple(0.9));
    expect(v.weak).toContain("4팀 중 2위다");
    expect(v.weak).not.toContain("하위권");
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
    expect(v.good).toContain("출발선(데뷔일 값)은 3팀 중 1위");
    expect(v.good).toContain(`${fmtMultiple(3.0)}는 데뷔 전 값이 있는 3팀 중 1위`);
    expect(v.good).toContain("이미 팬덤을 쌓아둔 팀이다");
  });

  // I4 — 데뷔 전 배수의 모수는 출발선 모수와 다르다(값이 없는 팀 존재).
  // 예전엔 preRank 만 내고 baseN 옆에 붙여 놔 "같은 N팀 중"으로 읽혔고,
  // pre_multiple 이 없는 팀이 암묵적으로 아래 순위로 세어졌다.
  test("good — 데뷔 전 배수 모수는 출발선 모수와 따로 센다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 900, pre_multiple: 3.0 }),
            row({ group_key: "owis", base_value: 400, pre_multiple: 1.5 }),
            // 데뷔 전 값이 없는 팀 — 출발선 모수(3)엔 들어가지만 데뷔 전
            // 모수(2)엔 안 들어가고, 미완이 아래로 세어지지도 않는다.
            row({ group_key: "bthd", base_value: 200, pre_multiple: null }),
            // 참조선(PLAVE)은 양쪽 모수에서 모두 빠진다.
            row({ group_key: "plave", base_value: 9000, pre_multiple: 9.0, reference: true }),
          ],
          miiwan_rank: 1, cohort_size: 3,
        },
      },
    });
    const v = scorecardVerdict(d, "yt_subscribers");
    expect(v.good).toContain("출발선(데뷔일 값)은 3팀 중 1위");
    expect(v.good).toContain("데뷔 전 값이 있는 2팀 중 1위");
  });

  test("good — 데뷔 전 값이 있는 팀이 미완이뿐이면 1위 강조를 붙이지 않는다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 900, pre_multiple: 3.0 }),
            row({ group_key: "owis", base_value: 400, pre_multiple: null }),
          ],
          miiwan_rank: 1, cohort_size: 2,
        },
      },
    });
    const v = scorecardVerdict(d, "yt_subscribers");
    expect(v.good).toContain("데뷔 전 값이 있는 1팀 중 1위");
    expect(v.good).not.toContain("이미 팬덤을 쌓아둔 팀이다");
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
    expect(v.good).toContain("출발선(데뷔일 값)은 2팀 중 1위");
    expect(v.good).toContain(`${fmtMultiple(1.2)}는 데뷔 전 값이 있는 2팀 중 2위`);
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

  // C3(R1 투자 리뷰) — "출발선이 큰 만큼 배수가 작게 나온다"는 출발선이 실제로
  // 큰 편일 때만 참이다. 예전엔 무조건 붙어서 출발선이 하위권인 창에서도 같은
  // 변명이 나갔다. 게이트는 헤드라인 conclusionLine 과 같은 규칙(상위 절반).
  test("weak — 출발선이 하위 절반이면 '출발선이 큰 만큼' 인과를 붙이지 않는다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 200, growth_multiple: 1.1 }),
            row({ group_key: "owis", base_value: 9000, growth_multiple: 3.0 }),
            row({ group_key: "bthd", base_value: 8000, growth_multiple: 2.0 }),
          ],
          miiwan_rank: 3, cohort_size: 3,
        },
      },
    });
    const v = scorecardVerdict(d, "yt_subscribers");
    expect(v.weak).toContain("3팀 중 3위다");
    expect(v.weak).not.toContain("출발선이 큰 만큼");
  });

  test("weak — 출발선이 상위 절반이면 인과를 그대로 붙인다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 9000, growth_multiple: 1.1 }),
            row({ group_key: "owis", base_value: 200, growth_multiple: 3.0 }),
          ],
          miiwan_rank: 2, cohort_size: 2,
        },
      },
    });
    expect(scorecardVerdict(d, "yt_subscribers").weak).toContain("출발선이 큰 만큼");
  });

  // C4(R1 투자 리뷰) — "늘어난 사람 수와 같이 읽는다"는 읽는 법만 주고 정작
  // 그 순위를 안 줬다. 순증(D+N 값 − 출발선) 순위를 데이터로 낸다.
  // F1(R3 타이포 리뷰) — 그 순위는 weak 문장에 이어 붙이지 않고 보조 줄(sub)로
  // 내린다. N5 — 모수는 그 자리에서 스스로 설명한다("순증 값이 있는 N팀 중").
  test("sub — 순증 순위를 보조 줄로 낸다 (모수는 순증을 낼 수 있는 팀만)", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 9000, value_at_day: 11_200, growth_multiple: 1.2 }),
            row({ group_key: "owis", base_value: 200, value_at_day: 3_200, growth_multiple: 16 }),
            // 순증을 낼 수 없는 팀은 분모에서 빠진다(pre/base 와 같은 패턴).
            row({ group_key: "bthd", base_value: null, value_at_day: 500, growth_multiple: 2 }),
            // 참조선도 빠진다.
            row({ group_key: "plave", base_value: 100, value_at_day: 99_999, reference: true }),
          ],
          miiwan_rank: 3, cohort_size: 3,
        },
      },
    });
    const v = scorecardVerdict(d, "yt_subscribers");
    // miiwan +2,200 vs owis +3,000 → 순증 값이 있는 2팀 중 2위.
    expect(v.sub).toBe(`순증(${fmtDelta(2200, "명")})은 순증 값이 있는 2팀 중 2위다.`);
    // 보조 줄로 내렸으므로 weak 문장에는 남지 않는다.
    expect(v.weak).not.toContain("순증(");
    // 순위를 실제로 줬으면 "같이 읽는다"는 안내는 중복이라 뺀다.
    expect(v.weak).not.toContain("같이 읽는다");
  });

  // F1 — weak 이 "배수 순위 — 인과. 순증 순위." 두 문장으로 되돌아가는 회귀를
  // 잡는다. 순증 절은 sub 로 내려갔으므로 weak 은 항상 한 문장이어야 한다.
  test("weak — 한 문장으로 끝난다 (순증 절이 다시 붙는 회귀 가드)", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 9000, value_at_day: 11_200, growth_multiple: 1.2 }),
            row({ group_key: "owis", base_value: 200, value_at_day: 3_200, growth_multiple: 16 }),
          ],
          miiwan_rank: 2, cohort_size: 2,
        },
      },
    });
    const v = scorecardVerdict(d, "yt_subscribers");
    expect(sentenceCount(v.weak!)).toBe(1);
    expect(v.sub).not.toBeNull();
  });

  test("sub — 순증을 낼 값이 없으면 null, weak 은 종전 안내로 물러난다", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 9000, value_at_day: null, growth_multiple: 1.2 }),
            row({ group_key: "owis", base_value: 200, value_at_day: 3_200, growth_multiple: 16 }),
          ],
          miiwan_rank: 2, cohort_size: 2,
        },
      },
    });
    const v = scorecardVerdict(d, "yt_subscribers");
    expect(v.sub).toBeNull();
    expect(v.weak).not.toContain("순증(");
    expect(v.weak).toContain("늘어난 사람 수와 같이 읽는다");
  });

  // 리뷰 지적 — 다른 3개 verdict 함수는 같은 shape 픽스처에서 숫자만 바꿔
  // 문장이 따라가는지 고정하는 전용 테스트가 있는데 scorecardVerdict만
  // 없었다. 같은 shape로 pre_multiple(good)·growth_multiple(weak) 각각을
  // 바꿔 출력 숫자가 하드코딩이 아니라 픽스처에서 파생됨을 고정한다.
  test("숫자는 픽스처에서 파생 — 같은 shape에서 값만 바꾸면 good·weak 숫자도 바뀐다", () => {
    const build = (pre: number, growth: number) => cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 900, pre_multiple: pre, growth_multiple: growth }),
            row({ group_key: "owis", base_value: 400, pre_multiple: 1.5, growth_multiple: 3.0 }),
          ],
          miiwan_rank: 2, cohort_size: 2,
        },
      },
    });
    const v1 = scorecardVerdict(build(2.0, 1.1), "yt_subscribers");
    const v2 = scorecardVerdict(build(4.0, 2.2), "yt_subscribers");
    expect(v1.good).toContain(fmtMultiple(2.0));
    expect(v2.good).toContain(fmtMultiple(4.0));
    expect(v1.weak).toContain(fmtMultiple(1.1));
    expect(v2.weak).toContain(fmtMultiple(2.2));
  });

  test("null-안전 — 순위 모수(miiwan_rank·cohort_size)가 없으면 weak는 null", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: { rows: [row({ group_key: "miiwan" })], miiwan_rank: null, cohort_size: 1 },
      },
    });
    expect(scorecardVerdict(d, "yt_subscribers").weak).toBeNull();
  });

  // G2(R3b 리뷰) — sub 는 weak 을 보강하는 줄이라 홀로 나가면 안 된다.
  // 순증은 낼 수 있는데(값이 있는 팀 2팀 이상) 순위 모수가 없어 weak 이 null 인
  // 창에서, 보강할 대상 없이 "순증은 N팀 중 M위다"만 뜨면 고아 문장이 된다.
  test("sub — weak 이 null 이면 순증 순위도 내지 않는다 (고아 보조 줄 금지)", () => {
    const d = cohort({
      scorecard: {
        yt_subscribers: {
          rows: [
            row({ group_key: "miiwan", base_value: 9000, value_at_day: 11_200 }),
            row({ group_key: "owis", base_value: 200, value_at_day: 3_200 }),
          ],
          // 순위 모수가 없다 → weak null. 순증 자체는 두 팀 다 낼 수 있다.
          miiwan_rank: null, cohort_size: 2,
        },
      },
    });
    const v = scorecardVerdict(d, "yt_subscribers");
    expect(v.weak).toBeNull();
    expect(v.sub).toBeNull();
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
    expect(v.good).toContain("영상 편수 기준 75점");
    // 순위는 어느 기준으로 센 순위인지 문장에 박아 쓴다 — 판정(min) 기준으로
    // 정렬된 아래 목록과 다른 줄 세우기라는 걸 독자가 알 수 있어야 한다.
    expect(v.good).toContain("편수 기준으로는 3팀 중 1위");
    expect(v.good).not.toContain("판정 가능한");
    expect(v.good).toContain("자연 유입 우세 등급이다");
  });

  // C1 — 이 섹션의 자기모순 봉합. 편수 점수는 우세 등급인데 판정 점수(막대·
  // 배지가 그리는 값)는 그 아래인 실측 형태에서, 등급 선언이 나가면 바로
  // 아래 주황 막대와 정면 충돌한다. 등급 기준은 반드시 판정 점수다.
  test("good — 편수 점수가 우세 등급이어도 판정 점수가 그 아래면 등급 선언을 하지 않는다", () => {
    const d = cohort({
      organicity: [
        org("miiwan", 74, false, 41), org("owis", 80, false, 78), org("bthd", 60, false, 55),
      ],
    });
    const v = organicityVerdict(d);
    expect(v.good).toContain("영상 편수 기준 74점");
    expect(v.good).toContain("편수 기준으로는 3팀 중 2위");
    expect(v.good).not.toContain("우세 등급");
    expect(v.good).not.toContain("판정 가능한");
  });

  test("good — 등급 선언은 판정 점수가 우세 등급일 때만, 그 점수를 함께 쓴다", () => {
    const d = cohort({ organicity: [org("miiwan", 90, false, 72), org("owis", 60)] });
    const v = organicityVerdict(d);
    expect(v.good).toContain("72점 기준으로도 자연 유입 우세 등급이다");
  });

  // N8(R3 투자 리뷰) — "대부분 ~"의 게이트는 편수 점수 **평균**이 아니라 실제
  // 편수 **비율**이다. 평균은 과반을 보장하지 못한다: 절반 넘는 영상이 광고
  // 판정을 받아도 나머지가 고득점이면 평균은 borderline 을 넘길 수 있고,
  // 그러면 "대부분은 광고 없이 올라갔다"가 편수 사실과 정면으로 어긋난다.
  test("good — 편수 점수가 높아도 광고 판정 편수가 과반이면 '대부분 ~'을 붙이지 않는다", () => {
    const v = organicityVerdict(cohort({
      // 편수 점수 75(≥ borderline)지만 100편 중 60편이 광고 판정 → 자연 40%.
      organicity: [org("miiwan", 75, false, null, { window: 100, paid: 60 }), org("owis", 60)],
    }));
    expect(v.good).toContain("영상 편수 기준 75점");
    expect(v.good).not.toContain("대부분");
  });

  test("good — 편수 집계가 없으면 '대부분 ~' 절을 생략한다 (비율을 지어내지 않는다)", () => {
    const v = organicityVerdict(cohort({ organicity: [org("miiwan", 75), org("owis", 60)] }));
    expect(v.good).toContain("영상 편수 기준 75점");
    expect(v.good).not.toContain("대부분");
  });

  // G3(R3b 리뷰) — 게이트는 비율과 평균의 AND 다. 비율만 보면 "광고 판정은
  // 10%뿐인데 나머지 영상 점수가 바닥"인 창에서도 절이 나가, 낮은 점수에
  // '대부분' 결론이 붙는 원래 실패가 되돌아온다(원 가드의 의도 복원).
  test("good — 자연 편수가 과반이어도 편수 점수가 경계 미만이면 '대부분 ~'을 붙이지 않는다", () => {
    const v = organicityVerdict(cohort({
      // 100편 중 광고 10편(자연 90%)이지만 편수 점수 30 < borderline.
      organicity: [org("miiwan", 30, false, null, { window: 100, paid: 10 }), org("owis", 60)],
    }));
    expect(v.good).toContain("영상 편수 기준 30점");
    expect(v.good).not.toContain("대부분");
    expect(30).toBeLessThan(VERDICT_THRESHOLDS.borderline);
  });

  // A1 — 이 절의 근거는 **편수**다. 예전 문구("대부분은 자연 소비되고 있다")는
  // 조회수 개념('소비')을 써서, 같은 섹션의 "조회수 71%가 광고 투입 영상에
  // 쏠렸다"와 정면 충돌했다. 카탈로그(무엇이 올라갔나) 표현이어야 한다.
  test("good — '대부분' 절은 소비(조회수)가 아니라 카탈로그(편수) 표현을 쓴다", () => {
    const v = organicityVerdict(cohort({
      organicity: [org("miiwan", 75, false, null, { window: 100, paid: 10 }), org("owis", 60)],
    }));
    expect(v.good).toContain("만든 영상의 대부분은 광고 없이 올라간 것으로 판정됐다");
    expect(v.good).not.toContain("자연 소비");
  });

  test("good — 자연 편수가 정확히 절반이면 '대부분'이라 말하지 않는다 (경계)", () => {
    const v = organicityVerdict(cohort({
      organicity: [org("miiwan", 75, false, null, { window: 100, paid: 50 }), org("owis", 60)],
    }));
    expect(v.good).not.toContain("대부분");
  });

  test("good — 점수가 있는 팀이 미완이뿐이면 순위 절을 붙이지 않는다", () => {
    const v = organicityVerdict(cohort({ organicity: [org("miiwan", 75), org("owis", null)] }));
    expect(v.good).toContain("영상 편수 기준 75점.");
    expect(v.good).not.toContain("팀 중");
  });

  test("good — organic 미만이면 우세 등급 문구를 붙이지 않는다", () => {
    const d = cohort({
      // 점수는 우세 등급에 못 미치지만 편수로는 대부분이 광고 없이 올라간 형태 —
      // 두 절의 게이트가 서로 다른 근거를 쓴다는 것 자체가 이 테스트의 대상이다.
      organicity: [org("miiwan", 55, false, null, { window: 100, paid: 10 }), org("owis", 60)],
    });
    const v = organicityVerdict(d);
    expect(v.good).not.toContain("우세 등급");
    expect(v.good).toContain("만든 영상의 대부분은 광고 없이 올라간 것으로 판정됐다");
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
  });

  // A2(R1 3방향 리뷰) 역할 분리 가드 — weak 은 **판정과 그 위치만** 말한다.
  // 쏠림 수치(몇 편이 조회수 몇 %)는 exPaidNote 가 전담하므로, 두 문단이
  // 같은 사실을 반복하면 섹션이 다시 구구절절해진다.
  test("weak — 판정 순위를 병기한다 (점수만으론 그 자리가 흔한지 알 수 없다)", () => {
    // judge: miiwan 41.4 · owis 80 · bthd 50 → 3팀 중 3위.
    const d = cohort({
      organicity: [org("miiwan", 74, false, 41.4), org("owis", 80), org("bthd", 50)],
    });
    expect(organicityVerdict(d).weak).toContain("41.4점은 3팀 중 3위,");
  });

  test("weak — 순위는 판정 점수(min) 기준 — 편수 순위로 세지 않는다", () => {
    // 편수로는 miiwan 90 이 1위지만 판정 점수는 30 이라 판정 순위는 2위다.
    const d = cohort({ organicity: [org("miiwan", 90, false, 30), org("owis", 80)] });
    expect(organicityVerdict(d).weak).toContain("30점은 2팀 중 2위,");
  });

  test("weak — 겨룰 상대가 없으면 순위 절을 붙이지 않는다", () => {
    const d = cohort({ organicity: [org("miiwan", 35), org("owis", null)] });
    const v = organicityVerdict(d);
    expect(v.weak).toContain("광고 영향을 배제하기 어렵다");
    expect(v.weak).not.toContain("팀 중");
  });

  test("weak — 쏠림 수치·허수아비 부정을 담지 않는다 (exPaidNote 가 전담)", () => {
    const d = cohort({
      organicity: [
        { group_key: "miiwan", score: 74, video_count: 122, reference: false,
          score_view_weighted: 41.4, window_video_count: 122, paid_video_count: 14,
          paid_view_share: 0.712, score_view_weighted_ex_paid: 69.5 },
        org("owis", 90),
      ],
    });
    const v = organicityVerdict(d);
    expect(v.weak).toContain("광고 영향을 배제하기 어렵다");
    expect(v.weak).not.toContain("쏠린");
    expect(v.weak).not.toContain("14편");
    expect(v.weak).not.toContain("71%");
    // 아무도 하지 않은 주장을 반박하면 그 주장이 오히려 화면에 남는다.
    expect(v.weak).not.toContain("광고성이라는 뜻은 아니다");
  });

  test("weak — 한 문장으로 끝난다 (문장 다이어트 가드)", () => {
    const d = cohort({ organicity: [org("miiwan", 55, false, 35), org("owis", 90)] });
    // 마침표는 문장 끝 하나뿐 — 절을 이어 붙여 두세 문장이 되면 걸린다.
    expect(sentenceCount(organicityVerdict(d).weak!)).toBe(1);
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

  // Task 2에서 cohortQuality.ts → cohortHeadline.ts로 옮긴 단일 정의 —
  // 두 파일이 각자 값을 들고 있던 게 아니라 이제 같은 바인딩이라 cross-file
  // desync 가드는 아니고, 이관 과정에서 값(10)이 조용히 바뀌지 않았음을
  // 고정하는 리그레션 핀이다.
  test("THRESHOLD_NEAR_BAND 이관 값 고정 — 10 그대로다", () => {
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

  // A5 — 액션 안내는 WEAK_REMEDY 와 같은 성격의 **정적 문구**(수치·결론이
  // 아니라 다음 안건)라 상수로 둔다. 화면에 손으로 적으면 문구가 조용히 갈린다.
  test("자연 유입 섹션 액션 안내 — 결정 지향 한 줄, 수치를 담지 않는다", () => {
    expect(ORG_ACTION_HINT).toContain("다음 액션");
    expect(ORG_ACTION_HINT).not.toMatch(/\d/);
  });

  // N6(R3 리뷰) — 축약 라벨(舊 EX_PAID_LABEL_SHORT "광고 투입 제외")을 없앴다.
  // 같은 값을 두 이름으로 부르면 좁은 컬럼의 숫자와 각주·툴팁의 숫자가 서로
  // 다른 지표처럼 읽힌다 — 화면 네 곳이 이 상수 하나만 쓴다.
  test("제외 점수 라벨 — 무엇을 제외했는지가 라벨에 있고, 이름은 하나뿐이다", () => {
    expect(EX_PAID_LABEL).toBe("광고 투입 콘텐츠 제외");
    expect(EX_PAID_LABEL).toContain("광고 투입");
  });
});

describe("exPaidNote", () => {
  const base = { group_key: "miiwan", score: 74, video_count: 122, reference: false,
    score_view_weighted: 41.4, window_video_count: 122, paid_video_count: 14,
    paid_view_share: 0.712, score_view_weighted_ex_paid: 69.5 };
  // 07-30 — headline(승격 표시용 결론) / note(보조 각주)로 나뉜다. 예전엔 한
  // 문장이라 화면에서 승격할 지점이 없어 "제외 시 N점"이 소자 각주에 묻혔다.
  test("headline = 라벨 + 제외 점수, 무엇을 제외했는지가 라벨에 있다", () => {
    const r = exPaidNote(base as OrgRow)!;
    expect(r.headline).toBe(`${EX_PAID_LABEL} 69.5점`);
    expect(EX_PAID_LABEL).toContain("광고");
  });
  // A3(R1 3방향 리뷰) ⓐ — 쏠림은 **편수 비중과 조회수 점유를 맞세워야** 보인다.
  // 둘을 떼어 놓으면 "광고 영상은 11%뿐"과 "조회수의 71%"가 각각 다른 결론으로
  // 읽힌다. organicityVerdict.weak 에서 내려온 역할이다(weak = 판정과 위치만).
  test("note ⓐ — 편수 비중과 조회수 점유를 한 문장에서 맞세운다", () => {
    const r = exPaidNote(base as OrgRow)!;
    // R4-C1 — '전체'는 데뷔 창 활동 표의 "업로드 전수"가 가져갔다. 한 화면에서
    // 두 모집단이 같은 이름을 쓰지 않도록 이쪽은 '판정 대상'으로 부른다.
    expect(r.note).toContain("판정 대상 122편");
    expect(r.note).not.toContain("전체 122편");
    expect(r.note).toContain("14편");
    expect(r.note).toContain("편수의 11%");   // 14 / 122
    expect(r.note).toContain("조회수의 71%"); // 0.712
  });
  // 숫자는 하드코딩이 아니라 필드 파생 — 같은 shape 에서 값만 바꾸면 따라간다.
  test("note ⓐ — 비중·점유는 픽스처에서 파생된다", () => {
    const r = exPaidNote({
      ...base, window_video_count: 40, paid_video_count: 10, paid_view_share: 0.5,
    } as OrgRow)!;
    expect(r.note).toContain("판정 대상 40편");
    expect(r.note).toContain("편수의 25%");
    expect(r.note).toContain("조회수의 50%");
  });
  // A3 ⓑ — 제외 기준이 판정선과 같은 선이라 "제외 후 점수가 기준선 위"는
  // 발견이 아니라 정의다. 예전엔 접은 각주에만 있어, 접어둔 채 보면 보장된
  // 산술이 성과처럼 읽혔다. 상시 공시로 승격했고 임계는 상수 보간이다.
  test("note ⓑ — 보장 산술을 상시로 공시한다 (임계는 상수 보간)", () => {
    const r = exPaidNote(base as OrgRow)!;
    expect(r.note).toContain(`판정선(${ORG_AD_SUSPECT_THRESHOLD}점 미만)`);
    expect(r.note).toContain(`${ORG_AD_SUSPECT_THRESHOLD}점 위인 것 자체는 당연하다`);
    expect(r.note).toContain("볼 것은 쏠림의 규모다");
  });
  test("유료 판정이 0편이거나 필드가 없으면 null", () => {
    expect(exPaidNote({ ...base, paid_video_count: 0 } as OrgRow)).toBeNull();
    expect(exPaidNote({ ...base, score_view_weighted_ex_paid: null } as OrgRow)).toBeNull();
    expect(exPaidNote(undefined)).toBeNull();
  });
  // A3 ⓒ — 제외 점수(69.5)가 판정 점수(41.4)보다 한참 높게 나오는 게 정상이라
  // (ⓑ의 귀결) 앵커가 없으면 투자사 독자가 제외 점수를 결론 점수로 가져간다.
  // 예전 문구는 "‘광고 의심’ 표시는 그대로"였는데 MiiWAN 행에는 그 표시가
  // 없다 — 화면에 없는 것을 지칭하지 않고 판정 점수 자체를 앵커로 쓴다.
  // R3(타이포 리뷰) — 앵커는 note(쏠림 구조)와 성격이 달라 필드를 나눴다.
  // 한 문단에 이어 붙어 있으면 쏠림 설명의 꼬리처럼 읽혀 그냥 지나쳤다.
  test("anchor ⓒ — 판정 점수를 앵커로 쓰고, 화면에 없는 표시를 지칭하지 않는다", () => {
    const r = exPaidNote(base as OrgRow)!;
    expect(r.anchor).toBe("판정 점수 41.4점은 이 수치와 무관하게 그대로다.");
    expect(r.anchor).not.toContain("광고 의심");
    // 줄이 나뉘었으므로 note 는 쏠림 구조(ⓐⓑ)만 담는다.
    expect(r.note).not.toContain("무관하게 그대로다");
  });
  test("판정 점수가 없으면 숫자 없이 앵커만 (없는 값을 지어내지 않는다)", () => {
    const r = exPaidNote({ ...base, score: null } as OrgRow)!;
    expect(r.anchor).toContain("위 판정 점수는");
    expect(r.anchor).not.toMatch(/판정 점수 [\d.]+점/);
  });
  // 데이터에서 파생되지 않는 결론("나머지는 자연 소비")은 문장에 없다 —
  // 제외 뒤 남은 조회수에도 의심 대역이 섞여 있어 단정할 수 없다.
  test("고정 해석 문구를 덧붙이지 않는다", () => {
    const r = exPaidNote(base as OrgRow)!;
    for (const s of [r.note, r.anchor]) {
      expect(s).not.toContain("자연 소비");
      expect(s).not.toContain("자연 유입에 가깝");
    }
  });
});

// ── 데뷔 창 활동 (업로드 전수 · 창 내 조회수 · 반응 밀도) ────────────────
/** 활동 필드가 실린 유기성 행. 2026-07-30 실측 shape 를 그대로 쓴다. */
const actRow = (
  group_key: string, uploads: number, views: number | null,
  eng1k: number | null, reference = false,
  parts?: { long: number; short: number },
): OrgRow => ({
  group_key, score: 60, video_count: 10, reference,
  uploads, window_views: views, engagement_per_1k_views: eng1k,
  uploads_long: parts?.long ?? null, uploads_short: parts?.short ?? null,
});

/**
 * 2026-07-30 실측(D-20~D+40 창). 업로드는 미완이 2위인데 창 내 조회수는
 * 꼴찌 — "많이 올렸는데 도달은 적고, 대신 반응 밀도는 1위"라는 이 화면의
 * 핵심 대비가 픽스처에 그대로 들어 있어야 문장 규칙을 검증할 수 있다.
 */
const ACT_LIVE = [
  actRow("miiwan", 107, 2_028_899, 14.3, false, { long: 35, short: 72 }),
  actRow("owis", 151, 12_508_448, 6.7),
  actRow("bthd", 26, 6_460_810, 1.0),
  actRow("bdawn", 74, 5_320_331, 3.6),
  actRow("skinz", 27, 4_243_678, 7.9),
  actRow("myrakl", 76, 2_415_028, 4.5),
  actRow("plave", 53, 39_454_951, 29.6, true),
];

describe("activityVerdict", () => {
  test("상위 절반은 잘하는 점 — 업로드·반응 밀도 순위를 한 문장으로", () => {
    const v = activityVerdict(cohort({ organicity: ACT_LIVE }));
    expect(v.good).toContain("업로드 107편");
    expect(v.good).toContain("6팀 중 2위");
    expect(v.good).toContain("조회 1,000회당 반응 14.3건");
    // 참조선(PLAVE 29.6)이 모수에 섞이면 미완이 밀도가 2위로 밀린다.
    expect(v.good).toContain("6팀 중 1위");
    expect(sentenceCount(v.good!)).toBe(1);
  });

  // 이 섹션의 존재 이유 = 투입 대비 산출. 업로드가 상위인데 조회수가
  // 하위면 그 대비 자체가 보완할 점이라, 두 순위를 한 문장에서 맞세운다.
  test("업로드는 상위인데 창 내 조회수가 하위면 그 대비를 보완할 점으로", () => {
    const v = activityVerdict(cohort({ organicity: ACT_LIVE }));
    expect(v.weak).toContain("창 내 조회수는 6팀 중 6위");
    expect(v.weak).toContain("업로드 순위(2위)");
    expect(sentenceCount(v.weak!)).toBe(1);
  });

  test("하위권 지표는 보완할 점으로 간다 (업로드·밀도 모두)", () => {
    const v = activityVerdict(cohort({
      organicity: [
        actRow("miiwan", 5, 9_000_000, 1.0),
        actRow("owis", 151, 12_508_448, 6.7),
        actRow("bthd", 26, 6_460_810, 4.0),
        actRow("bdawn", 74, 5_320_331, 3.6),
      ],
    }));
    expect(v.weak).toContain("업로드 5편은 4팀 중 4위");
    expect(v.weak).toContain("조회 1,000회당 반응 1.0건은 4팀 중 4위");
    // 조회수는 상위 절반이라 잘하는 점으로 갈린다.
    expect(v.good).toContain("창 내 조회수는 4팀 중 2위");
    expect(sentenceCount(v.weak!)).toBe(1);
  });

  // R4-I2 회귀 — 대비 절만 서술어로 끝나(…따라오지 않는 + 다.) 절 목록의
  // 마지막에 설 때만 문장이 성립한다. 반응 밀도까지 하위권이면 예전 순서에서
  // "…따라오지 않는, 조회 1,000회당 반응 …위다."라는 비문이 나갔다.
  test("대비 절은 항상 문장 끝 — 조회수·밀도가 함께 하위권이어도 비문이 없다", () => {
    const v = activityVerdict(cohort({
      organicity: [
        actRow("miiwan", 107, 1_000_000, 1.0),
        actRow("owis", 60, 12_000_000, 6.7),
        actRow("bdawn", 50, 5_000_000, 3.6),
        actRow("bthd", 20, 2_000_000, 2.0),
      ],
    }));
    expect(v.weak).toContain("조회 1,000회당 반응 1.0건은 4팀 중 4위");
    expect(v.weak!.endsWith("도달이 따라오지 않는다.")).toBe(true);
    expect(v.weak).not.toContain("않는,");
    expect(sentenceCount(v.weak!)).toBe(1);
  });

  test("데이터가 없으면 문장을 지어내지 않는다", () => {
    expect(activityVerdict(cohort({ organicity: [] })))
      .toEqual({ good: null, weak: null });
    // 활동 필드가 없는 응답(구버전 API)도 같은 처리.
    expect(activityVerdict(cohort({
      organicity: [org("miiwan", 74), org("owis", 60)],
    }))).toEqual({ good: null, weak: null });
  });

  test("비교 대상이 1팀뿐이면 순위를 내지 않는다 (‘1팀 중 1위’ 금지)", () => {
    const v = activityVerdict(cohort({
      organicity: [
        actRow("miiwan", 107, 2_028_899, 14.3),
        actRow("plave", 53, 39_454_951, 29.6, true),
      ],
    }));
    expect(v).toEqual({ good: null, weak: null });
  });

  test("값이 없는 팀은 그 지표의 모수에서만 빠진다", () => {
    const v = activityVerdict(cohort({
      organicity: [
        actRow("miiwan", 107, 2_028_899, 14.3),
        actRow("owis", 151, 12_508_448, null),
        actRow("bdawn", 74, 5_320_331, 3.6),
      ],
    }));
    // 업로드·조회수는 3팀 모수, 반응 밀도는 값이 있는 2팀 모수.
    expect(v.good).toContain("업로드 107편은 3팀 중 2위");
    expect(v.good).toContain("2팀 중 1위");
  });
});

// ── "다음 보고까지" 카드 ────────────────────────────────────────────────
describe("nextReportCard", () => {
  /** 2026-07-30 실측 근사 — 총 성장 1위 · 데뷔 전 1위 · 데뷔 후 하위권. */
  const live = () => cohort({
    scorecard: {
      yt_subscribers: {
        rows: [
          row({ group_key: "miiwan", growth_multiple: 1.08, pre_multiple: 13.8,
            total_multiple: 15.0, base_value: 26_000, value_at_day: 28_200 }),
          row({ group_key: "myrakl", growth_multiple: 2.4, pre_multiple: 2.0,
            total_multiple: 4.8, base_value: 3_000, value_at_day: 7_200 }),
          row({ group_key: "owis", growth_multiple: 1.9, pre_multiple: 3.1,
            total_multiple: 5.9, base_value: 9_000, value_at_day: 17_100 }),
          row({ group_key: "plave", reference: true, growth_multiple: 9.9,
            pre_multiple: 20, total_multiple: 40 }),
        ],
        miiwan_rank: 3, cohort_size: 3,
      },
    },
    organicity: [
      { group_key: "miiwan", score: 74, video_count: 122, reference: false,
        score_view_weighted: 41.4, window_video_count: 122, paid_video_count: 14,
        paid_view_share: 0.712, score_view_weighted_ex_paid: 69.5 },
      org("myrakl", 60, false, 29.8),
      org("owis", 55, false, 50),
    ],
  });
  const verdicts = (d: CohortData) => ({
    curve: curveVerdict(d), organicity: organicityVerdict(d),
  });
  const card = () => {
    const d = live();
    return nextReportCard(d, verdicts(d));
  };

  test("강점은 각 섹션이 이미 쓰는 게이트에서 파생된다 (최대 3)", () => {
    const c = card();
    expect(c.strengths.length).toBeLessThanOrEqual(3);
    expect(c.strengths[0]).toContain("총 성장 15.0×");
    expect(c.strengths[0]).toContain("3팀 중 1위");   // 참조선(PLAVE 40×) 제외
    // R4-C2 — 캡처가 가장 많이 되는 자리라 유리한 배수만 캐비앗 없이 나가면
    // 비대칭 공시가 된다. 화면의 다른 배수들과 같은 캐비앗을 같은 줄에 단다.
    expect(c.strengths[0]).toContain("출발점이 작을수록 크게 나오는 값");
    expect(c.strengths[1]).toContain("데뷔 전 성장 13.8×");
    expect(c.strengths[2]).toContain("+2,200명");     // 데뷔 후 순증 지속
    for (const s of c.strengths) expect(sentenceCount(s)).toBe(1);
  });

  test("보완할 것도 데이터 파생 — 배수 하위권·판정 점수·조회수 쏠림", () => {
    const c = card();
    expect(c.focus.length).toBeLessThanOrEqual(3);
    expect(c.focus[0]).toContain("데뷔 후 성장 배수 1.1×");
    expect(c.focus[0]).toContain("3팀 중 3위");
    // 출발선이 상위권이면 그 사실을 같은 줄에 단다 — 헤드라인 결론·상세표
    // 보완이 쓰는 것과 같은 게이트다(요약이 본문보다 가혹하면 안 된다).
    expect(c.focus[0]).toContain("출발선 1위 규모");
    // R4-I1 — 앵커는 ⑤ 섹션과 같은 분기를 쓴다. 41.4점은 기준선(40) 부근이라
    // "자연 유입 우세 미달"이 아니라 "기준선 부근"으로 말해야 한다(요약이
    // 본문보다 관대해지지 않게). 순위도 ⑤ weak 과 같은 규칙으로 병기.
    expect(c.focus[1]).toContain("판정 점수 41.4점");
    expect(c.focus[1]).toContain(`광고 과다 기준선(${ORG_AD_SUSPECT_THRESHOLD}점) 부근`);
    expect(c.focus[1]).toContain("3팀 중 2위");
    expect(c.focus[1]).not.toContain(`${VERDICT_THRESHOLDS.organic}점`);
    expect(c.focus[2]).toContain("14편");
    expect(c.focus[2]).toContain("71%");
    for (const s of c.focus) expect(sentenceCount(s)).toBe(1);
  });

  test("조건이 안 맞으면 불릿을 지어내지 않는다 (빈 배열 허용)", () => {
    const d = cohort();
    const c = nextReportCard(d, verdicts(d));
    expect(c.strengths).toEqual([]);
    expect(c.focus).toEqual([]);
    // 액션은 운영 약속이라 데이터와 무관하게 남는다.
    expect(c.actions.length).toBe(NEXT_REPORT_ACTIONS.length);
  });

  test("판정 점수가 우세 등급이면 그 보완 항목이 빠진다 (같은 게이트 재사용)", () => {
    const d = live();
    d.organicity = [
      { ...d.organicity[0]!, score: 85, score_view_weighted: 80 },
      org("myrakl", 60, false, 55),
      org("owis", 55, false, 50),
    ];
    const c = nextReportCard(d, verdicts(d));
    expect(organicityVerdict(d).weak).toBeNull();
    expect(c.focus.some((s) => s.includes("판정 점수"))).toBe(false);
  });

  // R4-I1 — 점수가 기준선 아래로 떨어지거나 기준선에서 충분히 떨어진 창에서
  // 카드 문구가 따라 움직여야 한다. 예전엔 위치와 무관하게 "우세(70점) 미달"
  // 한 문구라, 더 나빠져도 요약은 같은 말을 계속했다.
  test("판정 점수 앵커가 위치를 따라간다 (⑤ 섹션과 같은 컷)", () => {
    const at = (judge: number) => {
      const d = live();
      d.organicity = [
        { ...d.organicity[0]!, score: judge, score_view_weighted: judge },
        org("myrakl", 60, false, 55), org("owis", 55, false, 50),
      ];
      return nextReportCard(d, verdicts(d)).focus
        .find((s) => s.includes("판정 점수"))!;
    };
    expect(at(31)).toContain(`광고 과다 기준선(${ORG_AD_SUSPECT_THRESHOLD}점) 아래`);
    expect(at(45)).toContain(`광고 과다 기준선(${ORG_AD_SUSPECT_THRESHOLD}점) 부근`);
    expect(at(65)).toContain(`자연 유입 우세(${VERDICT_THRESHOLDS.organic}점) 미달`);
  });

  test("액션은 편집 가능한 운영 상수 — 액션→가져올 것 쌍, 수치를 담지 않는다", () => {
    const c = card();
    expect(c.actions).toEqual(NEXT_REPORT_ACTIONS);
    expect(NEXT_REPORT_ACTIONS.length).toBe(3);
    for (const a of NEXT_REPORT_ACTIONS) {
      expect(a.action.length).toBeGreaterThan(0);
      expect(a.deliverable.length).toBeGreaterThan(0);
      // 수치·시점을 상수에 박으면 데이터가 바뀌어도 문구만 옛날 값으로 남는다
      // (시점 표기는 화면이 as_of_day 에서 파생한다).
      expect(a.action).not.toMatch(/\d/);
      expect(a.deliverable).not.toMatch(/\d/);
    }
  });

  // R4-I4 — 산출물이 "아무도 아무것도 안 해도 대시보드가 갖고 있는 값"이면
  // 약속이 지켜졌는지 반증할 수 없다(= 약속이 아니다). 액션을 했을 때만
  // 존재하는 결과물을 가리켜야 한다.
  test("산출물은 액션을 했을 때만 존재하는 것 — 자동 재계산은 산출물이 아니다", () => {
    for (const a of NEXT_REPORT_ACTIONS) {
      expect(a.deliverable).not.toMatch(/재측정|추이 비교/);
    }
    expect(NEXT_REPORT_ACTIONS[1]!.deliverable).toContain("실행한 레버 목록");
    expect(NEXT_REPORT_ACTIONS[2]!.deliverable).toContain("결정");
  });
});

describe("activityRows", () => {
  test("창 내 조회수 내림차순 · 참조선은 맨 아래", () => {
    const keys = activityRows(cohort({ organicity: ACT_LIVE }))
      .map((o) => o.group_key);
    expect(keys).toEqual([
      "owis", "bthd", "bdawn", "skinz", "myrakl", "miiwan", "plave",
    ]);
  });

  test("활동 데이터가 없는 그룹은 빈 줄로 세우지 않는다", () => {
    const rows = activityRows(cohort({
      organicity: [
        actRow("miiwan", 107, 2_028_899, 14.3),
        org("owis", 60),              // 활동 필드 자체가 없음
        actRow("bthd", 0, null, null), // 업로드 0 · 조회수 없음
      ],
    }));
    expect(rows.map((o) => o.group_key)).toEqual(["miiwan"]);
  });
});
