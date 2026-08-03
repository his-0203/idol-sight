// MiiWAN 포지션 뷰의 순수 로직 — "시장 어디에 서 있고 어느 방향으로
// 움직이는가"를 기존 API 응답에서 파생한다 (신규 수집 0).
//
// 원칙 (cohortHeadline과 동일):
//  - 수치·순위는 전부 응답에서 계산. 코드에는 문구 틀만 둔다.
//  - K-POP / 서브컬처는 한 평면에서 비교하지 않는다 — 호출자가 K-POP
//    키 집합을 넘겨야 하고, 순위 모수는 그 집합으로 한정된다.

import type { QuadrantKey } from "./breadthDepth";

export interface ShareRow {
  week_start: string;
  week_end: string;
  group_key: string;
  cum: number;
  mom: number;
  final: number;
}

export interface SovPosition {
  /** 최신 완결주 관심 점유율(%). 데이터 없으면 null. */
  share: number | null;
  /** 전주 대비 pp. 전주 데이터 없으면 null. */
  deltaPp: number | null;
  /** K-POP 버추얼 내 순위 (1 = 최대 점유). */
  rank: number | null;
  /** 순위 모수 — 최신 주에 점유율 행이 있는 K-POP 팀 수. */
  teamCount: number;
  /** 주차 오름차순 miiwan 점유율 시계열 (스파크라인용). */
  series: number[];
  /** 최신 주 momentum(최근 비중) − cumulative(누적 비중), pp.
      양수 = 최근 기세가 누적 위치보다 강함(점유 확대 국면). */
  momentumGap: number | null;
}

export function sovPosition(
  rows: ShareRow[] | undefined | null,
  kpopKeys: Set<string>,
  key = "miiwan",
): SovPosition {
  const empty: SovPosition = {
    share: null, deltaPp: null, rank: null, teamCount: 0,
    series: [], momentumGap: null,
  };
  if (!rows?.length) return empty;

  const weeks = [...new Set(rows.map((r) => r.week_end))].sort();
  const latest = weeks[weeks.length - 1];
  const prev = weeks.length >= 2 ? weeks[weeks.length - 2] : null;

  const latestRows = rows.filter((r) => r.week_end === latest && kpopKeys.has(r.group_key));
  const mine = latestRows.find((r) => r.group_key === key) ?? null;
  const prevMine = prev
    ? rows.find((r) => r.week_end === prev && r.group_key === key) ?? null
    : null;

  // 순위: 최신 주 final 내림차순. 동률은 같은 순위로 치지 않고 배열 위치
  // (near-tie 표기는 뷰 몫 — 여기선 결정적 순서만 보장).
  const ranked = [...latestRows].sort((a, b) => b.final - a.final);
  const rankIdx = mine ? ranked.findIndex((r) => r.group_key === key) : -1;

  return {
    share: mine?.final ?? null,
    deltaPp: mine && prevMine ? mine.final - prevMine.final : null,
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    teamCount: latestRows.length,
    series: weeks.map((w) =>
      rows.find((r) => r.week_end === w && r.group_key === key)?.final ?? 0),
    momentumGap: mine ? mine.mom - mine.cum : null,
  };
}

/** momentumGap → 방향 문구. 0.5pp 미만 차이는 "비슷한 페이스"로 —
    주간 노이즈를 방향 신호로 읽지 않게 하는 보수적 임계. */
export function momentumLine(gap: number | null): string | null {
  if (gap == null) return null;
  if (gap > 0.5) return "최근 기세가 누적 위치보다 강함 — 점유 확대 국면";
  if (gap < -0.5) return "최근 기세가 누적 위치보다 약함 — 점유 방어 국면";
  return "누적 위치와 비슷한 페이스 유지";
}

/** 사분면 → MiiWAN 관점 판정 문구 틀. 분류 자체는 breadthDepth의
    중앙값 십자선(데이터 파생)이 정한다. */
