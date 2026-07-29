// "성장의 질" 산점도의 순수 계산부 — 동시기 성과(MiiWANCohortReport)에서
// 성장 속도(x)와 자연 유입 점수(y)를 한 화면에 겹쳐 본다.
//
// 왜 필요한가: 성장곡선은 출발선이 작은 팀을 압승처럼 그린다. 표의 배지는
// 이미 본 뒤에야 읽히고, 첫인상은 곡선이 만든다. 두 축을 같이 놓으면
// "빠르게 컸다"와 "광고 없이 컸다"가 분리돼, 배수 하나로 서열을 만드는
// 읽기를 구조적으로 막는다.
//
// 규칙: 값이 없는 팀은 점을 만들지 않되 화면에서 지우지도 않는다 —
// excluded 로 사유와 함께 내보내 캡션이 밝힌다(가짜 수치 없음 · 열세 숨김
// 금지와 같은 원칙). 테스트: tests/lib/cohortQuality.test.ts
import {
  ORG_AD_SUSPECT_THRESHOLD, adScoreMap, fmtMultiple, type CohortData,
} from "./cohortHeadline";
// F4 — "기준선 위 = 광고 과다 없음" 서술이 organic(70) 등급과도 일관되게
// 갈리는지 판단하려면 suspect(40) 뿐 아니라 organic(70) 컷도 필요하다.
import { VERDICT_THRESHOLDS } from "./organicity";

/** 산점도 x축이 쓰는 지표. 규모 축(원 크기)도 같은 지표의 절대값을 쓴다. */
export const QUALITY_METRIC = "yt_subscribers";

// 원 반경(px). 최소 반경을 보장하는 이유 — 규모가 작은 팀의 점이 사라지면
// "데이터가 없는 팀"과 구분되지 않는다. 0 이 아니라 작게 보여야 한다.
export const MIN_RADIUS = 6;
export const MAX_RADIUS = 22;

export interface QualityPoint {
  group_key: string;
  name: string;
  /** x — 데뷔 전 앵커 대비 총 성장배수. */
  growth: number;
  /** x 값의 분모를 잰 경과일 (음수 = 데뷔 전, 0 = 데뷔일 폴백). */
  anchorDay: number;
  /** y — 자연 유입 점수(0~100). */
  organic: number;
  /** 원 크기의 근거가 된 D+N 시점 절대값(구독자). */
  scale: number;
  /** sqrt 스케일 반경 — 넓이가 규모에 비례하도록. */
  radius: number;
  /** 참조선(PLAVE) 여부 — 순위·중앙값 모수에서 빠지고 hollow 로 그린다. */
  reference: boolean;
  /** 자연 유입 점수가 광고 의심 임계 미만인지. */
  adSuspect: boolean;
}

export interface QualityExclusion {
  group_key: string;
  name: string;
  /** 화면에 그대로 쓰는 평이한 사유. */
  reason: string;
}

export interface QualityScatter {
  points: QualityPoint[];
  excluded: QualityExclusion[];
  /** x 가이드라인 — 참조 그룹을 뺀 점들의 성장배수 중앙값. 점이 없으면 null. */
  medianGrowth: number | null;
  /** y 가이드라인 — 광고 의심 임계(공유 상수). */
  threshold: number;
  /** y축 표시 범위. 0~100 고정이면 점이 한 덩어리로 뭉쳐 변별이 안 된다. */
  yRange: { min: number; max: number };
}

/** y축 데이터 범위 양쪽에 두는 여유(점수). 점이 축선에 붙지 않게 한다. */
export const Y_AXIS_PADDING = 8;

/**
 * y축 범위를 데이터에 맞춘다. 0~100 고정이면 전 팀이 60~80에 몰렸을 때
 * 세로 차이가 눈에 안 보여 "다 비슷하다"로 읽힌다.
 * 단 **임계선은 항상 화면 안에 있어야 한다** — 기준선이 잘린 산점도는
 * 위/아래 판정을 그림만으로 확인할 수 없다. 0~100 밖으로도 나가지 않는다.
 */
