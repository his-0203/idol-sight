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
  /**
   * 데뷔 창 활동 — "얼마나 올려서 얼마나 반응을 얻었나".
   * uploads 는 창 내 **업로드 전수**로 위 video_count(판정된 표본)와 모집단이
   * 다르다 — 화면은 "업로드 N편"과 "영상 N편"을 구분해 부르고 각주로 밝힌다.
   */
  uploads?: number;
  uploads_long?: number | null;
  uploads_short?: number | null;
  /** 창 내 총 조회수. 실측 0은 0으로 남고, 값 자체가 없으면 null. */
  window_views?: number | null;
  /** 조회 1,000회당 반응 수(좋아요+댓글 등). 분모 0이면 null. */
  engagement_per_1k_views?: number | null;
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

/**
 * 섹션별(산점도·성장곡선·상세표·자연 유입) MiiWAN 잘함/보완 두 줄의 공통 타입.
 * 값이 없으면 null — 문장을 지어내지 않는다. cohortQuality.ts가 이 파일을
 * import하는 기존 방향(cohortQuality → cohortHeadline)을 유지하려고 타입을
 * 여기 둔다 — 반대 방향으로 두면 순환 참조가 생긴다.
 *
 * F1(07-30 R3 타이포 리뷰) — sub = 잘함/보완과 **같은 사실을 보강하는 보조
 * 한 줄**. 예전엔 상세표 weak 이 "배수 순위 — 인과. 순증 순위."로 두 문장이
 * 돼, 한 줄로 스캔하는 위계 안에서 둘째 문장이 첫째와 같은 무게로 읽혔다.
 * 절을 지우는 대신 위계를 내린다(exPaidNote 의 headline/note 분리와 같은 패턴).
 * 쓰지 않는 verdict 는 이 필드를 아예 돌려주지 않고, 화면은 없으면 안 그린다.
 */
export interface SectionVerdict {
  good: string | null;
  weak: string | null;
  sub?: string | null;
}

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
 * 임계선 **위쪽으로** 이 점수 안쪽이면 "판정이 갈릴 수 있는 자리"로 본다.
 * 단측(one-sided)으로 쓴다 — gap = 점수 − 임계선이라 할 때
 * `gap < 0` = "기준선 아래"(이미 걸린 팀), `0 ≤ gap ≤ band` = "기준선 부근",
 * `gap > band` = 기준선에서 충분히 떨어짐. 아래쪽은 이 대역으로 완충하지
 * 않는다 — 기준선 아래는 근접 여부와 무관하게 그냥 걸린 것이고, 거기에
 * "부근이라 애매하다"를 붙이면 판정이 물러진다.
 * 원래 cohortQuality.ts(산점도)가 정의해 scatterNote 에서 썼던 상수 —
 * 이제 organicityVerdict(자연 유입 섹션)도 같은 판단을 문장으로 내야 해서
 * 여기로 옮겼다. cohortQuality.ts 는 이 파일을 import하는 기존 방향이라
 * (반대로 두면 순환 참조), qualityVerdict도 여기서 가져다 쓴다.
 */
export const THRESHOLD_NEAR_BAND = 10;

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
 * 유료 판정 제외 점수의 화면 라벨. 화면 네 곳(요약 줄·막대 숫자 컬럼·틱
 * 툴팁·캡션)이 같은 말을 써야 독자가 세 군데의 같은 수치를 같은 것으로
 * 읽는다. 예전 라벨 "제외 시"는 무엇을 제외했는지가 빠져 있어 "광고를 태운
 * 콘텐츠를 빼면 점수가 잘 나온다"는 사실 자체가 화면에서 안 읽혔다(07-30
 * 사용자 피드백). 상수로 두는 이유는 종전과 같다 — hand-copy desync 방지.
 */
export const EX_PAID_LABEL = "광고 투입 콘텐츠 제외";

