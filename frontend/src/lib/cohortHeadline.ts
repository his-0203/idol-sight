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
  /** 데뷔 전 배수 (D-pre_debut → 데뷔일). growth_multiple 은 데뷔 후 배수. */
  pre_multiple: number | null;
  /** 조회수 1,000회당 늘어난 구독자 — 데뷔 전 / 데뷔 후 구간. */
  subs_per_1k_pre: number | null;
  subs_per_1k_post: number | null;
  /** 데뷔 전 앵커 값 (D-30±7 우선, 없으면 데뷔 전 최초 확보 값). */
  pre_value: number | null; pre_day: number | null; pre_source: string | null;
  /** 총 성장배수 (데뷔 전 앵커 → D+N). 앵커 날짜는 total_anchor_day 로 공시. */
  total_multiple: number | null;
  total_anchor_day: number | null; total_anchor_source: string | null;
};
export type OrgRow = {
  group_key: string; score: number | null; video_count: number; reference: boolean;
  /** 같은 창의 조회수 기준(뷰 가중) 점수. 편수 기준 score 와 나란히 읽는다. */
  score_view_weighted?: number | null;
  /** 유기성 창 내 판정 영상 수 / 그중 유료 판정 수 (영상 단위 집계). */
  window_video_count?: number;
  paid_video_count?: number;
  /** 유료 판정 영상의 조회수 점유(0~1). 분모 0이면 null. */
  paid_view_share?: number | null;
  /** 유료 판정 영상 제외 조회수 가중 점수. 남는 조회수가 없으면 null. */
  score_view_weighted_ex_paid?: number | null;
};
/** score가 실제로 있는 행만 남긴 뒤 쓰는 좁힌 타입 (막대 폭 계산에 non-null 필요). */
export type OrgRowScored = Omit<OrgRow, "score"> & { score: number };
export type CohortData = {
  as_of_day: number;
  /**
   * 백엔드 상수 (D-Day±base / D+N±at 측정 허용폭, 곡선이 그리는 데뷔 전
   * 구간 pre_debut). 화면 각주·캡션이 전부 이 값에서 파생된다.
   */
  windows?: { base: number; at: number; pre_debut?: number };
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

// 커뮤니티 활동(dc_total_posts)·뉴스 노출(naver_total_news)은 동시기 성과에서
// 제외 — API 의 METRICS 와 짝을 맞춘다. 사유는 그쪽 주석 참조(뉴스는 live 가
// 누적, 백필이 기간 건수라 단위가 섞여 배수 비교가 성립하지 않는다).
// 다른 화면의 같은 지표는 그대로 쓴다.
export const METRIC_LABELS: Record<string, string> = {
  yt_subscribers: "구독자",
  yt_total_views: "누적 조회수",
};

/** 순증 표기 단위. 배수만 쓰면 "몇 명 늘었나"가 사라진다. */
export const METRIC_UNITS: Record<string, string> = {
  yt_subscribers: "명",
  yt_total_views: "회",
};

/**
 * 헤드라인 한 줄 결론이 쓰는 지표. 헤드라인 카드는 지표 탭보다 위에 있어
 * 탭 선택에 따라 결론이 바뀌면 안 되므로 고정한다 — 구독자가 이 화면의
 * 대표 지표(팬덤 규모)이고 산점도 축(QUALITY_METRIC)과도 같은 기준이다.
 */
export const PRIMARY_METRIC = "yt_subscribers";

/**
 * 자연 유입 점수가 이 값 미만이면 "광고 영향 의심" 배지를 단다.
 * 컷은 organicity.ts 등급 체계의 `suspect` 경계(40) — 그 아래는 likely_paid
 * 티어, 즉 "광고를 과하게 쓴 것으로 보이는" 팀이다.
 *
 * 왜 organic(70)이 아닌가: 판정 점수는 편수·조회수 중 **낮은 쪽**(adJudgeScore)
 * 인데, 조회수 기준은 소수의 고조회 영상에 끌려 구조적으로 낮게 나온다
 * (2026-07-29 실측: 전 그룹 min 29.8~58.9, 참조 PLAVE조차 58.9). organic 컷을
 * 그대로 쓰면 전원이 걸려 배지가 변별력을 잃는다 — 배지는 "광고 과다 사용이
 * 뚜렷한 팀"만 가리켜야 하고, 경계 대역은 산점도·막대의 연속 점수가 보여준다.
 * 숫자를 손으로 적지 않고 organicity.ts 컷을 참조하는 이유는 종전과 같다
 * (재보정 시 hand-copy desync 방지).
 */
export const ORG_AD_SUSPECT_THRESHOLD = VERDICT_THRESHOLDS.suspect;

/**
 * 광고 의심 배지를 다는 지표. 자연 유입 점수는 "영상"이 유료로 밀린
 * 것인지를 판정한 값이라 유튜브 성장에만 걸린다 — 영상 판정과 무관한
 * 지표에는 같은 근거로 감점하지 않는다. 현재 METRICS 가 전부 유튜브라
 * 결과적으로 전 지표가 대상이지만, 스코프 개념 자체는 Set 으로 남긴다
 * (다시 비유튜브 지표가 들어오면 그때 자동으로 갈린다).
 */
export const AD_SUSPECT_METRICS = new Set(["yt_subscribers", "yt_total_views"]);

/**
 * 열세 지표별 보완 방향. 순위만 던지지 않고 "그래서 무엇을 정할 것인가"까지
 * 말한다 — 이 카드는 사내 회의에서도 그대로 읽히므로 실행 담당자가 다음
 * 안건을 잡을 수 있어야 한다. 업계 은어("후킹")는 쓰지 않는다: 투자 심사역이
 * 같은 화면을 보고, 뜻을 모르면 문장이 통째로 건너뛰어진다.
 */
export const WEAK_REMEDY: Record<string, string> = {
  yt_subscribers:
    "구독으로 이어지는 지점(멤버 개별 콘텐츠·영상 도입부)을 콘텐츠 회의 안건으로 올릴 것",
  yt_total_views:
    "짧은 영상 업로드 주기를 올릴지 제작 회의에서 결정할 것",
};

/**
 * 인접 순위의 배수 상대차가 이 값 이하이면 순서를 확정하지 않는다(≈ 표기).
 * **표기용 휴리스틱**이지 오차 모형이 아니다 — 추정치(est)의 실제 오차
 * 분포를 우리는 모른다. 그래서 "±n%" 같은 범위를 지어내지 않고, "이 차이는
 * 추정 오차 안일 수 있다"는 사실만 표시한다. est 가 낀 쌍에만 적용한다.
 */
export const NEAR_TIE_RATIO = 0.1;

/**
 * 편수 기준 점수와 조회수 기준 점수의 차이가 이 값을 넘으면 "두 기준이
 * 갈린다"는 칩을 붙인다. 괴리 자체가 신호이므로(조회수가 소수 영상에 쏠림)
 * 어느 한쪽만 보여주면 그 신호가 사라진다.
 */
export const ORG_SCORE_GAP_CHIP = 15;

/**
 * 데뷔 전 구독 효율이 자사 대비 이 배수 이상인 팀이 있으면 유가 정황으로
 * 본다. 절대 임계가 아니라 **코호트 내 상대 비율**이다 — 데뷔 전 구간은
 * 조회수 자체가 적어 비율이 수십~수백으로 뜨는 게 정상이라, 절대선을
 * 그으면 전 팀이 걸리거나 아무도 안 걸린다.
 */
export const PRE_EFFICIENCY_OUTLIER_RATIO = 3;

export function fmtMultiple(m: number | null): string {
  return m == null ? "—" : `${(Math.round(m * 10) / 10).toFixed(1)}×`;
}

/** 순증 표기. 0 이하도 그대로 보여준다(감소를 숨기지 않는다). */
export function fmtDelta(n: number | null, unit: string): string | null {
  if (n == null) return null;
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${Math.abs(Math.round(n)).toLocaleString("ko-KR")}${unit}`;
}

/**
 * 유료 판정 제외 요약 한 줄 — "조회수 점수가 낮은 원인이 소수 집행 콘텐츠
 * 쏠림"임을 드릴다운 없이 보여준다. 동어반복 방지를 위해 제외 점수는 반드시
 * 쏠림 규모(편수·점유)와 한 문장에 묶는다. 필드가 하나라도 없으면 null —
 * 문장을 지어내지 않는다.
 */
export function exPaidNote(o: OrgRow | undefined | null): string | null {
  if (!o) return null;
  const { window_video_count: total, paid_video_count: paid,
    paid_view_share: share, score_view_weighted_ex_paid: exScore } = o;
  if (!total || !paid || share == null || exScore == null) return null;
  return `유료 광고로 판정된 영상 ${paid}편(전체 ${total}편)이 조회수의 `
    + `${Math.round(share * 100)}%를 차지한다 — 이들을 제외한 나머지 `
    + `${total - paid}편의 조회수 기준 점수는 ${exScore}점이다.`;
}

/**
 * B1 — 광고 의심 판정에 쓰는 점수 = 편수 기준과 조회수 기준 중 **낮은 쪽**.
 * 두 기준이 갈릴 때 높은 쪽을 택하면 "조회수는 광고성 영상 몇 편에 쏠렸는데
 * 편수로는 깨끗해 보이는" 팀이 통과한다. 조회수 점수가 없으면 편수만 쓴다
 * (없는 값을 0 으로 취급해 감점하지 않는다 — 기존 null 원칙).
 */
export function adJudgeScore(o: OrgRow | undefined | null): number | null {
  if (!o || o.score == null) return null;
  const v = o.score_view_weighted;
  return v == null ? o.score : Math.min(o.score, v);
}

/** 그룹 → 판정 점수(min). 점수가 없는 팀은 맵에 넣지 않는다. */
export function adScoreMap(d: CohortData): Map<string, number> {
  const m = new Map<string, number>();
  for (const o of d.organicity) {
    const s = adJudgeScore(o);
    if (s != null) m.set(o.group_key, s);
  }
  return m;
}

/** 내림차순 1-based 순위 (동률은 같은 순위 — 경쟁 순위). */
function rankDesc(mine: number, all: number[]): number {
  return all.filter((v) => v > mine).length + 1;
}

/** 이 화면의 순위·중앙값 모수 = 참조선(PLAVE)을 뺀 그룹. */
function peersOf(rows: ScRow[]): ScRow[] {
  return rows.filter((r) => !r.reference);
}

/**
 * E2 — 추정치가 낀 인접 순위 쌍 중 배수 차이가 NEAR_TIE_RATIO 이하인 쌍의
 * 그룹 키. 화면은 여기 든 행의 순위에 "≈" 를 붙여 순서를 확정하지 않는다.
 * est 가 안 낀 쌍은 실측끼리의 차이라 작아도 그대로 둔다.
 */
export function nearTieKeys(rows: ScRow[]): Set<string> {
  const out = new Set<string>();
  const ranked = peersOf(rows)
    .filter((r) => r.growth_multiple != null)
    .sort((a, b) => b.growth_multiple! - a.growth_multiple!);
  const tainted = (r: ScRow) =>
    r.source === "backfill_estimate" || r.base_source === "backfill_estimate";
  for (let i = 0; i + 1 < ranked.length; i++) {
    const a = ranked[i]!;
    const b = ranked[i + 1]!;
    if (!tainted(a) && !tainted(b)) continue;
    const hi = Math.max(a.growth_multiple!, b.growth_multiple!);
    if (hi <= 0) continue;
    if (Math.abs(a.growth_multiple! - b.growth_multiple!) / hi <= NEAR_TIE_RATIO) {
      out.add(a.group_key);
      out.add(b.group_key);
    }
  }
  return out;
}

/** C1 — 비교 대상 구성. 화면 상단 한 줄이 이 값에서 파생된다. */
export interface CohortComposition {
  /** 참조선을 뺀 후보 팀 수(MiiWAN 포함). */
  candidates: number;
  /** 그중 이 지표의 데뷔일 값이 확보돼 순위에 들어간 팀 수. */
  withData: number;
  /** 이 지표에서 제외된 (그룹,지표) 건수. */
  excluded: number;
  /** 참조 팀 이름 (순위 제외). */
  referenceNames: string[];
}

export function cohortComposition(d: CohortData, metric: string): CohortComposition {
  const sc = d.scorecard[metric];
  return {
    candidates: Object.values(d.groups).filter((g) => !g.reference).length,
    withData: sc?.cohort_size ?? 0,
    excluded: d.excluded.filter((e) => e.metric === metric).length,
    referenceNames: Object.values(d.groups).filter((g) => g.reference).map((g) => g.name),
  };
}

/**
 * C2 — 코호트의 실제 데뷔일 범위(참조 제외). 방법론 각주가 "데뷔일 X~Y 사이"
 * 로 대상을 정의한다. "전수"라는 말은 쓰지 않는다 — 이 볼트가 그걸 검증할
 * 방법이 없고, 검증 못 하는 주장은 투자 자료에서 가장 먼저 무너진다.
 */
export function debutDateRange(d: CohortData): { from: string; to: string } | null {
  const dates = Object.values(d.groups)
    .filter((g) => !g.reference && g.debut_date)
    .map((g) => g.debut_date!)
    .sort();
  if (!dates.length) return null;
  return { from: dates[0]!, to: dates[dates.length - 1]! };
}

/**
 * MiiWAN 의 자연 유입 점수와 그 순위. 순위 모수는 점수가 실제로 있는
 * 비참조 그룹만 — 점수가 없는 팀을 분모에 넣으면 "몇 팀 중 몇 위"가
 * 부풀고, PLAVE(참조선)는 체급이 달라 순위에서 빠진다(표·곡선과 동일 규칙).
 */
export function organicStanding(d: CohortData): {
  /** 편수 기준 점수 (막대가 보여주는 값). */
  score: number;
  /** 판정에 쓰는 점수 = 편수·조회수 중 낮은 쪽 (B1). 순위도 이 값 기준. */
  judgeScore: number;
  rank: number;
  size: number;
} | null {
  const scored = d.organicity.filter(
    (o): o is OrgRowScored => o.score != null && !o.reference,
  );
  const mine = scored.find((o) => o.group_key === "miiwan");
  if (!mine) return null;
  const judged = scored.map((o) => adJudgeScore(o)!);
  const myJudge = adJudgeScore(mine)!;
  return {
    score: mine.score,
    judgeScore: myJudge,
    // 순위도 판정 점수 기준 — 배지·흐린 선과 다른 숫자로 줄을 세우면
    // "우리는 2위인데 왜 의심 표시가 붙었나"가 화면 안에서 안 풀린다.
    rank: rankDesc(myJudge, judged),
    size: scored.length,
  };
}

export interface Headline {
  /** "데뷔 D+43일 차 (2026-06-16 데뷔), …" — 달력 날짜 병기. */
  lead: string;
  /** H1 — 대표 지표 한 줄 결론 (배수 · 순증 · 순위 · 출발선 해명). */
  conclusion: string | null;
  /** 상위 절반 항목 — 데뷔 후 성장 + 데뷔 전 성장. */
  strengths: string[];
  /** H3 — 강점이 없을 때 블록을 비우는 대신 쓸 문구 (숨김으로 읽히지 않게). */
  strengthsEmpty: string | null;
  /** H4 — 자연 유입 위치. 강·약점과 독립. */
  organicNote: string | null;
  /** 하위 절반 항목 — 순위 · 1위 수치 · 보완 방향. */
  weaknesses: string[];
  /** H8 — 경쟁 팀 유가 정황 종합(팀명 미표기). */
  paidSignalNote: string | null;
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

  // ── 지표별 데뷔 후 성장 순위 ────────────────────────────────────────
  for (const m of d.metrics) {
    const sc = d.scorecard[m];
    if (!sc || sc.miiwan_rank == null || sc.cohort_size < 2) continue;
    const label = METRIC_LABELS[m] ?? m;
    const mine = sc.rows.find((r) => r.group_key === "miiwan");
    const head = `${label} ${fmtMultiple(mine?.growth_multiple ?? null)}`
      + ` — 같은 시기 데뷔 ${sc.cohort_size}팀 중 ${sc.miiwan_rank}위`;
    if (sc.miiwan_rank <= Math.ceil(sc.cohort_size / 2)) {
      strengths.push(head);
    } else {
      // H5 — 순위만 있으면 "3위가 얼마나 뒤진 3위인가"를 알 수 없다.
      // 1위 수치를 같이 놓아야 격차가 회의에서 바로 논의된다.
      const top = peersOf(sc.rows)
        .filter((r) => r.growth_multiple != null)
        .sort((a, b) => b.growth_multiple! - a.growth_multiple!)[0];
      const gap = top && top.group_key !== "miiwan"
        ? ` (1위 ${d.groups[top.group_key]?.name ?? top.group_key}`
          + ` ${fmtMultiple(top.growth_multiple)})`
        : "";
      const remedy = WEAK_REMEDY[m];
      weaknesses.push(`${head}${gap}${remedy ? `. ${remedy}` : ""}`);
    }
  }

  // ── H2 데뷔 전 성장 ─────────────────────────────────────────────────
  // 데뷔 후 배수만 보면 "데뷔 시점에 이미 팬덤이 있었다"는 사실이 통째로
  // 사라진다 — 그건 출발선이 큰 이유이자 이 팀의 실제 강점이다.
  // H6: 모수가 데뷔 후 순위와 다를 수 있어(데뷔 전 값이 없는 팀 존재)
  // 분모를 그 자리에서 스스로 설명하게 쓴다.
  const preRows = peersOf(d.scorecard[PRIMARY_METRIC]?.rows ?? [])
    .filter((r) => r.pre_multiple != null);
  const minePre = preRows.find((r) => r.group_key === "miiwan");
  if (minePre && preRows.length >= 2) {
    const preRank = rankDesc(minePre.pre_multiple!, preRows.map((r) => r.pre_multiple!));
    const line = `데뷔 전 성장 ${fmtMultiple(minePre.pre_multiple)}`
      + ` — 데뷔 전 값이 있는 ${preRows.length}팀 중 ${preRank}위`;
    if (preRank <= Math.ceil(preRows.length / 2)) {
      strengths.push(`${line} (데뷔 시점에 이미 팬덤을 만들었다는 뜻)`);
    } else {
      weaknesses.push(line);
    }
  }

  // ── H4 자연 유입 위치 (강·약점과 독립) ──────────────────────────────
  // 톤: "광고가 아니라 팬이 만든 것"이라는 단정은 쓰지 않는다. 점수는 영상
  // 단위 판정의 평균이라 "광고가 하나도 없었다"를 증명하지 못하고, 실제로
  // 우리도 데뷔 전 구간이 완전히 깨끗하지는 않다.
  //
  // 자기 점수가 임계 아래면 순위와 무관하게 **먼저 그 사실을 말한다** —
  // 상위권이라는 이유로 자기 약점을 생략하면 그게 곧 숨김이다. 상대적으로
  // 낫다는 말은 그 뒤에 단서로만 붙인다.
  const org = organicStanding(d);
  const orgTop = org != null && org.size >= 2
    && org.rank <= Math.ceil(org.size / 2);
  // "상대적으로 낮은 편"의 주어를 반드시 적는다 — 주어가 없으면 바로 앞
  // 절이 순위 이야기라서 "순위가 낮다"로 읽히고, 뜻이 정반대가 된다.
  const relClause = org
    ? ` 다만 판정 가능한 ${org.size}팀 중 ${org.rank}위로, 유료 광고에 기댄 정도는`
      + ` 상대적으로 낮은 편이다.`
    : "";
  // F1 — 세 구간이 판정 점수만으로 서로 배타적으로 나뉜다 (순위는 첫 구간의
  // 부연에만 쓴다):
  //   ① score < suspect(40)         → 자체 약점을 먼저 말한다 (기존).
  //   ② suspect ≤ score < organic   → "회색 지대". 순위와 무관하게 항상
  //     노출해야 한다 — 그렇지 않으면 이 구간에 걸린 점수(예: 41.4)는
  //     ①에도 ③에도 안 걸려 H4 줄 자체가 통째로 사라진다(자기공시 소실).
  //   ③ score ≥ organic(70)         → 상위권 안심 문장. 예전엔 순위(orgTop)로
  //     게이트했는데, 점수 자체가 organic 을 넘겼다는 사실이 이미 "낮은 편"
  //     이라는 근거라 순위 게이트가 없어도 거짓이 되지 않는다.
  let organicNote: string | null = null;
  if (org && org.judgeScore < ORG_AD_SUSPECT_THRESHOLD) {
    organicNote = `자연 유입 점수 ${org.judgeScore}점으로 자체 기준`
      + `(${ORG_AD_SUSPECT_THRESHOLD}점) 아래라 우리 성장에도 광고 몫이 섞여 있을 수 있다.`
      + (orgTop ? relClause : "");
  } else if (org && org.judgeScore < VERDICT_THRESHOLDS.organic) {
    organicNote = `자연 유입 점수 ${org.judgeScore}점 — 광고 과다 기준선`
      + `(${ORG_AD_SUSPECT_THRESHOLD}점)은 넘었지만 자연 유입 우세 기준`
      + `(${VERDICT_THRESHOLDS.organic}점)에는 못 미쳐, 우리 성장에도 광고 몫이`
      + " 섞여 있을 수 있다.";
  } else if (org) {
    organicNote = `자연 유입 점수 ${org.judgeScore}점 — 판정 가능한 ${org.size}팀 중`
      + ` ${org.rank}위로, 유료 광고에 기댄 정도가 낮은 편이다.`;
  }

  return {
    lead: leadLine(d),
    conclusion: conclusionLine(d),
    strengths,
    // H3 — 빈 블록은 "숨겼다"로 읽힌다. 없으면 없다고 쓴다.
    strengthsEmpty: strengths.length
      ? null
      : "이번 비교에서 상위 절반에 든 항목이 없다.",
    organicNote,
    weaknesses,
    paidSignalNote: paidSignalLine(d),
    neutral: strengths.length || weaknesses.length
      ? null
      : "아직 같은 시기 데뷔 팀과 순위를 낼 만큼 데뷔일 시점 데이터가 모이지 않았다.",
  };
}

/** 리드 — 경과일만 쓰면 "언제 데뷔했나"를 화면 밖에서 찾아야 한다. */
function leadLine(d: CohortData): string {
  const debut = d.groups["miiwan"]?.debut_date;
  const when = debut ? ` (${debut} 데뷔)` : "";
  return `데뷔 D+${d.as_of_day}일 차${when}, 같은 시기에 데뷔한 팀들과 비교한 성적표`;
}

/**
 * H1 — 대표 지표 한 줄 결론. 배수·순증·순위에 더해 **출발선 순위**까지
 * 한 문장에 넣는다. 배수만 보면 "3위 = 못했다"로 끝나지만, 출발선이
 * 코호트 상위권이면 배수가 낮게 나오는 건 구조이지 성과가 아니다.
 * 그 인과 문장은 출발선이 실제로 큰 편일 때만 쓴다 — 작은 출발선에
 * 붙이면 그냥 거짓말이 된다.
 */
function conclusionLine(d: CohortData): string | null {
  const sc = d.scorecard[PRIMARY_METRIC];
  const mine = sc?.rows.find((r) => r.group_key === "miiwan");
  if (!sc || !mine || mine.growth_multiple == null) return null;
  const label = METRIC_LABELS[PRIMARY_METRIC] ?? PRIMARY_METRIC;
  const unit = METRIC_UNITS[PRIMARY_METRIC] ?? "";
  const delta = mine.value_at_day != null && mine.base_value != null
    ? fmtDelta(mine.value_at_day - mine.base_value, unit)
    : null;
  // 순위 절은 비교 대상이 2팀 이상일 때만. 미완이 1팀뿐이면 "1팀 중 1위"는
  // 자기 자신을 이긴 것이라 뜻이 없고, 표 각주("비교 대상 부족")와 화면
  // 안에서 정면 충돌한다 — 헤드라인 루프·표 각주·orgTop 과 같은 가드다.
  // 배수·순증 자체는 사실이므로 문장을 통째로 없애지는 않는다.
  const ranked = sc.miiwan_rank != null && sc.cohort_size >= 2;
  let out = `${label} ${fmtMultiple(mine.growth_multiple)}`
    + (delta ? ` (${delta})` : "")
    + (ranked ? ` — 같은 시기 ${sc.cohort_size}팀 중 ${sc.miiwan_rank}위.` : ".");

  const based = peersOf(sc.rows).filter((r) => r.base_value != null);
  if (mine.base_value != null && based.length >= 2) {
    const baseRank = rankDesc(mine.base_value, based.map((r) => r.base_value!));
    const size = based.length;
    const v = Math.round(mine.base_value).toLocaleString("ko-KR");
    out += baseRank <= Math.ceil(size / 2)
      ? ` 출발선 ${v}${unit}은 ${size}팀 중 ${baseRank}위 규모라 배수가 구조적으로 낮게 나온다.`
      : ` 출발선은 ${v}${unit}으로 ${size}팀 중 ${baseRank}위 규모다.`;
  }
  return out;
}

/**
 * H8 — 경쟁 팀 유가 정황 종합. **팀명은 쓰지 않는다**: 이 화면은 공개
 * 지표로 낸 자체 추정이고, 특정 사에 대한 단정은 우리가 질 수 없는
 * 주장이다. 팀별 수치는 표에 그대로 있으니 판단은 읽는 사람 몫으로 둔다.
 */
function paidSignalLine(d: CohortData): string | null {
  const scores = adScoreMap(d);
  const rows = peersOf(d.scorecard[PRIMARY_METRIC]?.rows ?? []);
  const mineEff = rows.find((r) => r.group_key === "miiwan")?.subs_per_1k_pre ?? null;
  const suspect = rows.some((r) => {
    if (r.group_key === "miiwan") return false;
    const s = scores.get(r.group_key);
    if (s != null && s < ORG_AD_SUSPECT_THRESHOLD) return true;
    return mineEff != null && mineEff > 0 && r.subs_per_1k_pre != null
      && r.subs_per_1k_pre >= mineEff * PRE_EFFICIENCY_OUTLIER_RATIO;
  });
  return suspect
    ? "일부 경쟁 팀은 구독 효율·자연 유입 점수에서 유료 캠페인 정황이 관측된다 (팀별 수치는 아래 표)."
    : null;
}