export function yRangeFor(scores: number[], threshold: number): { min: number; max: number } {
  if (!scores.length) return { min: 0, max: 100 };
  const lo = Math.min(...scores, threshold) - Y_AXIS_PADDING;
  const hi = Math.max(...scores, threshold) + Y_AXIS_PADDING;
  return { min: Math.max(0, lo), max: Math.min(100, hi) };
}

/** 짝수 개면 가운데 두 값의 평균. 빈 배열은 null. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * 규모 → 반경. 넓이(∝ r²)가 규모에 비례하도록 sqrt 스케일을 쓰고,
 * 가장 큰 팀을 MAX_RADIUS 로 정규화한다. 규모가 0 이하이거나 최대값이
 * 0 이면(전원 0) 최소 반경으로 떨어뜨린다 — 점 자체는 남겨야 한다.
 */
export function radiusFor(scale: number, maxScale: number): number {
  if (!(maxScale > 0) || !(scale > 0)) return MIN_RADIUS;
  const ratio = Math.min(1, Math.sqrt(scale / maxScale));
  return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * ratio;
}

/**
 * 산점도 데이터 준비. 성장배수와 자연 유입 점수가 **둘 다** 있는 팀만
 * 점으로 만들고, 하나라도 없으면 사유를 붙여 excluded 로 보낸다.
 */
export function buildQualityScatter(d: CohortData): QualityScatter {
  const sc = d.scorecard[QUALITY_METRIC];
  // y축·판정 모두 편수·조회수 중 낮은 쪽(B1) — 표의 배지·곡선의 흐린 선과
  // 같은 숫자를 써야 세 화면이 같은 팀을 같은 이유로 가리킨다.
  const orgScore = adScoreMap(d);
  const excluded: QualityExclusion[] = [];
  const draft: Array<Omit<QualityPoint, "radius">> = [];

  for (const r of sc?.rows ?? []) {
    const name = d.groups[r.group_key]?.name ?? r.group_key;
    // 데뷔 전 앵커(D-30 우선) → D+N 총 성장배수. growth_multiple(데뷔 후만)이
    // 아니라 total_multiple을 쓴다 — 데뷔 전 구간의 성장을 잘라내지 않기 위해서다.
    const growth = r.total_multiple;
    const organic = orgScore.get(r.group_key) ?? null;
    if (growth == null || organic == null) {
      // F2 — growth(총 성장배수) 가 null 인 원인은 둘로 갈린다: ① D+N 시점
      // 값(value_at_day) 자체가 아직 없음 ② 앵커(데뷔 전 값)·데뷔일 값이
      // 없어 분모를 못 냄. r.value_at_day 는 total_multiple 이 쓰는 분자와
      // 같은 값(백엔드 totalMultiple() 의 `at`)이라, 이게 null 이면 무조건
      // ①이다 — 표엔 데뷔 전 값·출발선이 멀쩡히 있는데도(bthd 케이스) 예전
      // 문구("데뷔 전·데뷔일 값이 없어…")를 그대로 쓰면 표와 모순됐다.
      // 사유를 뭉뚱그리지 않는다 — 운영 대응이 다르다(수집 백필 vs 영상 판정).
      const reason = growth == null && organic == null
        ? "성장배수·자연 유입 점수 모두 없음"
        : growth == null
          ? r.value_at_day == null
            ? `D+${d.as_of_day} 시점 값이 아직 없어 성장배수를 낼 수 없음`
            : "데뷔 전·데뷔일 값이 없어 성장배수를 낼 수 없음"
          : "판정된 데뷔 초기 영상이 없어 자연 유입 점수가 없음";
      excluded.push({ group_key: r.group_key, name, reason });
      continue;
    }
    draft.push({
      group_key: r.group_key,
      name,
      growth,
      // 앵커가 없으면(백엔드 폴백 누락) 데뷔일(0)로 본다 — total_anchor_day가
      // null이어도 화면에서 "앵커 불명"으로 새지 않게 한다.
      anchorDay: r.total_anchor_day ?? 0,
      organic,
      scale: r.value_at_day ?? 0,
      reference: r.reference,
      adSuspect: organic < ORG_AD_SUSPECT_THRESHOLD,
    });
  }

  const maxScale = draft.reduce((m, p) => Math.max(m, p.scale), 0);
  const points: QualityPoint[] = draft.map((p) => ({
    ...p, radius: radiusFor(p.scale, maxScale),
  }));
  return {
    points,
    excluded,
    // 중앙값은 참조선(체급이 다른 PLAVE)을 빼고 낸다 — 표·순위와 같은 규칙.
    medianGrowth: median(points.filter((p) => !p.reference).map((p) => p.growth)),
    threshold: ORG_AD_SUSPECT_THRESHOLD,
    // 참조(PLAVE) 점도 화면에 그려지므로 범위 계산에 포함한다 — 빼면 그 점만
    // 축 밖으로 잘려 "참조는 표시한다"는 약속이 깨진다.
    yRange: yRangeFor(points.map((p) => p.organic), ORG_AD_SUSPECT_THRESHOLD),
  };
}

