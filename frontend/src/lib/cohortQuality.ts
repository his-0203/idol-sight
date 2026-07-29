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
import { ORG_AD_SUSPECT_THRESHOLD, type CohortData } from "./cohortHeadline";

/** 산점도 x축이 쓰는 지표. 규모 축(원 크기)도 같은 지표의 절대값을 쓴다. */
export const QUALITY_METRIC = "yt_subscribers";

// 원 반경(px). 최소 반경을 보장하는 이유 — 규모가 작은 팀의 점이 사라지면
// "데이터가 없는 팀"과 구분되지 않는다. 0 이 아니라 작게 보여야 한다.
export const MIN_RADIUS = 6;
export const MAX_RADIUS = 22;

export interface QualityPoint {
  group_key: string;
  name: string;
  /** x — 데뷔일 대비 성장배수. */
  growth: number;
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
  const orgScore = new Map(
    d.organicity.filter((o) => o.score != null).map((o) => [o.group_key, o.score!]),
  );
  const excluded: QualityExclusion[] = [];
  const draft: Array<Omit<QualityPoint, "radius">> = [];

  for (const r of sc?.rows ?? []) {
    const name = d.groups[r.group_key]?.name ?? r.group_key;
    const growth = r.growth_multiple;
    const organic = orgScore.get(r.group_key) ?? null;
    if (growth == null || organic == null) {
      // 사유를 뭉뚱그리지 않는다 — 운영 대응이 다르다(수집 백필 vs 영상 판정).
      const reason = growth == null && organic == null
        ? "성장배수·자연 유입 점수 모두 없음"
        : growth == null
          ? "데뷔일 시점 값이 없어 성장배수를 낼 수 없음"
          : "판정된 데뷔 초기 영상이 없어 자연 유입 점수가 없음";
      excluded.push({ group_key: r.group_key, name, reason });
      continue;
    }
    draft.push({
      group_key: r.group_key,
      name,
      growth,
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
  };
}