export const QUADRANT_VERDICT: Record<QuadrantKey, string> = {
  strong:    "인지도·코어 팬 밀도 모두 K-POP 버추얼 중앙값 위 — 진성 강세 위치.",
  niche:     "인지도는 중앙값 아래지만 코어 팬은 위 — 좁지만 깊은 팬덤. 다음 과제는 인지 확장.",
  ad_driven: "인지도는 중앙값 위지만 코어 팬 밀도가 아래 — 도달 대비 헌신이 얕은 위치.",
  low:       "인지도·코어 팬 모두 중앙값 아래 — 둘 다 축적 단계.",
};

/** growth_trajectory pillar 키 → 화면 라벨. */
export const PILLAR_LABEL: Record<string, string> = {
  reach:      "도달",
  engagement: "참여",
  community:  "커뮤니티",
  sentiment:  "여론",
};

// ── 연령×성별 시청 분포 (agg_youtube_analytics_demographics) ──────────
// viewer_pct 는 0~100. YouTube API 라벨("age18-24", "male"/"female"/
// "user_specified")을 화면용으로 정규화한다.

export interface DemographicRow {
  age_group: string;
  gender: string;
  viewer_pct: number | null;
}

export interface AgeBar {
  /** "13-17" · "65+" 등 표시용 라벨. */
  age: string;
  male: number;
  female: number;
  other: number;
  total: number;
}

/** "age18-24" → "18-24", "age65-" → "65+". 미지 형식은 원문 유지. */
export function ageLabel(raw: string): string {
  const m = /^age(\d+)-(\d*)$/.exec(raw);
  if (!m) return raw;
  return m[2] ? `${m[1]}-${m[2]}` : `${m[1]}+`;
}

/** 연령 버킷별 남/여/기타 시청 비중. 합계 0인 버킷은 제외, 연령 오름차순. */
export function demographicBars(rows: DemographicRow[] | null | undefined): AgeBar[] {
  if (!rows?.length) return [];
  const byAge = new Map<string, AgeBar>();
  for (const r of rows) {
    const pct = r.viewer_pct ?? 0;
    if (pct <= 0) continue;
    const bar = byAge.get(r.age_group)
      ?? { age: ageLabel(r.age_group), male: 0, female: 0, other: 0, total: 0 };
    if (r.gender === "male") bar.male += pct;
    else if (r.gender === "female") bar.female += pct;
    else bar.other += pct;
    bar.total += pct;
    byAge.set(r.age_group, bar);
  }
  return [...byAge.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, bar]) => bar);
}

/** 최대 단일 연령×성별 셀 → "여성 18-24 (32%)" 헤드라인. 데이터 없으면 null. */
export function topDemographicLine(rows: DemographicRow[] | null | undefined): string | null {
  if (!rows?.length) return null;
  const GENDER_KR: Record<string, string> = {
    male: "남성", female: "여성", user_specified: "기타",
  };
  const top = [...rows]
    .filter((r) => (r.viewer_pct ?? 0) > 0)
    .sort((a, b) => (b.viewer_pct ?? 0) - (a.viewer_pct ?? 0))[0];
  if (!top) return null;
  return `${GENDER_KR[top.gender] ?? top.gender} ${ageLabel(top.age_group)}`
    + ` (${Math.round(top.viewer_pct ?? 0)}%)`;
}

/** 국가 배열 → "KR 62% · JP 14% · US 8%" 상위 N 요약. watch_share는 0~1. */
export function topCountriesLine(
  countries: Array<{ country: string; watch_share: number }> | null | undefined,
  n = 3,
): string | null {
  if (!countries?.length) return null;
  const top = [...countries]
    .filter((c) => c.watch_share != null)
    .sort((a, b) => b.watch_share - a.watch_share)
    .slice(0, n);
  if (!top.length) return null;
  return top
    .map((c) => `${c.country} ${Math.round(c.watch_share * 100)}%`)
    .join(" · ");
}