/**
 * 유료 판정 제외 요약. headline(승격 표시용 결론 한 줄) / note(보조 각주) /
 * anchor(판정 점수 앵커)로 나눠 돌려준다 — 이 수치는 "보완할 점" 다음으로
 * 중요한데 예전엔 한 문장에 뭉쳐 있어 시각적으로 승격할 지점이 없었다
 * (07-30 피드백). 필드가 하나라도 없으면 null — 문장을 지어내지 않는다.
 *
 * R1(07-30 3방향 리뷰) 역할 분리 — 이 섹션은 판정을 두 곳에서 말하고 있었다.
 * 이제 **weak = 판정과 그 위치(짧게)**, **여기 = 쏠림 구조와 제외 점수(수치
 * 담당)**로 나눈다. 그래서 예전에 organicityVerdict.weak 이 들고 있던 쏠림
 * 원인 절(몇 편이 조회수 몇 %)이 이리로 내려왔고, weak 은 한 문장이 됐다.
 *
 * note 가 말하는 세 가지 (셋 다 데이터 파생 · 순서가 곧 읽는 순서):
 *  ⓐ 쏠림 대비 — 편수 비중과 조회수 점유를 **한 문장 안에서** 맞세운다.
 *    둘을 떼어 놓으면 "광고 영상이 11%뿐"과 "조회수의 71%"가 각각 다른
 *    결론으로 읽힌다. 나란히 놓아야 '쏠림'이 숫자로 보인다.
 *  ⓑ 보장 산술 — 제외 기준이 판정선과 같은 선이라 제외 후 점수가 그 위인
 *    것은 발견이 아니라 정의다. 예전엔 접은 각주에만 있어서, 접어둔 채로
 *    보면 보장된 산술이 성과처럼 읽혔다. 상시 공시로 승격한다.
 *  ⓒ 판정 앵커 — 제외 점수가 판정 점수보다 한참 높게 나오므로(ⓑ의 귀결),
 *    앵커가 없으면 독자가 제외 점수를 이 팀의 결론 점수로 가져간다.
 *    예전 문구는 "‘광고 의심’ 표시는 그대로"였는데 MiiWAN 행에는 그 표시가
 *    없어 화면에 없는 것을 지칭했다 — 판정 점수 자체를 앵커로 바꾼다.
 * 데이터에서 파생되지 않는 해석(예: "나머지는 자연 소비다")은 붙이지 않는다.
 *
 * R3(07-30 타이포 리뷰) — ⓐ·ⓑ(쏠림 구조)와 ⓒ(판정 점수 앵커)는 성격이
 * 다르다: 앞은 "이 수치를 어떻게 읽나", 뒤는 "그래도 결론 점수는 무엇인가"다.
 * 한 문단에 이어 붙여 두니 앵커가 쏠림 설명의 꼬리처럼 읽혀 그냥 지나쳤다 —
 * 필드를 나눠 화면이 줄을 분리해 그린다(문구·게이트는 그대로).
 */
export interface ExPaidNote {
  /** 승격 표시용 결론 — "광고 투입 콘텐츠 제외 69.5점". */
  headline: string;
  /** 보조 각주 ⓐⓑ — 쏠림 대비 + 보장 산술. */
  note: string;
  /** 보조 각주 ⓒ — 판정 점수 앵커. note 와 줄을 나눠 그린다. */
  anchor: string;
}

export function exPaidNote(o: OrgRow | undefined | null): ExPaidNote | null {
  if (!o) return null;
  const { window_video_count: total, paid_video_count: paid,
    paid_view_share: share, score_view_weighted_ex_paid: exScore } = o;
  if (!total || !paid || share == null || exScore == null) return null;
  const judge = adJudgeScore(o);
  const T = ORG_AD_SUSPECT_THRESHOLD;
  return {
    headline: `${EX_PAID_LABEL} ${exScore}점`,
    note: `전체 ${total}편 중 광고 투입 판정 ${paid}편(편수의 ${Math.round(paid / total * 100)}%)이`
      + ` 조회수의 ${Math.round(share * 100)}%를 가져갔다.`
      + ` 제외 기준이 판정선(${T}점 미만)과 같아 제외 후 점수가 ${T}점 위인 것 자체는`
      + ` 당연하다 — 볼 것은 쏠림의 규모다.`,
    anchor: judge == null
      ? "위 판정 점수는 이 수치와 무관하게 그대로다."
      : `판정 점수 ${judge}점은 이 수치와 무관하게 그대로다.`,
  };
}

/**
 * A5(07-30 경영 리뷰) — 자연 유입 섹션은 "광고 영향을 배제하기 어렵다"에서
 * 끝나 독자가 다음에 무엇을 할지 알 수 없었다. WEAK_REMEDY 와 같은 성격의
 * **정적 액션 안내**라 데이터 파생이 아니다(수치·결론이 아니라 다음 안건).
 * 상수로 두는 이유도 같다 — 화면에 손으로 적으면 문구가 조용히 갈린다.
 */
export const ORG_ACTION_HINT =
  "다음 액션 — 광고 집행 내역(어느 영상·기간)을 정리해 판정과 대조할 수 있게 준비할 것.";

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
  /**
   * 같은 모수(size) 안에서 **편수 기준 점수**로 다시 센 순위. 편수 점수를
   * 말하는 문장은 편수 순위를, 판정 점수를 말하는 문장은 판정 순위(rank)를
   * 써야 하는데 둘을 각자 계산하면 모수가 갈린다 — 한 함수가 같은 scored
   * 집합에서 두 순위를 함께 내 "N팀"이 항상 같은 N이 되게 한다.
   */
  scoreRank: number;
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
    scoreRank: rankDesc(mine.score, scored.map((o) => o.score)),
    size: scored.length,
  };
}

/**
 * 성장곡선(③ 지표 탭)의 MiiWAN 읽기. 곡선은 기울기만 보이고 "그래서
 * 우리는 잘하는 건가"가 화면에 없다 — 순증(늘어난 사람 수)이 늘고
 * 있는지와, 배수로 보면 왜 하위권으로 보이는지를 한 쌍으로 낸다.
 * PRIMARY_METRIC 고정(헤드라인 대표 지표와 같은 기준 — 탭을 바꿔도
 * 이 카드의 결론이 바뀌면 안 된다).
 */
