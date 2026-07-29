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
  ORG_AD_SUSPECT_THRESHOLD, THRESHOLD_NEAR_BAND, adScoreMap, fmtMultiple,
  type CohortData, type SectionVerdict,
} from "./cohortHeadline";

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
  /**
   * B1(07-30 투자 리뷰) — x축 총 성장 배수의 두 구간(데뷔 전 × 데뷔 후).
   * 총 배수만 보면 "15배 성장"이 전부 데뷔 후에 일어난 것으로 읽힌다.
   * 실제로는 곱이라, 분해 없이는 데뷔 전에 쌓은 몫과 데뷔 후에 만든 몫을
   * 구분할 수 없다. 값이 없으면 null — verdict 가 그 절을 통째로 생략한다.
   */
  preMultiple: number | null;
  postMultiple: number | null;
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
      // 총 배수의 분해 — 계산은 백엔드 값을 그대로 싣기만 한다(여기서
      // pre×post 를 다시 곱해 total 을 만들지 않는다).
      // F2(07-30 R3 투자 리뷰) 주석 교정 — 예전엔 "세 값이 각자 다른 앵커에서
      // 나와 곱이 total 과 다를 수 있다"고 적어뒀는데, 실제 원인은 그게 아니라
      // **표시 반올림**이다: 세 값 모두 같은 앵커 계보에서 나오지만 화면은
      // 소수 1자리로 반올림해 찍으므로(fmtMultiple) 13.8 × 1.1 = 15.2 ≠ 15.0
      // 처럼 표시값끼리는 등식이 성립하지 않는다. 그래서 화면 문구도 곱셈
      // 등식으로 쓰지 않는다(qualityVerdict 참조).
      preMultiple: r.pre_multiple,
      postMultiple: r.growth_multiple,
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
 * 창 밖에서 잡혔는지. 창 밖이면(느슨한 앵커) 그 날짜가 우리가 화면에 적은
 * "약 {preDebutDays}일 전"과 다르다는 뜻이라 공시해야 한다 — 데뷔일(0)
 * 폴백도 항상 느슨한 앵커로 본다.
 *
 * B3(07-30 투자 리뷰) — 예전엔 데뷔일 쪽(창보다 늦은 앵커)만 공시하고,
 * 창보다 **더 이전**에서 잡힌 앵커는 "보수적인 방향이라"며 숨겼다. 그건
 * 우리 쪽에 유리한 방향을 숨긴 것이다: 앵커가 이를수록 분모가 작아져 총
 * 성장 배수는 **커진다**. 자기에게 유리한 이탈만 조용히 넘어가는 공시는
 * 투자 자료에서 가장 먼저 신뢰를 잃는다 — 양쪽 다 밝힌다.
 */
export function isLooseAnchor(anchorDay: number, preDebutDays: number): boolean {
  return anchorDay > -(preDebutDays - PRE_BASE_WINDOW)
    || anchorDay < -(preDebutDays + PRE_BASE_WINDOW);
}

/** 내림차순 1-based 순위. */
function rankDescOf(mine: number, others: number[]): number {
  return others.filter((v) => v > mine).length + 1;
}

/**
 * C2 — 총 성장 배수의 구조적 한계. 분모가 데뷔 전 앵커라 출발점이 작은 팀은
 * 같은 순증으로도 훨씬 큰 배수가 나온다(미완이 앵커는 2천 미만). 이건 순위가
 * 높든 낮든 항상 성립하는 **구조적 사실**이라 조건부로 붙일 성질이 아니다 —
 * 예전엔 weak 의 마지막 분기에 있어서 자연 유입 점수가 기준선 근처면(=실제
 * 상황) 영영 도달하지 못했고, "가장 빠르게 팬덤을 키웠다"만 캐비앗 없이
 * 나갔다. 그래서 good 문장에 상시 부착한다.
 */
export const MULTIPLE_CAVEAT =
  "총 성장 배수는 데뷔 전 출발점이 작을수록 크게 나온다 — 배수 순위를 그대로 실력 순위로 읽지 않는다.";

/**
 * R5 — 산점도의 MiiWAN 읽기 — 그림만으로는 "왼쪽=뒤처짐" 오독이 흔해(기존
 * scatterNote의 문제의식) 잘함/보완 두 줄로 나눠 자동 서술한다.
 * 결론을 손으로 적지 않는다 — 좌표·순위·임계 근접은 전부 데이터에서.
 * G4(R3b) — 여기에 sub(보조 한 줄)가 더해진다: 순위 **사실**은 good/weak 이,
 * 그 사실을 어떻게 읽을지(구간 분해·배수 캐비앗)는 sub 가 맡는다.
 */