/** 임계선에서 이 점수 안쪽이면 "판정이 갈릴 수 있는 자리"로 본다. */
export const THRESHOLD_NEAR_BAND = 10;

/**
 * M1 — 데뷔 전 앵커 탐색 폭(±7일). functions/lib/cohortReport.ts 의
 * PRE_BASE_WINDOW 미러 — 프런트 번들에 서버 코드(functions/lib)를 끌어오지
 * 않으려고 상수만 복제했다. 값 자체의 재보정(드리프트)은 손으로 못 잡으니
 * tests/lib/cohortQuality.test.ts 가 두 값을 직접 비교해 지킨다
 * (organicity.ts 헤더가 경고하는 hand-copy desync 방지와 같은 이유).
 */
export const PRE_BASE_WINDOW = 7;

/**
 * 총 성장배수의 분모(앵커)가 "데뷔 D-preDebutDays±PRE_BASE_WINDOW" 정찰
 * 창 밖에서 잡혔는지. 창 밖이면(느슨한 앵커) 그 날짜가 우리가 광고하는
 * "약 30일 전"과 다르다는 뜻이라 공시해야 한다 — 데뷔일(0) 폴백도 항상
 * 느슨한 앵커로 본다. 백엔드 preAnchor() 는 창이 비면 "확보된 가장 이른
 * 값"으로 물러나는데, 그 값이 창보다 더 이전(대칭 반대쪽)이면 오히려
 * 보수적인 방향(실제 관찰 기간이 광고보다 김)이라 굳이 공시하지 않는다.
 */
export function isLooseAnchor(anchorDay: number, preDebutDays: number): boolean {
  return anchorDay > -(preDebutDays - PRE_BASE_WINDOW);
}

/**
 * R5 — 산점도에서 자사 위치를 문장으로 자동 서술한다. 사분면 그림만 두면
 * 읽는 사람마다 다른 결론을 가져가고, 가장 흔한 오독이 "왼쪽 = 뒤처짐"이다.
 * 왼쪽인 이유(출발선)와 임계선 부근의 불확실성을 같이 말해 둔다.
 * 좌표·임계 근접 판단은 전부 데이터에서 — 결론을 손으로 적지 않는다.
 */