export function curveVerdict(d: CohortData): SectionVerdict {
  const sc = d.scorecard[PRIMARY_METRIC];
  const rows = sc?.rows ?? [];
  const mine = rows.find((r) => r.group_key === "miiwan");
  if (!mine || mine.growth_multiple == null) return { good: null, weak: null };
  const delta = mine.value_at_day != null && mine.base_value != null
    ? mine.value_at_day - mine.base_value : null;
  const stalled = rows.filter((r) =>
    !r.reference && r.group_key !== "miiwan" && r.growth_multiple != null && r.growth_multiple <= 1).length;
  const unit = METRIC_UNITS[PRIMARY_METRIC] ?? "";
  // I1 — 예전엔 "완만하다 · 곡선의 기울기만 보면 하위권이다"를 배수와 무관하게
  // 붙였다. 배수가 좋아져도 같은 자기비하가 나가고, 실제 순위(miiwan_rank)와
  // 어긋날 수도 있다. 평가어를 빼고 응답이 준 순위 사실만 쓴다 — 순위 모수가
  // 없거나 비교 대상이 1팀뿐이면("1팀 중 1위"는 뜻이 없다) 배수만 말한다.
  const ranked = sc?.miiwan_rank != null && sc.cohort_size >= 2
    ? ` ${sc.cohort_size}팀 중 ${sc.miiwan_rank}위다` : null;
  const multClause = (lead: string) =>
    `${lead} ${fmtMultiple(mine.growth_multiple)}${ranked ? `로${ranked}` : ""}.`;
  let good: string | null = null;
  let weak: string | null;
  if (delta != null && delta > 0) {
    good = `데뷔 후에도 ${METRIC_LABELS[PRIMARY_METRIC]}가 ${fmtDelta(delta, unit)} 늘며 증가를 유지하고 있다`
      + (stalled > 0 ? ` — 데뷔 후 늘지 않은 ${stalled}팀과 대비된다.` : ".");
    weak = multClause("증가 폭은");
  } else {
    weak = delta != null
      ? `데뷔 후 ${METRIC_LABELS[PRIMARY_METRIC]}가 ${fmtDelta(delta, unit)} — 증가가 멈춰 있다.`
      : multClause("데뷔 후 증가 폭은");
  }
  return { good, weak };
}

/**
 * 팀별 상세표(④)의 MiiWAN 읽기. 표에는 출발선·데뷔 전/후 배수 5개 숫자가
 * 나열만 돼 있어 "무엇이 강점이고 무엇이 약점인지"가 스스로 안 읽힌다.
 * good=출발선·데뷔 전 배수(둘 다 있어야), weak=데뷔 후 배수(순위까지
 * 응답에 있어야) — null-안전.
 */
