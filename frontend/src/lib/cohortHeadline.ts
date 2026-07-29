// 동시기 성과(MiiWANCohortReport) 헤드라인의 순수 계산부.
//
// "데뷔 D+N일 차 성적표 — 잘하고 있는 것 / 보완할 것" 문구는 투자사에게
// 그대로 읽히는 결론이라 규칙이 테스트로 고정돼야 한다. 컴포넌트 안에
// 두면 렌더링 없이는 검증할 수 없어 functions/lib/cohortReport.ts 가
// 엔드포인트에서 순수부를 떼어낸 것과 같은 이유로 분리했다.
// 테스트: tests/lib/cohortHeadline.test.ts
import { VERDICT_THRESHOLDS } from "./organicity";

export type CurvePoint = { day: number; index: number; source: string };
export type ScRow = {
  group_key: string; value_at_day: number | null;
  growth_multiple: number | null; source: string | null; reference: boolean;
  /** 실제로 값을 집어온 경과일 — 탐색 허용폭 때문에 D+N과 다를 수 있다. */
  base_day: number | null; at_day: number | null; base_source: string | null;
  /** 성장배수의 분모(출발선). 배수만으론 저베이스 왜곡을 설명할 수 없어 함께 낸다. */
  base_value: number | null;
};
export type OrgRow = {
  group_key: string; score: number | null; video_count: number; reference: boolean;
};
/** score가 실제로 있는 행만 남긴 뒤 쓰는 좁힌 타입 (막대 폭 계산에 non-null 필요). */
export type OrgRowScored = Omit<OrgRow, "score"> & { score: number };
export type CohortData = {
  as_of_day: number;
  /** 백엔드의 측정 허용폭 상수 (D-Day±base / D+N±at). 각주가 이 값에서 파생된다. */
  windows?: { base: number; at: number };
  metrics: string[];
  groups: Record<string, { name: string; debut_date: string | null; reference: boolean }>;
  curves: Record<string, Record<string, CurvePoint[]>>;
  scorecard: Record<string, { rows: ScRow[]; miiwan_rank: number | null; cohort_size: number }>;
  organicity: OrgRow[];
  /** 유기성 집계에 실제로 쓰인 데뷔 창 라벨 (예: "D-Day~D+40"). */
  organicity_window?: string;
  /** 유기성 쿼리 실패 시 true (+ organicity: []). 숨기지 말고 힌트 카드로 노출. */
  organicity_unavailable?: boolean;
  excluded: Array<{ group_key: string; metric: string; reason: string }>;
};

// 커뮤니티 활동(dc_total_posts)은 동시기 성과에서 제외 — API 의 METRICS 와
// 짝을 맞춘다. 다른 화면의 커뮤니티 지표는 그대로 쓴다.
export const METRIC_LABELS: Record<string, string> = {
  yt_subscribers: "구독자",
  yt_total_views: "누적 조회수",
  naver_total_news: "뉴스 노출",
};

/**
 * 자연 유입 점수가 이 값 미만이면 그 그룹의 유튜브 성장에 "광고 영향 의심"
 * 배지를 단다. 숫자를 새로 정하지 않고 organicity.ts 의 `organic` 등급 컷을
 * 그대로 재사용한다 — 이 화면이 말하는 "광고가 아니라 팬이 만든 성장"은
 * 곧 "이 팀의 데뷔 창 점수가 organic 등급 이상"이라는 뜻이고, 그 경계는
 * 워커(debut_window.py:_classify_verdict)와 다른 유기성 화면들이 이미
 * 쓰는 값이기 때문이다. 손으로 70 을 적어두면 등급을 재보정했을 때 이
 * 배지만 조용히 옛 기준으로 남는다 — organicity.ts 헤더가 경고하는
 * hand-copy desync(V2.21 → V2.37) 와 정확히 같은 사고다.
 */
export const ORG_AD_SUSPECT_THRESHOLD = VERDICT_THRESHOLDS.organic;

/**
 * 광고 의심 배지를 다는 지표. 자연 유입 점수는 "영상"이 유료로 밀린
 * 것인지를 판정한 값이라 유튜브 성장에만 걸린다 — 뉴스 노출은 영상
 * 판정과 무관하므로 같은 근거로 감점하지 않는다.
 */
export const AD_SUSPECT_METRICS = new Set(["yt_subscribers", "yt_total_views"]);

/** 열세 지표별 보완 방향 — 순위만 던지지 않고 "그래서 뭘 하나"까지 말한다. */
export const WEAK_REMEDY: Record<string, string> = {
  yt_subscribers: "멤버 개인 콘텐츠·쇼츠 후킹 등 구독으로 넘어가게 만드는 콘텐츠를 늘릴 것",
  yt_total_views: "쇼츠 업로드 주기를 올려 알고리즘 노출을 키울 것",
  naver_total_news: "보도자료·인터뷰 주기를 만들어 언론 노출을 늘릴 것",
};