export function qualityVerdict(s: QualityScatter): SectionVerdict {
  const mine = s.points.find((p) => p.group_key === "miiwan");
  if (!mine) return { good: null, weak: null };
  const peers = s.points.filter((p) => !p.reference);
  const others = peers.filter((p) => p !== mine);
  const growthRank = rankDescOf(mine.growth, others.map((p) => p.growth));
  const scaleRank = rankDescOf(mine.scale, others.map((p) => p.scale));
  // M4 — 순위 절은 비참조 비교 대상이 2팀 이상일 때만. 미완이 혼자 남으면
  // "1팀 중 1위 — 가장 빠르게 팬덤을 키웠다"가 되는데, 이건 자기 자신을 이긴
  // 것을 강점으로 파는 문장이다(헤드라인 결론·표 각주와 같은 가드).
  const ranked = peers.length >= 2;
  // B1 — 총 배수 옆에 구간 분해를 병기한다. "15.0×"만 있으면 데뷔 후에 15배가
  // 된 것으로 읽히는데, 실제 구성은 데뷔 전에 쌓은 몫 위에 데뷔 후 몫이 얹힌
  // 것이다 — 이 대비가 이 화면의 결론(출발선은 이미 컸고 데뷔 후가 과제)
  // 자체라 각주가 아니라 같은 블록에 있어야 한다. 한쪽이라도 없으면 생략한다.
  //
  // F2(07-30 R3 투자 리뷰) — 예전 표기는 `15.0×(데뷔 전 13.8× × 데뷔 후 1.1×)`
  // 였다. 두 가지가 깨졌다: ⓐ 화면 값은 소수 1자리 반올림이라 13.8 × 1.1 =
  // 15.2 ≠ 15.0 — 괄호가 곱셈 등식으로 읽히는 순간 화면이 스스로 틀린 산수를
  // 보여주는 꼴이 된다. ⓑ 배수의 `×`와 곱셈의 `×`가 붙어(`× ×`) 글리프가
  // 겹쳐 읽혔다. 등식을 주장하지 않는 서술문으로 바꾼다 — 분해 사실은 남고,
  // 반올림 오차를 검증하라는 요구는 사라진다.
  //
  // G4(07-30 R3b 타이포 리뷰) — 분해와 캐비앗을 good 에 이어 붙이니 결론 줄이
  // 네 문장이 됐다. 둘은 순위 사실(good)이 아니라 **그 사실을 어떻게 읽을지**를
  // 말하는 같은 성격의 절이라, 상세표가 쓰는 sub(보조 위계)로 함께 내린다.
  // 문장은 하나도 지우지 않는다 — 캐비앗 상시 부착(C2)도 그대로다.
  const split = mine.preMultiple != null && mine.postMultiple != null
    ? `데뷔 전 ${fmtMultiple(mine.preMultiple)}를 쌓은 위에`
      + ` 데뷔 후 ${fmtMultiple(mine.postMultiple)}가 얹힌 값이다. `
    : "";
  const good = `총 성장 배수 ${fmtMultiple(mine.growth)}`
    + (ranked ? `로 ${peers.length}팀 중 ${growthRank}위` : "")
    + (ranked && growthRank === 1 ? " — 데뷔 전 준비 기간부터 지금까지 가장 빠르게 팬덤을 키웠다" : "")
    + "."
    + (ranked ? ` 원 크기(현재 팬 규모)로는 ${scaleRank}위다.` : "");
  // 배수 캐비앗은 순위 방향과 무관하게 항상 — 위 C2 주석 참조. good 이 있으면
  // sub 도 반드시 있다(캐비앗이 상수라) — 고아 sub 경로가 생기지 않는다.
  const sub = `${split}${MULTIPLE_CAVEAT}`;
  const gap = mine.organic - s.threshold;
  let weak: string | null;
  if (gap < 0) {
    weak = `자연 유입 점수 ${mine.organic}점은 광고 과다 기준선(${s.threshold}점) 아래다.`;
  } else if (gap <= THRESHOLD_NEAR_BAND) {
    weak = `자연 유입 점수 ${mine.organic}점은 광고 과다 기준선(${s.threshold}점) 부근이라`
      + " 광고 영향이 없다고 확정하기 어렵다.";
  } else {
    weak = null;
  }
  return { good, weak, sub };
}