export function scorecardVerdict(d: CohortData, metric: string): SectionVerdict {
  const sc = d.scorecard[metric];
  const rows = sc?.rows ?? [];
  const mine = rows.find((r) => r.group_key === "miiwan");
  if (!mine) return { good: null, weak: null };
  const peers = rows.filter((r) => !r.reference && r.group_key !== "miiwan");
  const baseRank = mine.base_value != null
    ? peers.filter((r) => (r.base_value ?? -1) > mine.base_value!).length + 1 : null;
  const baseN = rows.filter((r) => !r.reference && r.base_value != null).length;
  // I4 — 데뷔 전 배수는 값이 없는 팀이 있어 모수가 출발선(baseN)과 다르다.
  // 예전엔 preRank 만 내고 baseN 옆에 붙여 놔서 "같은 N팀 중"으로 읽혔고,
  // pre_multiple 이 없는 팀이 암묵적으로 아래 순위로 세어지고 있었다.
  // 헤드라인 H2 와 같은 표현("데뷔 전 값이 있는 N팀 중")으로 모수를 그
  // 자리에서 스스로 설명하게 만든다.
  const prePeers = peers.filter((r) => r.pre_multiple != null);
  const preRank = mine.pre_multiple != null
    ? prePeers.filter((r) => r.pre_multiple! > mine.pre_multiple!).length + 1 : null;
  const preN = mine.pre_multiple != null ? prePeers.length + 1 : 0;
  const good = baseRank != null && preRank != null
    ? `출발선(데뷔일 값)은 ${baseN}팀 중 ${baseRank}위, 데뷔 전 성장 배수 ${fmtMultiple(mine.pre_multiple)}는`
      + ` 데뷔 전 값이 있는 ${preN}팀 중 ${preRank}위`
      // 1위 강조는 실제로 겨룰 상대가 있을 때만 — "1팀 중 1위"에 붙이면
      // 자기 자신을 이긴 것을 강점으로 파는 문장이 된다.
      + (preRank === 1 && preN >= 2 ? " — 데뷔 전에 이미 팬덤을 쌓아둔 팀이다." : ".")
    : null;
  // C3(07-30 투자 리뷰) — "출발선이 큰 만큼 배수가 작게 나온다"는 인과는
  // 출발선이 실제로 큰 편일 때만 참이다. 예전엔 무조건 붙어서, 출발선이
  // 하위권인 창에서도 같은 변명이 나갔다. 헤드라인 conclusionLine 과 **같은
  // 규칙**(상위 절반)으로 게이트한다 — 두 문장이 한 화면에 있는데 서로 다른
  // 기준으로 인과를 붙이면 어느 쪽이 맞는지 독자가 판정할 수 없다.
  const baseTopHalf = baseRank != null && baseN >= 2
    && baseRank <= Math.ceil(baseN / 2);
  // C4(07-30 투자 리뷰) — "늘어난 사람 수와 같이 읽는다"는 읽는 법만 주고
  // 정작 그 순위를 안 줬다. 순증(D+N 값 − 출발선) 순위를 데이터로 낸다.
  // 모수는 pre/base 와 같은 패턴 — 순증을 낼 수 있는 비참조 팀만 센다
  // (값이 없는 팀을 분모에 넣으면 "N팀 중"이 부풀고 그 팀이 암묵적으로
  // 아래 순위로 세어진다).
  const deltaOf = (r: ScRow) => r.value_at_day != null && r.base_value != null
    ? r.value_at_day - r.base_value : null;
  const myDelta = deltaOf(mine);
  const deltaPeers = peers.map(deltaOf).filter((v): v is number => v != null);
  const deltaN = myDelta != null ? deltaPeers.length + 1 : 0;
  const unit = METRIC_UNITS[metric] ?? "";
  // F1(07-30 R3 타이포 리뷰) — 순증 순위는 weak 문장에 이어 붙이지 않고 보조
  // 줄(sub)로 내린다. 예전엔 "배수 순위 — 인과. 순증 순위."로 두 문장이 돼,
  // 한 줄로 스캔하는 위계에서 뒤 문장이 앞 문장과 같은 무게로 읽혔다(배수와
  // 순증은 같은 층위가 아니라 "배수로는 이렇지만 사람 수로는" 보강 관계다).
  // N5 — 모수도 그 자리에서 스스로 설명한다(pre/base 절과 같은 패턴).
  const hasDelta = myDelta != null && deltaN >= 2;
  const weak = mine.growth_multiple != null && sc?.miiwan_rank != null && sc.cohort_size >= 2
    ? `데뷔 후 성장 배수 ${fmtMultiple(mine.growth_multiple)}는 ${sc.cohort_size}팀 중 ${sc.miiwan_rank}위다`
      + (baseTopHalf
        // 순증 순위(sub)가 있으면 "같이 읽는다"는 안내는 중복이라 뺀다 —
        // 읽는 법 대신 실제 순위가 바로 아래 줄에 있다.
        ? (hasDelta
          ? " — 출발선이 큰 만큼 배수는 구조적으로 작게 나온다."
          : " — 출발선이 큰 만큼 배수는 구조적으로 작게 나오니, 늘어난 사람 수와 같이 읽는다.")
        : ".")
    : null;
  // G2(07-30 R3b 리뷰) — sub 는 **weak 을 보강하는** 줄이라 weak 없이 홀로
  // 나가면 안 된다. 순위 모수가 없어 weak 이 null 인 창(배수·순위를 못 내는
  // 상태)에서 "순증은 N팀 중 M위다"만 남으면, 보강할 대상이 화면에 없는데
  // 보조 줄만 뜬다 — 무엇에 대한 보강인지 모르는 고아 문장이 된다.
  const sub = weak != null && hasDelta
    ? `순증(${fmtDelta(myDelta, unit)})은 순증 값이 있는 ${deltaN}팀 중`
      + ` ${rankDesc(myDelta!, deltaPeers)}위다.`
    : null;
  return { good, weak, sub };
}

/**
 * 자연 유입 섹션(⑤)의 MiiWAN 읽기 — 헤드라인에서 뺀 자기공시(판정 점수 ↔
 * 기준선 관계, 광고 영향을 배제하기 어렵다는 사실)가 여기로 옮겨온다.
 * good/weak 모두 organicStanding() 을 재사용해 배지·표와 같은 숫자를 쓴다
 * (같은 팀을 다른 숫자로 두 번 줄 세우지 않는다).
 *
 * C1 — 이 섹션은 한 화면 안에서 세 숫자를 동시에 보여준다: 편수 점수(good이
 * 말하는 값) · 판정 점수(막대·배지가 그리는 값, 편수·조회수 중 낮은 쪽) ·
 * 판정 점수로 정렬된 팀 목록. 예전 good은 편수 순위를 "판정 가능한 N팀 중
 * M위"라는 **판정 기준 문구**에 실어 목록 순서와 어긋났고, 등급 선언
 * ("자연 유입 우세 등급")까지 편수 점수로 내 바로 아래 주황 막대와 정면
 * 충돌했다. 그래서 ⓐ 순위는 기준을 문장에 박아 쓰고("편수 기준으로는")
 * ⓑ 등급 선언은 판정 점수가 실제로 우세 등급일 때만 낸다.
 */