export function fmtMultiple(m: number | null): string {
  return m == null ? "—" : `${(Math.round(m * 10) / 10).toFixed(1)}×`;
}

/**
 * MiiWAN 의 자연 유입 점수와 그 순위. 순위 모수는 점수가 실제로 있는
 * 비참조 그룹만 — 점수가 없는 팀을 분모에 넣으면 "몇 팀 중 몇 위"가
 * 부풀고, PLAVE(참조선)는 체급이 달라 순위에서 빠진다(표·곡선과 동일 규칙).
 */
export function organicStanding(
  d: CohortData,
): { score: number; rank: number; size: number } | null {
  const scored = d.organicity.filter(
    (o): o is OrgRowScored => o.score != null && !o.reference,
  );
  const mine = scored.find((o) => o.group_key === "miiwan");
  if (!mine) return null;
  return {
    score: mine.score,
    rank: scored.filter((o) => o.score > mine.score).length + 1,
    size: scored.length,
  };
}

export interface Headline {
  lead: string;
  /** 상위 절반 지표 — "무엇이 몇 위인지"까지. */
  strengths: string[];
  /** 강점의 의미 부여 한 줄 (자연 유입 점수 근거). 근거 없으면 null. */
  strengthWhy: string | null;
  /** 하위 절반 지표 — "순위 + 보완 방향". */
  weaknesses: string[];
  /** 강점·약점 둘 다 못 뽑았을 때의 중립 문구. */
  neutral: string | null;
}

/**
 * 헤드라인: 지표별 순위를 우세(상위 절반)/열세로 나눠 "왜 잘하는지 /
 * 뭘 보완할지"를 자동 생성한다. 수치·순위·점수는 전부 응답에서 계산하고
 * 코드에는 문구 틀과 지표별 보완 방향만 둔다 — 하드코딩된 결론 금지.
 */
export function headline(d: CohortData): Headline {
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  // 자연 유입 점수로 변호할 수 있는 강점이 실제로 있었는지 — 점수는 영상이
  // 유료로 밀렸는지를 재는 값이라 유튜브 강점에만 근거가 된다.
  let hasAdRelevantStrength = false;
  for (const m of d.metrics) {
    const sc = d.scorecard[m];
    if (!sc || sc.miiwan_rank == null || sc.cohort_size < 2) continue;
    const label = METRIC_LABELS[m] ?? m;
    const mine = sc.rows.find((r) => r.group_key === "miiwan");
    const head = `${label} ${fmtMultiple(mine?.growth_multiple ?? null)}`
      + ` — 같은 시기 데뷔 ${sc.cohort_size}팀 중 ${sc.miiwan_rank}위`;
    if (sc.miiwan_rank <= Math.ceil(sc.cohort_size / 2)) {
      strengths.push(head);
      if (AD_SUSPECT_METRICS.has(m)) hasAdRelevantStrength = true;
    } else {
      weaknesses.push(WEAK_REMEDY[m] ? `${head}. ${WEAK_REMEDY[m]}` : head);
    }
  }

  // 자연 유입 점수가 임계 이상이면 "이 성장이 광고가 아니라 팬이 만든 것"
  // 이라는 근거가 된다 — 스코어카드의 광고 의심 배지와 같은 기준을 써
  // 화면 안에서 강점 설명과 배지가 서로 어긋나지 않게 한다.
  //
  // 단, 강점이 뉴스 노출뿐일 때는 이 문장을 붙이지 않는다. 점수는 영상
  // 판정에서 나온 값이라 뉴스 순위를 변호하지 못하고, 유튜브가 오히려
  // 약점 목록에 있는데 "이 성장은 광고가 아니다"라고 말하면 바로 아래
  // 보완 목록과 자기모순이 된다.
  const org = organicStanding(d);
  const orgTop = org != null && org.size >= 2
    && org.rank <= Math.ceil(org.size / 2);
  const strengthWhy = hasAdRelevantStrength && org
    && org.score >= ORG_AD_SUSPECT_THRESHOLD
    ? `자연 유입 점수 ${org.score}점 — 이 성장은 광고로 산 것이 아니라 팬이 스스로 찾아와 만든 것이다`
      + (orgTop ? ` (같은 시기 데뷔 ${org.size}팀 중 ${org.rank}위).` : ".")
    : null;

  return {
    lead: `데뷔 D+${d.as_of_day}일 차, 같은 시기에 데뷔한 팀들과 비교한 성적표`,
    strengths,
    strengthWhy,
    weaknesses,
    neutral: strengths.length || weaknesses.length
      ? null
      : "아직 같은 시기 데뷔 팀과 순위를 낼 만큼 데뷔일 시점 데이터가 모이지 않았다.",
  };
}