export function scatterNote(s: QualityScatter): string | null {
  const mine = s.points.find((p) => p.group_key === "miiwan");
  if (!mine) return null;
  const parts: string[] = [];

  // 성장 배수의 분모(앵커) 시점을 항상 밝힌다 — "데뷔 30일 전 값 대비"가
  // 기본 전제지만, 데뷔 전 측정이 없는 팀(myrakl류)은 데뷔일로 폴백해
  // 전제 자체가 달라지므로 그 사실도 문장에 그대로 싣는다.
  const anchorLabel = mine.anchorDay < 0
    ? `데뷔 ${-mine.anchorDay}일 전 값 대비` : "데뷔일 값 대비(데뷔 전 측정 없음)";

  if (s.medianGrowth != null) {
    // F5 — 이 축의 분모는 표의 '출발선(데뷔일 값)' 컬럼이 아니라 데뷔 전
    // 앵커(기본 데뷔 30일 전 값, 없으면 데뷔일로 폴백)다. "출발선"이라고만
    // 쓰면 표의 다른 컬럼을 가리키는 것으로 오독된다.
    parts.push(mine.growth < s.medianGrowth
      ? `MiiWAN은 중앙값(${fmtMultiple(s.medianGrowth)}) 왼쪽 — 성장 속도(${anchorLabel})는`
        + " 가운데보다 느리다. 데뷔 전 출발선(약 30일 전 값)이 큰 팀은 배수가 작아"
        + " 구조적으로 왼쪽에 놓인다."
      // F6 — 캐비앗을 왼쪽 분기에만 달면 미완이 오른쪽일 때(작은 앵커 효과로
      // 배수가 부풀 수 있음)는 그 구조적 이유가 사라져 유리하게만 읽힌다.
      : `MiiWAN은 중앙값(${fmtMultiple(s.medianGrowth)}) 오른쪽 — 성장 속도(${anchorLabel})는`
        + " 가운데보다 빠르다. 반대로 데뷔 전 출발선이 작은 팀은 같은 성장이라도"
        + " 배수가 크게 나온다.");
  }

  // F4 — 기준선은 이제 광고 '과다' 컷(suspect)이지 organic 컷이 아니다.
  // 위쪽이라고 "광고 없이 컸다"고 말하면 organic(70) 미만인 위쪽 점(예:
  // 40~69점)까지 자연 유입 우세처럼 읽혀 막대 캡션("70점부터 우세")과
  // 모순된다. 위쪽은 "과다 사용 정황이 없다"까지만 말하고, organic 에는
  // 못 미치면 그 뉘앙스를 덧붙인다(H4 회색 지대와 같은 경계).
  const gap = mine.organic - s.threshold;
  if (Math.abs(gap) <= THRESHOLD_NEAR_BAND) {
    parts.push(`자연 유입 점수 ${mine.organic}점은 광고 과다 기준선(${s.threshold}점)`
      + " 부근이라 조금만 움직여도 판정이 갈릴 수 있다.");
  } else if (gap > 0) {
    const shortOfOrganic = mine.organic < VERDICT_THRESHOLDS.organic
      ? ` (다만 자연 유입 우세 기준 ${VERDICT_THRESHOLDS.organic}점에는 못 미친다)`
      : "";
    parts.push(`자연 유입 점수 ${mine.organic}점으로 광고 과다 기준선(${s.threshold}점) 위`
      + ` — 광고 과다 사용 정황은 없는 쪽이다${shortOfOrganic}.`);
  } else {
    parts.push(`자연 유입 점수 ${mine.organic}점으로 광고 과다 기준선(${s.threshold}점) 아래`
      + " — 광고 과다 사용 정황이 있는 쪽이다.");
  }

  // 원 크기(현재 팬 규모)는 속도와 다른 이야기다 — 느려도 규모는 클 수 있다.
  const peers = s.points.filter((p) => !p.reference);
  if (peers.length >= 2) {
    const scaleRank = peers.filter((p) => p.scale > mine.scale).length + 1;
    parts.push(`원 크기(현재 팬 규모)로는 ${peers.length}팀 중 ${scaleRank}위다.`);
  }
  return parts.join(" ");
}