export function organicityVerdict(d: CohortData): SectionVerdict {
  const standing = organicStanding(d);
  if (!standing) return { good: null, weak: null };
  // 순위 절은 겨룰 상대가 있을 때만 — 화면 다른 곳(헤드라인 결론·표 각주)과
  // 같은 가드다. "1팀 중 1위"는 자기 자신을 이긴 것이라 뜻이 없다.
  const rankClause = standing.size >= 2
    ? ` — 편수 기준으로는 ${standing.size}팀 중 ${standing.scoreRank}위` : "";
  // A1(07-30 3방향 리뷰) — 예전 문구는 "대부분은 자연 **소비**되고 있다"였다.
  // '소비'는 조회수 개념인데 이 점수의 근거는 편수라, 바로 아래 "조회수의
  // 71%가 광고 투입 영상에 쏠렸다"와 같은 화면에서 정면 충돌했다. 편수
  // 근거에 맞는 카탈로그 표현(무엇이 올라갔나)으로 바꾼다.
  //
  // 게이트는 두 조건의 **AND** 다 — 둘은 서로 다른 실패를 막는다.
  //  ① 편수 비율(N8, 07-30 R3 투자 리뷰): 평균 점수는 과반을 보장하지 않는다.
  //     절반 넘는 영상이 광고 판정을 받아도 나머지가 고득점이면 평균은
  //     borderline 을 넘길 수 있고, 그러면 "대부분은 광고 없이 올라갔다"가
  //     편수 사실과 정면으로 어긋난다. 세는 값이 없으면 절을 생략한다
  //     (없는 값을 추정하지 않는다).
  //  ② 편수 점수 평균(원래 가드, G3 복원): 비율만 보면 "광고 판정은 10%뿐인데
  //     나머지 영상의 점수가 바닥"인 창에서도 절이 나간다 — 낮은 점수에 붙는
  //     '대부분' 결론은 바로 옆 점수와 정반대되는 말을 같은 문장이 하는 꼴이다.
  const vids = d.organicity.find((o) => o.group_key === "miiwan");
  const vTotal = vids?.window_video_count;
  const vPaid = vids?.paid_video_count;
  const organicShare = vTotal != null && vTotal > 0 && vPaid != null
    ? (vTotal - vPaid) / vTotal : null;
  const bulk = organicShare != null && organicShare > 0.5
    && standing.score >= VERDICT_THRESHOLDS.borderline
    ? "만든 영상의 대부분은 광고 없이 올라간 것으로 판정됐다." : null;
  // 등급 선언의 기준은 반드시 판정 점수(min) — 막대·배지가 그리는 값이다.
  const grade = standing.judgeScore >= VERDICT_THRESHOLDS.organic
    ? `판정 점수(편수·조회수 중 낮은 쪽) ${standing.judgeScore}점 기준으로도 자연 유입 우세 등급이다.` : null;
  const good = `영상 편수 기준 ${standing.score}점${rankClause}.`
    + [bulk, grade].filter((s): s is string => s != null).map((s) => ` ${s}`).join("");
  let weak: string | null = null;
  if (standing.judgeScore < VERDICT_THRESHOLDS.organic) {
    const nearLine = standing.judgeScore - ORG_AD_SUSPECT_THRESHOLD;
    // A2(07-30 3방향 리뷰) — 예전 weak 은 판정 위치 + 쏠림 원인 절을 한 문단에
    // 다 담아 세 절짜리 문장이 됐고, 바로 아래 제외 점수 문단이 같은 쏠림을
    // 다시 말했다. 역할을 나눈다: **weak = 판정과 그 위치(한 문장)**,
    // 쏠림 수치는 exPaidNote 가 전담. 허수아비 부정("전체가 광고성이라는 뜻은
    // 아니다")도 뺀다 — 아무도 하지 않은 주장을 반박하면 오히려 그 주장이
    // 화면에 남는다.
    // 판정 순위(standing.rank)를 병기하는 이유: 점수만으론 "40점 부근"이
    // 코호트 안에서 흔한 자리인지 유독 낮은 자리인지 알 수 없다. 순위 절은
    // 겨룰 상대가 있을 때만 — 화면 다른 곳과 같은 가드다.
    const rankClause = standing.size >= 2 ? ` ${standing.size}팀 중 ${standing.rank}위,` : "";
    weak = `판정 점수(편수·조회수 중 낮은 쪽) ${standing.judgeScore}점은${rankClause}`
      + ` 광고 과다 기준선(${ORG_AD_SUSPECT_THRESHOLD}점) `
      + (nearLine < 0
        ? "아래라"
        : nearLine <= THRESHOLD_NEAR_BAND
          ? "부근이라"
          : `위지만 자연 유입 우세(${VERDICT_THRESHOLDS.organic}점)에는 못 미쳐`)
      + " 광고 영향을 배제하기 어렵다.";
  }
  return { good, weak };
}

/**
 * ⑤-b 데뷔 창 활동 — "얼마나 올려서 얼마나 반응을 얻었나"(투입 대비 산출).
 *
 * 이 표에 세울 행 = 활동 데이터가 실제로 있는 그룹만. 정렬은 창 내 조회수
 * 내림차순이고 참조선(PLAVE)은 맨 아래 — 순위 모수 밖이라 섞어 세우면
 * "1위 PLAVE"로 읽힌다(스코어카드 표와 같은 규칙).
 */
export function activityRows(d: CohortData): OrgRow[] {
  return d.organicity
    .filter((o) => (o.uploads ?? 0) > 0 || o.window_views != null)
    .sort((a, b) => {
      if (a.reference !== b.reference) return a.reference ? 1 : -1;
      return (b.window_views ?? -1) - (a.window_views ?? -1);
    });
}

/** 활동 지표 한 축의 MiiWAN 값·순위. 참조선 제외, 값이 없는 팀은 모수에서 뺀다. */
function activityRank(rows: OrgRow[], pick: (o: OrgRow) => number | null):
  { value: number; rank: number; size: number } | null {
  const vals: Array<{ key: string; v: number }> = [];
  for (const o of rows) {
    if (o.reference) continue;
    const v = pick(o);
    if (v != null && Number.isFinite(v)) vals.push({ key: o.group_key, v });
  }
  const mine = vals.find((x) => x.key === "miiwan");
  // 겨룰 상대가 없으면 순위를 내지 않는다 — "1팀 중 1위"는 자기 자신을
  // 이긴 것이라 뜻이 없다(화면 다른 곳과 같은 가드).
  if (!mine || vals.length < 2) return null;
  return {
    value: mine.v,
    rank: rankDesc(mine.v, vals.map((x) => x.v)),
    size: vals.length,
  };
}

/**
 * 데뷔 창 활동 섹션의 MiiWAN 읽기. 세 축(업로드 전수 · 창 내 조회수 ·
 * 조회 1,000회당 반응)을 각각 상위 절반이면 잘하는 점, 하위 절반이면
 * 보완할 점으로 가른다 — 헤드라인·상세표와 같은 상위 절반 규칙이다.
 *
 * 업로드가 상위인데 조회수가 하위인 경우에만 두 순위를 한 절에서 맞세운다:
 * 이 섹션의 존재 이유가 "투입 대비 산출"이라, 그 대비를 각각 다른 줄로
 * 떼어 놓으면 "많이 올렸다"와 "덜 봤다"가 서로 무관한 두 사실로 읽힌다.
 * 문장은 각각 한 개 — 절은 쉼표로 잇되 마침표를 늘리지 않는다(K5).
 */
export function activityVerdict(d: CohortData): SectionVerdict {
  const rows = d.organicity;
  const up = activityRank(rows, (o) => (o.uploads ?? 0) > 0 ? o.uploads! : null);
  const views = activityRank(rows, (o) => o.window_views ?? null);
  const dens = activityRank(rows, (o) => o.engagement_per_1k_views ?? null);
  const topHalf = (r: { rank: number; size: number }) =>
    r.rank <= Math.ceil(r.size / 2);
  const good: string[] = [];
  const weak: string[] = [];
  const put = (r: { rank: number; size: number } | null, clause: string) => {
    if (!r) return;
    (topHalf(r) ? good : weak).push(clause);
  };
  // 순서는 표의 컬럼 순서와 같다(업로드 → 조회수 → 반응 밀도) — 문장과 표가
  // 다른 순서로 읽히면 같은 수치를 두 번 찾게 된다.
  if (up) put(up, `업로드 ${up.value.toLocaleString("ko-KR")}편은 ${up.size}팀 중 ${up.rank}위`);
  if (views) {
    put(views, up && topHalf(up) && !topHalf(views)
      ? `창 내 조회수는 ${views.size}팀 중 ${views.rank}위로,`
        + ` 업로드 순위(${up.rank}위)만큼 도달이 따라오지 않는`
      : `창 내 조회수는 ${views.size}팀 중 ${views.rank}위`);
  }
  if (dens) {
    put(dens, `조회 1,000회당 반응 ${dens.value.toFixed(1)}건은`
      + ` ${dens.size}팀 중 ${dens.rank}위`);
  }
  const join = (parts: string[]) => parts.length ? `${parts.join(", ")}다.` : null;
  return { good: join(good), weak: join(weak) };
}

/**
 * "다음 보고까지" 카드의 액션·산출물.
 *
 * ⚠ 운영 약속 — **데이터에서 파생되지 않는다. 보고 주기마다 사람이 갱신한다.**
 * 이 파일의 다른 문장들과 성격이 정반대인 유일한 상수다(나머지는 전부 응답에서
 * 계산한다). 그래서 ⓐ 수치·시점을 여기에 적지 않고(화면이 as_of_day 에서
 * 파생한다) ⓑ "무엇을 해서 → 다음 보고 때 무엇을 가져올지"의 쌍 구조를
 * 유지한다. 쌍이 깨지면 이 카드는 그냥 할 일 목록이 되고, 투자사·경영진이
 * 다음 보고에서 무엇을 검증할 수 있는지가 사라진다.
 * 문구를 바꿀 때는 화면 다른 곳(자연 유입 섹션의 ORG_ACTION_HINT)과
 * 어긋나지 않는지 함께 본다.
 */
export const NEXT_REPORT_ACTIONS: ReadonlyArray<{
  action: string; deliverable: string;
}> = [
  {
    action: "광고 집행 내역(영상·기간·금액)을 정리해 자연 유입 판정과 대조한다",
    deliverable: "판정 점수 검증 결과와 광고 의존도 실측",
  },
  {
    action: "데뷔 후 성장 레버(콘텐츠 주기·구독 유도 지점)를 실행한다",
    deliverable: "다음 보고 시점의 데뷔 후 성장 배수·순증 재측정",
  },
  {
    action: "업로드 구성(롱·숏)과 반응 밀도를 유지하며 관찰한다",
    deliverable: "데뷔 창 활동 표의 추이 비교",
  },
];

export interface NextReportCard {
  /** 데이터 파생 강점 불릿 (최대 3, 조건 미충족이면 생략). */
  strengths: string[];
  /** 데이터 파생 보완 불릿 (최대 3). */
  focus: string[];
  /** 운영 약속 (NEXT_REPORT_ACTIONS 그대로 — 파생 아님). */
  actions: ReadonlyArray<{ action: string; deliverable: string }>;
}

/** 카드 불릿 상한 — 넷 이상이면 "요약"이 아니라 또 하나의 목록이 된다. */
const NEXT_REPORT_BULLETS = 3;

/**
 * ⑥ 각주 바로 위의 "다음 보고까지" 카드.
 *
 * 헤드라인(①)은 **한 줄 결론**이고 이 카드는 **행동 지향 요약**이다 —
 * 화면 전체(산점도·곡선·표·자연 유입·데뷔 창 활동)에 흩어진 판정을 강점 /
 * 보완 / 다음 액션 세 덩어리로 모은다. 문장을 새로 쓰되 **판단은 새로 하지
 * 않는다**: 각 항목의 게이트는 그 섹션 verdict 가 이미 쓰는 것과 같은 것을
 * 재사용하고(총 성장·데뷔 전 배수·순증·편수 점수·판정 점수·쏠림), 수치는
 * 전부 응답에서 파생한다. 그래야 카드와 아래 섹션이 서로 다른 말을 하지 않는다.
 *
 * verdicts 로 받는 두 판정은 **게이트 재사용**이 목적이다(문장을 베끼지
 * 않는다): curve.good = "데뷔 후 순증이 이어지는 창", organicity.weak =
 * "판정 점수가 자연 유입 우세에 못 미치는 창". 같은 조건을 여기서 다시
 * 구현하면 한쪽만 바뀌었을 때 화면이 자기모순에 빠진다.
 */
export function nextReportCard(d: CohortData, verdicts: {
  curve: SectionVerdict; organicity: SectionVerdict;
}): NextReportCard {
  const sc = d.scorecard[PRIMARY_METRIC];
  const rows = sc?.rows ?? [];
  const mine = rows.find((r) => r.group_key === "miiwan");
  const peers = peersOf(rows);
  const standing = organicStanding(d);
  const strengths: string[] = [];
  const focus: string[] = [];

  // ── 강점 ────────────────────────────────────────────────────────────
  // ① 총 성장 배수 = 산점도 x축이 쓰는 값(데뷔 전 구간 포함). 1~2위일 때만.
  const totals = peers.filter((r) => r.total_multiple != null);
  if (mine?.total_multiple != null && totals.length >= 2) {
    const rank = rankDesc(mine.total_multiple, totals.map((r) => r.total_multiple!));
    if (rank <= 2) {
      strengths.push(`총 성장 ${fmtMultiple(mine.total_multiple)} — ${totals.length}팀 중 ${rank}위.`);
    }
  }
  // ② 데뷔 전 배수 1위 (헤드라인 H2·상세표 good 과 같은 모수 규칙).
  const preRows = peers.filter((r) => r.pre_multiple != null);
  if (mine?.pre_multiple != null && preRows.length >= 2) {
    const rank = rankDesc(mine.pre_multiple, preRows.map((r) => r.pre_multiple!));
    if (rank === 1) {
      strengths.push(`데뷔 전 성장 ${fmtMultiple(mine.pre_multiple)}`
        + ` — 데뷔 전 값이 있는 ${preRows.length}팀 중 1위.`);
    }
  }
  // ③ 데뷔 후 순증 지속 — 게이트는 곡선 verdict 의 good(= 순증 > 0)과 동일.
  const delta = mine?.value_at_day != null && mine.base_value != null
    ? mine.value_at_day - mine.base_value : null;
  if (verdicts.curve.good && delta != null && delta > 0) {
    strengths.push(`데뷔 후 ${METRIC_LABELS[PRIMARY_METRIC] ?? PRIMARY_METRIC}`
      + ` ${fmtDelta(delta, METRIC_UNITS[PRIMARY_METRIC] ?? "")} — 증가가 이어진다.`);
  }
  // ④ 편수 기준 자연 유입 점수 상위 절반 (자연 유입 섹션 good 과 같은 순위).
  if (standing && standing.size >= 2
    && standing.scoreRank <= Math.ceil(standing.size / 2)) {
    strengths.push(`영상 편수 기준 자연 유입 ${standing.score}점`
      + ` — ${standing.size}팀 중 ${standing.scoreRank}위.`);
  }

  // ── 보완 ────────────────────────────────────────────────────────────
  // ① 데뷔 후 배수 하위권 (헤드라인 루프와 같은 상위 절반 규칙).
  if (sc?.miiwan_rank != null && sc.cohort_size >= 2 && mine?.growth_multiple != null
    && sc.miiwan_rank > Math.ceil(sc.cohort_size / 2)) {
    // 출발선이 상위권이면 그 사실을 같은 줄에 단다 — 화면의 다른 두 곳
    // (헤드라인 결론·상세표 보완)이 이미 "출발선이 큰 만큼 배수는 구조적으로
    // 작게 나온다"를 같은 게이트로 말하고 있어서, 여기서만 맨 순위로 끝내면
    // 요약 카드가 본문보다 가혹한 판정을 내리는 꼴이 된다.
    const based = peers.filter((r) => r.base_value != null);
    const baseRank = mine.base_value != null && based.length >= 2
      ? rankDesc(mine.base_value, based.map((r) => r.base_value!)) : null;
    const baseClause = baseRank != null && baseRank <= Math.ceil(based.length / 2)
      ? `(출발선 ${baseRank}위 규모)` : "";
    focus.push(`데뷔 후 성장 배수 ${fmtMultiple(mine.growth_multiple)}`
      + ` — ${sc.cohort_size}팀 중 ${sc.miiwan_rank}위${baseClause}.`);
  }
  // ② 판정 점수가 자연 유입 우세에 못 미치는 창 — 게이트는 ⑤ 섹션의 weak.
  if (verdicts.organicity.weak && standing) {
    focus.push(`판정 점수 ${standing.judgeScore}점`
      + ` — 자연 유입 우세(${VERDICT_THRESHOLDS.organic}점)에 못 미친다.`);
  }
  // ③ 조회수 쏠림 — 광고 투입 판정 영상이 창 조회수를 얼마나 가져갔나.
  const org = d.organicity.find((o) => o.group_key === "miiwan");
  if (org?.paid_view_share != null && (org.paid_video_count ?? 0) > 0) {
    focus.push(`광고 투입 판정 ${org.paid_video_count}편이`
      + ` 창 조회수의 ${Math.round(org.paid_view_share * 100)}%.`);
  }

  return {
    strengths: strengths.slice(0, NEXT_REPORT_BULLETS),
    focus: focus.slice(0, NEXT_REPORT_BULLETS),
    actions: NEXT_REPORT_ACTIONS,
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
  /** 하위 절반 항목 — 순위 · 1위 수치 · 보완 방향. */
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

  // ── 지표별 데뷔 후 성장 순위 ────────────────────────────────────────
  for (const m of d.metrics) {
    const sc = d.scorecard[m];
    if (!sc || sc.miiwan_rank == null || sc.cohort_size < 2) continue;
    const label = METRIC_LABELS[m] ?? m;
    const mine = sc.rows.find((r) => r.group_key === "miiwan");
    // B4(07-30 경영 리뷰) 라벨 정합 — 이 배수는 growth_multiple(데뷔 후)인데
    // 수식이 없어, 같은 목록의 "데뷔 전 성장 13.8×"·산점도의 "총 성장 배수
    // 15.0×"와 나란히 놓이면 세 배수가 같은 축으로 읽혔다. 계산은 그대로
    // 두고 라벨만 붙인다.
    const head = `${label} 데뷔 후 성장 ${fmtMultiple(mine?.growth_multiple ?? null)}`
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

  return {
    lead: leadLine(d),
    conclusion: conclusionLine(d),
    strengths,
    // H3 — 빈 블록은 "숨겼다"로 읽힌다. 없으면 없다고 쓴다.
    strengthsEmpty: strengths.length
      ? null
      : "이번 비교에서 상위 절반에 든 항목이 없다.",
    weaknesses,
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
  // B4 — 라벨 정합. 이 배수도 growth_multiple(데뷔 후)이다(위 루프와 같은 이유).
  let out = `${label} 데뷔 후 성장 ${fmtMultiple(mine.growth_multiple)}`
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
