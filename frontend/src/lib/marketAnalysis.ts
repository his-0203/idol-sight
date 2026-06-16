// frontend/src/lib/marketAnalysis.ts
//
// MiiWAN 시장 분석 엔진 — 국가별 분석 데이터를 "왜/무엇을/얼마나 믿을지"로
// 변환하는 순수 로직. 4개 설계 에이전트(데이터IA·시장해석·마케팅액션·시각화)
// 합의를 코드화.
//
// 핵심 철학:
//   - 숫자(검증가능) / 해석(반박가능) / 외부맥락(플래그) 를 분리한다.
//     규칙엔진·메타·경고는 점수를 절대 변형하지 않고 그 위에 얹는다.
//   - 표본 부족은 숨기지 말고 분리한다 (insufficient → 결정영역 제외, 보류함).
//   - 액션은 '커밋'이 아니라 '가장 싼 테스트' (L0~L4 사다리, 임계 미달 시 강등).
//
// 모든 정규화는 "현재 50개국 모집단(population)" 기준 백분위/min-max 라
// 데뷔 초기 분포 출렁임에 강건하다.

import {
  scoreExpansion, phaseOf, PHASE_WEIGHTS,
  type ExpansionTier, type Phase,
} from "./decisionSupport";

export interface CountryRow {
  country: string;
  watchShare: number;   // 0..1
  growthMoM: number;    // 소수
  retentionRel: number; // 국내(KR) 대비, 1.0 = 동등
  subPer1k: number;
  watchMinutes?: number | null; // 절대 시청시간(분) — 표본 게이트(#1)
  organicShare?: number | null; // 오가닉(검색+추천) 트래픽 비중(#3)
  subsGained?: number | null;   // 기간 내 구독 증가 — 도넛(지역별 구독 유입)
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

// ─── 정규화 헬퍼 ─────────────────────────────────────────────────────
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp01(p) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** 모집단 대비 백분위 순위 (0..1). 동률은 ≤ 기준. */
export function pctRank(value: number, population: number[]): number {
  if (population.length === 0) return 0.5;
  const below = population.filter((v) => v <= value).length;
  return below / population.length;
}

/** 윈저라이즈 min-max 정규화 (P5~P95). 극단치에 강건. */
export function winsorNorm(value: number, population: number[]): number {
  if (population.length === 0) return 0.5;
  const lo = percentile(population, 0.05);
  const hi = percentile(population, 0.95);
  if (hi <= lo) return 0.5;
  return clamp01((value - lo) / (hi - lo));
}

// ─── 0. 축 양자화 + 표본 게이트 ──────────────────────────────────────
export type Level = "high" | "mid" | "low";
export interface Levels { watch: Level; growth: Level; retention: Level; sub: Level }

// 표본 부족 임계. 절대 시청시간(#1)이 있으면 그걸 우선 — "점유 8%"가
// 1만분인지 10만분인지로 진출 의미가 완전히 다르다. 없으면 점유로 폴백.
export const MIN_SAMPLE_SHARE = 0.005;
export const MIN_SAMPLE_MINUTES = 2000;
export function isInsufficient(row: CountryRow): boolean {
  if (row.watchMinutes != null) return row.watchMinutes < MIN_SAMPLE_MINUTES;
  return row.watchShare < MIN_SAMPLE_SHARE;
}

// #2 성장 베이지안 수축 — 표본(시청시간) 적은 국가의 growth 를 0 쪽으로 당겨
// "prior≈0 → 폭발" 노이즈를 구조적으로 누른다. 절대 분 데이터 없으면 원값.
export function shrinkGrowth(row: CountryRow, pop: CountryRow[]): number {
  if (row.watchMinutes == null) return row.growthMoM;
  const ms = pop.map((r) => r.watchMinutes).filter((m): m is number => m != null);
  if (ms.length === 0) return row.growthMoM;
  const k = Math.max(1, percentile(ms, 0.25)); // 하위 표본일수록 강하게 수축
  return row.growthMoM * (row.watchMinutes / (row.watchMinutes + k));
}

export function quantize(row: CountryRow, pop: CountryRow[]): Levels {
  const shares = pop.map((r) => r.watchShare);
  const subs = pop.map((r) => r.subPer1k);
  const lvl = (v: number, hi: number, lo: number): Level =>
    v >= hi ? "high" : v <= lo ? "low" : "mid";
  return {
    // watch_share high = 규모 있는 시장. ≥10%(절대) 또는 상위25%이되 최소 2%는
    // 넘어야 함 — 데뷔 초기 점유가 잘게 쪼개지면 상위25%가 2%대로 내려가
    // 작은 시장이 'high(규모 있음)'로 오분류돼 R8 자막예산을 오배정하던 문제 방어.
    watch: (row.watchShare >= 0.10
      || (row.watchShare >= percentile(shares, 0.75) && row.watchShare >= 0.02))
      ? "high" : row.watchShare < MIN_SAMPLE_SHARE ? "low" : "mid",
    // growth: +30% 이상 high, +5% 이하(정체·하락) low.
    growth: lvl(row.growthMoM, 0.30, 0.05),
    // retention: 0.85 미만이 언어장벽 분기, 0.95 이상 국내급.
    retention: row.retentionRel >= 0.95 ? "high"
      : row.retentionRel < 0.85 ? "low" : "mid",
    sub: lvl(row.subPer1k, percentile(subs, 0.75), percentile(subs, 0.25)),
  };
}

// ─── 1. 규칙 엔진 (R1~R10) — '왜' 자동 서술 ──────────────────────────
export interface Interpretation {
  ruleId: string; label: string; narrative: string; action: string;
}

// 성장률 표시 포맷터 — 데뷔 초기엔 직전 30일 분모가 ≈0이라 +228996% 같은
// 무의미한 폭발값이 나온다. ±한계로 캡해 화면이 거짓 신호를 안 주게 한다.
// (점수/수축은 별도로 처리됨 — 이건 순수 표시용.)
export const fmtGrowthPct = (x: number): string => {
  if (x > 3) return ">+300%";
  if (x < -1) return "-100%";
  return `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
};
const pct = fmtGrowthPct;
const x2 = (x: number) => `${x.toFixed(2)}×`;

export function interpretCountry(
  row: CountryRow, pop: CountryRow[], displayGrowth?: number,
): Interpretation {
  const L = quantize(row, pop);
  const c = row.country;
  const subs = pop.map((r) => r.subPer1k);
  // 전환이 강한 편 = 중앙값 이상 (R3/R5 판정용).
  const subHigh = row.subPer1k >= percentile(subs, 0.5);
  // 분류(quantize)는 row(수축 성장)로 — tier/액션과 정합. 서술의 성장% 표시만
  // 원값(displayGrowth)으로 — 드라이버 막대의 성장%와 같은 숫자가 보이게.
  const gpct = (x: number) => pct(displayGrowth ?? x);

  // 위에서부터 평가, 첫 매칭 채택 (우선순위 = 신뢰도·규모·시급성).
  if (isInsufficient(row))
    return { ruleId: "R1", label: "🔬 소표본",
      narrative: `${c}는 시청 비중 ${(row.watchShare * 100).toFixed(1)}%로 표본이 얇아 지표가 출렁입니다. 추세 판단은 보류, 모니터링 대상으로만 둡니다.`,
      action: "관찰만 — 액션 보류" };

  if (L.watch === "high" && L.retention === "low" && L.growth === "high")
    return { ruleId: "R8", label: "⚠️ 큰데 안 봄",
      narrative: `${c}는 비중도 크고(${(row.watchShare * 100).toFixed(1)}%) 성장도 빠르나(${gpct(row.growthMoM)}) 완주율이 국내의 ${x2(row.retentionRel)}에 그칩니다. 규모 있는 언어장벽 = 자막 ROI 최대.`,
      action: "자막 풀-로컬라이즈 (1순위)" };

  if (L.growth === "high" && L.retention === "low")
    return { ruleId: "R2", label: "🚨 언어장벽 의심",
      narrative: `${c}는 유입이 폭발(${gpct(row.growthMoM)})하나 완주율이 ${x2(row.retentionRel)}입니다. 관심은 있는데 끝까지 안 봄 = 언어/자막 장벽 가설.`,
      action: "현지어 자막 A/B 테스트" };

  if (L.growth === "high" && L.retention === "high" && subHigh)
    return { ruleId: "R3", label: "🔥 핵심 확장",
      narrative: `${c}는 유입·완주·전환이 모두 강합니다(${gpct(row.growthMoM)}, ret ${x2(row.retentionRel)}). 저항 없는 성장 시장 — 예산 0순위.`,
      action: "광고·현지 활성화 집중" };

  if (L.watch === "high" && L.growth === "low" && L.retention === "high")
    return { ruleId: "R4", label: "🪨 성숙·정체",
      narrative: `${c}는 비중은 크나(${(row.watchShare * 100).toFixed(1)}%) 성장이 멈췄습니다(${gpct(row.growthMoM)}). 충성 코어는 견고 — 신규 유입보다 팬덤 심화로.`,
      action: "리텐션·커뮤니티 심화" };

  if (L.retention === "high" && subHigh && L.watch !== "high")
    return { ruleId: "R5", label: "💎 고품질 소형",
      narrative: `${c}는 작지만 보는 사람은 끝까지 보고 구독까지 합니다(ret ${x2(row.retentionRel)}). 숨은 고적합 시장 — 표본만 키우면 핵심 후보.`,
      action: "도달(노출) 확대 실험" };

  if (L.growth === "high" && L.retention === "mid" && L.sub === "low")
    return { ruleId: "R6", label: "📈 얕은 바이럴",
      narrative: `${c}는 조회는 늘지만(${gpct(row.growthMoM)}) 구독 전환이 약합니다. 알고리즘/쇼츠 바이럴 유입 가능성 — 휘발 위험, 코어 전환 장치 필요.`,
      action: "구독 유도 CTA·롱폼 연결" };

  // R6b — 고성장 + 중간 완주 + 전환 약하지 않음. 명백한 유망 시장인데 R10으로
  // 새던 빠짐(gap) 보강.
  if (L.growth === "high" && L.retention === "mid")
    return { ruleId: "R6b", label: "📈 성장 유망(검증)",
      narrative: `${c}는 빠르게 크고(${gpct(row.growthMoM)}) 완주·전환도 나쁘지 않습니다. 검증 가치 큰 후보 — 소액 테스트로 핵심 시장 승급 여부 확인.`,
      action: "유료 도달 소액 테스트" };

  if (L.retention === "low" && (L.growth === "mid" || L.growth === "low"))
    return { ruleId: "R7", label: "🧊 적합도 낮음",
      narrative: `${c}는 유입도 완주도 약합니다(ret ${x2(row.retentionRel)}, ${gpct(row.growthMoM)}). 콘텐츠-시장 적합도 미달 — 자원 투입 보류, 분기 재평가.`,
      action: "보류" };

  if (L.growth === "low" && (L.watch === "mid" || L.watch === "high"))
    return { ruleId: "R9", label: "📉 식는 시장",
      narrative: `${c}는 비중은 있으나 직전 대비 꺾였습니다(${gpct(row.growthMoM)}). 모멘텀 소실 — 원인(경쟁작·콘텐츠 공백) 점검, 컴백·이벤트로 재점화.`,
      action: "원인 진단 + 재점화" };

  return { ruleId: "R10", label: "⚪ 안정·평범",
    narrative: `${c}는 4축 모두 중간대로 특이 신호 없음. 현 전략 유지.`,
    action: "유지" };
}

// ─── 2. 국가 메타 + 컨텍스트 플래그 ──────────────────────────────────
export interface CountryMeta {
  market: "mature" | "growth" | "emerging";
  langGap: "low" | "mid" | "high";
  diasporaKr: "low" | "mid" | "high";
  platform: "yt_heavy" | "mixed";
  tzOverlap: "low" | "mid" | "high";
  /** 진입 용이성 0..1 (언어·결제·배송·규제 합성, 정책상수 — 운영 중 보정). */
  ease: number;
}

// 상위 K-pop 시장 정적 메타. 미등록국은 DEFAULT_META.
export const COUNTRY_META: Record<string, CountryMeta> = {
  KR: { market: "mature", langGap: "low",  diasporaKr: "low",  platform: "mixed",    tzOverlap: "high", ease: 1.0 },
  JP: { market: "mature", langGap: "low",  diasporaKr: "mid",  platform: "yt_heavy", tzOverlap: "high", ease: 0.75 },
  US: { market: "mature", langGap: "high", diasporaKr: "high", platform: "mixed",    tzOverlap: "low",  ease: 0.7 },
  ID: { market: "growth", langGap: "high", diasporaKr: "low",  platform: "yt_heavy", tzOverlap: "high", ease: 0.55 },
  TH: { market: "growth", langGap: "high", diasporaKr: "low",  platform: "yt_heavy", tzOverlap: "high", ease: 0.55 },
  VN: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "yt_heavy", tzOverlap: "high", ease: 0.5 },
  PH: { market: "growth", langGap: "low",  diasporaKr: "low",  platform: "yt_heavy", tzOverlap: "high", ease: 0.65 },
  TW: { market: "mature", langGap: "mid",  diasporaKr: "mid",  platform: "yt_heavy", tzOverlap: "high", ease: 0.7 },
  MY: { market: "growth", langGap: "mid",  diasporaKr: "low",  platform: "yt_heavy", tzOverlap: "high", ease: 0.6 },
  SG: { market: "mature", langGap: "low",  diasporaKr: "mid",  platform: "mixed",    tzOverlap: "high", ease: 0.75 },
  HK: { market: "mature", langGap: "mid",  diasporaKr: "mid",  platform: "yt_heavy", tzOverlap: "high", ease: 0.7 },
  MX: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "yt_heavy", tzOverlap: "low", ease: 0.45 },
  BR: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "yt_heavy", tzOverlap: "low", ease: 0.45 },
  AR: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "yt_heavy", tzOverlap: "low", ease: 0.4 },
  CL: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "yt_heavy", tzOverlap: "low", ease: 0.4 },
  GB: { market: "mature", langGap: "high", diasporaKr: "mid",  platform: "mixed",    tzOverlap: "mid",  ease: 0.65 },
  DE: { market: "emerging", langGap: "mid", diasporaKr: "low", platform: "mixed",    tzOverlap: "mid",  ease: 0.55 },
  FR: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "mixed",   tzOverlap: "mid",  ease: 0.5 },
  ES: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "mixed",   tzOverlap: "mid",  ease: 0.5 },
  IT: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "mixed",   tzOverlap: "mid",  ease: 0.5 },
  PL: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "yt_heavy", tzOverlap: "mid", ease: 0.45 },
  CA: { market: "mature", langGap: "high", diasporaKr: "high", platform: "mixed",    tzOverlap: "low",  ease: 0.65 },
  AU: { market: "mature", langGap: "high", diasporaKr: "mid",  platform: "mixed",    tzOverlap: "mid",  ease: 0.6 },
  IN: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "yt_heavy", tzOverlap: "high", ease: 0.4 },
  TR: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "yt_heavy", tzOverlap: "mid", ease: 0.4 },
  SA: { market: "emerging", langGap: "high", diasporaKr: "low", platform: "yt_heavy", tzOverlap: "mid", ease: 0.4 },
  AE: { market: "emerging", langGap: "high", diasporaKr: "mid", platform: "mixed",    tzOverlap: "mid", ease: 0.45 },
};
export const DEFAULT_META: CountryMeta = {
  market: "emerging", langGap: "high", diasporaKr: "low",
  platform: "yt_heavy", tzOverlap: "mid", ease: 0.45,
};

// 도넛(지역별 분포)용 권역 매핑. 미등록국은 '기타'.
export const REGION_OF: Record<string, string> = {
  KR: "동아시아", JP: "동아시아", TW: "동아시아", HK: "동아시아", CN: "동아시아", MO: "동아시아",
  ID: "동남아", TH: "동남아", VN: "동남아", PH: "동남아", MY: "동남아", SG: "동남아",
  US: "북미", CA: "북미",
  MX: "중남미", BR: "중남미", AR: "중남미", CL: "중남미", CO: "중남미", PE: "중남미",
  GB: "유럽", DE: "유럽", FR: "유럽", ES: "유럽", IT: "유럽", PL: "유럽", NL: "유럽", TR: "유럽",
  AU: "오세아니아", NZ: "오세아니아",
  IN: "남아시아", SA: "중동", AE: "중동",
};
export const regionOf = (country: string): string => REGION_OF[country] ?? "기타";
export const metaOf = (country: string): CountryMeta =>
  COUNTRY_META[country] ?? DEFAULT_META;

// #3 진입 용이성을 이산 등급에서 결정론적으로 파생(가짜 정밀도 0.75 vs 0.7 제거)
// + #2 콘텐츠 진입 비용(언어·시차)으로 분해 — PRI 가 점수(성장·유지·전환·점유)와
// 안 겹치는 독립 축을 갖게 한다. 콘텐츠 단계(자막·광고) 의사결정용.
const LANG_EASE: Record<CountryMeta["langGap"], number> = { low: 0.9, mid: 0.6, high: 0.4 };
const TZ_EASE: Record<CountryMeta["tzOverlap"], number> = { high: 1.0, mid: 0.75, low: 0.55 };
export function easeContent(country: string): number {
  const m = metaOf(country);
  return 0.6 * LANG_EASE[m.langGap] + 0.4 * TZ_EASE[m.tzOverlap];
}

// 데이터 신호와 교차할 때만 점등 (메타 단독으로는 안 띄움). 최대 2개.
export function contextFlags(row: CountryRow, pop: CountryRow[]): string[] {
  const L = quantize(row, pop);
  const m = metaOf(row.country);
  const flags: { pri: number; text: string }[] = [];
  if (m.langGap === "high" && row.retentionRel < 0.85)
    flags.push({ pri: 1, text: "언어격차 큰 국가 + 낮은 완주율 = 자막 가설 강함." });
  if (m.langGap === "low" && row.retentionRel < 0.85)
    flags.push({ pri: 1, text: "언어격차 낮은데 완주율도 낮음 = 콘텐츠 적합도 문제(자막 아님)." });
  if (m.diasporaKr === "high" && L.retention === "high" && L.sub === "high")
    flags.push({ pri: 2, text: "교포 밀집 시장 — 높은 완주/전환이 현지 대중 확산을 과대평가시킬 수 있음." });
  if (m.market === "mature" && L.growth === "low")
    flags.push({ pri: 3, text: "성숙 시장이라 저성장이 정상 — 성장률 낮음을 실패로 읽지 말 것." });
  if (m.market === "emerging" && row.retentionRel < 0.80)
    flags.push({ pri: 3, text: "신흥 시장 초기 유입 — 낮은 완주율은 인지 단계 특성, 시기상조 판단 주의." });
  if (m.platform === "mixed" && L.watch === "low")
    flags.push({ pri: 4, text: "유튜브 외 채널 비중 큰 시장 — YT 비중 낮음이 곧 약세는 아님(과소평가 주의)." });
  if (m.platform === "yt_heavy" && L.growth === "high")
    flags.push({ pri: 4, text: "유튜브 중심 시장 — 본 지표가 시장 전체를 잘 대표(신뢰도 높음)." });
  if (m.tzOverlap === "low" && L.growth === "high")
    flags.push({ pri: 5, text: "한국과 시차 큰 시장 — 라이브 효과 제한적, VOD/쇼츠 중심 적합." });
  return flags.sort((a, b) => a.pri - b.pri).slice(0, 2).map((f) => f.text);
}

// ─── 3. VPN/교포 왜곡 경고 (W1~W3) — 점수 불변, 신뢰구간만 확대 ───────
export function distortionWarnings(row: CountryRow, pop: CountryRow[]): string[] {
  const m = metaOf(row.country);
  const subs = pop.map((r) => r.subPer1k);
  const out: string[] = [];
  if (m.diasporaKr === "high" && row.retentionRel >= 0.95 && m.langGap === "high")
    out.push("교포 과대대표 의심: 언어격차 큰데 완주율이 국내급 — 시청자가 한국어 가능 교포에 편중됐을 수 있음. '현지 대중 침투'로 읽으면 과대평가.");
  if (isInsufficient(row) && row.growthMoM >= 0.5 && row.subPer1k >= percentile(subs, 0.90))
    out.push("소표본 스파이크: 급증·고전환 동시 발생 — VPN 우회 또는 일시적 외부(언론·밈) 유입 의심. 2~3주 지속성 확인.");
  return out;
}

// ─── 4. 파생 지표 ────────────────────────────────────────────────────
export function momentum(row: CountryRow, pop: CountryRow[]): number {
  return winsorNorm(row.growthMoM, pop.map((r) => r.growthMoM));
}
export function quality(row: CountryRow, pop: CountryRow[]): number {
  const r = pctRank(row.retentionRel, pop.map((p) => p.retentionRel));
  const s = pctRank(row.subPer1k, pop.map((p) => p.subPer1k));
  return clamp01(0.6 * r + 0.4 * s);
}

// 비전문가용 등급 라벨 (tier 영문키 → 쉬운 한국어).
export const TIER_LABEL_KO: Record<ExpansionTier, string> = {
  candidate: "0순위", test: "검증중", watch: "지켜보기", insufficient: "데이터 부족",
};

export type Quadrant = "invest" | "nurture" | "watch" | "deprioritize";
export const QUADRANT_LABEL: Record<Quadrant, string> = {
  invest: "✅ 공략 1순위", nurture: "🔷 안정·육성",
  watch: "⚠️ 거품 의심", deprioritize: "⚪ 관망",
};
export function quadrant(row: CountryRow): Quadrant {
  const rising = row.growthMoM > 0;
  const sticky = row.retentionRel >= 1.0;
  if (rising && sticky) return "invest";
  if (!rising && sticky) return "nurture";
  if (rising && !sticky) return "watch";
  return "deprioritize";
}

export function hhi(rows: CountryRow[]): number {
  return rows.reduce((s, r) => s + r.watchShare * r.watchShare, 0);
}
export const hhiLabel = (h: number): string =>
  h > 0.25 ? "쏠림" : h >= 0.15 ? "보통" : "분산";
export function cr3(rows: CountryRow[]): number {
  return [...rows].sort((a, b) => b.watchShare - a.watchShare)
    .slice(0, 3).reduce((s, r) => s + r.watchShare, 0);
}

/** 자막 우선도 = 큰 시청 × 낮은 완주(언어장벽). retentionRel≥1 이면 0. */
export function subtitlePriority(row: CountryRow, pop: CountryRow[]): number {
  const gap = Math.max(0, 1 - row.retentionRel);
  return pctRank(row.watchShare, pop.map((r) => r.watchShare)) * gap;
}
/** 현지 PR 우선도 = 성장 × 전환 (점화 가능성). */
export function prPriority(row: CountryRow, pop: CountryRow[]): number {
  return momentum(row, pop) * pctRank(row.subPer1k, pop.map((r) => r.subPer1k));
}

// 팬덤 안착력 — '지속되는 팬층이 형성되기 좋은 환경'인가. 점수(유망함)·PRI(돈)와
// 다른 렌즈로, 깊이·헌신·자생성만 본다(성장세·크기 제외 — 그건 모멘텀/규모):
//   끝까지 보기(retention) + 구독 전환(sub) + 자연 유입(organic).
export type FandomFitLevel = "strong" | "ok" | "weak";
export interface FandomFit { level: FandomFitLevel; score: number }
export function fandomFit(row: CountryRow, pop: CountryRow[]): FandomFit {
  const ret = pctRank(row.retentionRel, pop.map((r) => r.retentionRel));
  const conv = pctRank(row.subPer1k, pop.map((r) => r.subPer1k));
  // organic 도 백분위로 — ret/conv(백분위)와 단위를 맞춘다. 절대값(0..1) 혼용
  // 시 organic 평균(~0.3)이 구조적으로 낮아, organic 있는 국가가 null(0.5)
  // 국가보다 부당하게 낮게 나오는 역인센티브가 생겼다. null 은 중앙=0.5 중립.
  const orgs = pop.map((r) => r.organicShare).filter((x): x is number => x != null);
  const org = row.organicShare != null && orgs.length > 0
    ? pctRank(row.organicShare, orgs) : 0.5;
  const score = 0.4 * ret + 0.35 * conv + 0.25 * org;
  const level: FandomFitLevel = score >= 0.6 ? "strong" : score >= 0.4 ? "ok" : "weak";
  return { level, score };
}
export const FANDOM_LABEL: Record<FandomFitLevel, string> = {
  strong: "🟢 좋음", ok: "🟡 보통", weak: "🔴 약함",
};

// ─── 5. PRI (노력 대비 기대수익) ─────────────────────────────────────
export function retentionGate(retentionRel: number): number {
  if (retentionRel < 0.5) return 0.3;
  if (retentionRel >= 0.7) return 1.0;
  return 0.3 + ((retentionRel - 0.5) / 0.2) * 0.7; // 0.5~0.7 선형
}
export function pri(row: CountryRow, pop: CountryRow[]): number {
  // floor 0.01 — 0 으로 PRI 전체가 죽는 것만 막고, 변별력은 보존한다.
  // (floor 0.05 는 0.05^0.2≈0.55 라 약점 인자도 큰 기여 → 순위가 뭉쳤음.)
  const reach = Math.max(0.01, pctRank(row.watchShare, pop.map((r) => r.watchShare)));
  const conv = Math.max(0.01, pctRank(row.subPer1k, pop.map((r) => r.subPer1k)));
  // 진입 용이성 = 언어·시차 파생(점수와 독립 축). ease 상수 대신 결정론적.
  const ease = Math.max(0.01, easeContent(row.country));
  const mom = Math.max(0.01, momentum(row, pop));
  const gate = retentionGate(row.retentionRel);
  return Math.pow(reach, 0.25) * Math.pow(conv, 0.30)
    * Math.pow(ease, 0.25) * Math.pow(mom, 0.20) * gate;
}

// ─── 6. 패턴 + L0~L4 액션 사다리 ─────────────────────────────────────
export interface PatternFlags { shallow: boolean; hiddenDemand: boolean; hotRising: boolean }
export function patternFlags(row: CountryRow, pop: CountryRow[]): PatternFlags {
  const L = quantize(row, pop);
  const subs = pop.map((r) => r.subPer1k);
  const growthHi = row.growthMoM >= percentile(pop.map((r) => r.growthMoM), 0.75);
  return {
    shallow: L.watch === "high" && row.retentionRel < 0.5,
    hiddenDemand: L.watch === "high" && row.subPer1k <= percentile(subs, 0.25),
    hotRising: growthHi && row.retentionRel >= 0.7,
  };
}

export type Rung = "L0" | "L1" | "L2" | "L3" | "L4";
export const RUNG_LABEL: Record<Rung, string> = {
  L0: "관찰", L1: "콘텐츠 검증(자막)", L2: "유료 도달 검증",
  L3: "현지 신뢰 구축", L4: "물리적 진출",
};
export function currentRung(tier: ExpansionTier, p: PatternFlags): Rung {
  if (tier === "insufficient") return "L0";
  if (p.shallow) return "L0";          // 확대 금지
  if (tier === "watch") return "L1";   // 자막만
  if (tier === "test") return p.hotRising ? "L2" : "L1";
  return "L2";                          // candidate
}

export interface ActionCard {
  trigger: string; verb: string; owner: string; due: string;
  measurable: string; costTier: Rung;
}
export function actionCard(row: CountryRow, tier: ExpansionTier, p: PatternFlags): ActionCard {
  const c = row.country;
  if (tier === "insufficient")
    return { trigger: "tier=insufficient", costTier: "L0",
      verb: `${c}에 어떤 액션도 배정하지 말고 표본 누적만 관찰하라`,
      owner: "데이터", due: "4주 후 tier 재계산",
      measurable: "표본 임계 도달해 tier 승격 시에만 카드 생성" };
  if (p.shallow)
    return { trigger: "watch_share 높음 & retention_rel < 0.5", costTier: "L0",
      verb: `${c}에 유료 예산 배정을 보류하고 L0 관찰만 유지하라`,
      owner: "그로스 운영", due: "상시·4주마다 재평가",
      measurable: "retention_rel ≥ 0.5 회복 시에만 큐 재진입 / 그 전엔 유료 0" };
  if (p.hiddenDemand || tier === "watch")
    return { trigger: "watch_share 상위 & sub_per_1k 하위(언어장벽 의심)", costTier: "L1",
      verb: `${c} 데뷔 상위 3개 영상에 현지어 자막을 추가하고 4주 AB 돌려라`,
      owner: "콘텐츠 로컬라이제이션 리드", due: "7일 내 착수, 4주 후 판정",
      measurable: "자막군 sub_per_1k 대조군 +25% 초과 → L2 승급 / 미달 → L0 강등" };
  if (p.hotRising)
    return { trigger: "growth 상위25% & retention_rel ≥ 0.7 & L1 통과", costTier: "L2",
      verb: `${c} 단일 지오타겟 페이드소셜을 예산 상한 캡으로 집행하라`,
      owner: "퍼포먼스 마케팅 리드", due: "14일 집행, 종료 후 D7 코호트 측정",
      measurable: "CAC ≤ 국내 1.5배 & 유입 D7 retention_rel ≥ 0.6 → L3 / 위반 → 정지" };
  return { trigger: "candidate tier", costTier: "L2",
    verb: `${c} 자막 AB로 1개월 관찰 후 유료 슬롯 승급 여부 판단하라`,
    owner: "그로스 PM", due: "1개월",
    measurable: "자막군 전환 개선 확인 시 L2 유료 슬롯 큐 진입" };
}

// ─── 7. enrich + 헤드라인 + 순차베팅 큐 ──────────────────────────────
export interface EnrichedCountry {
  row: CountryRow;
  score: number; tier: ExpansionTier; drivers: { growth: number; retention: number; sub: number; share: number };
  interpretation: Interpretation;
  flags: string[]; warnings: string[];
  momentum: number; quality: number; quadrant: Quadrant;
  pri: number; pattern: PatternFlags; rung: Rung; action: ActionCard;
  fandom: FandomFit;
  insufficient: boolean;
}

// #4 한 줄 결론 — 매력도/점수/팬덤안착/tier/사분면 5개 척도를 비전문가가 헷갈리지
// 않게, 국가별 '그래서 뭘 하라'를 한 문장으로. (나머지 척도는 '근거'로 강등.)
export type ConclusionTone = "go" | "test" | "watch" | "hold" | "home";
export interface Conclusion { text: string; tone: ConclusionTone }
export function conclusion(e: EnrichedCountry): Conclusion {
  if (e.row.country === "KR") return { text: "🏠 본진 — 진출 기준선(대상 아님)", tone: "home" };
  if (e.insufficient) return { text: "👀 데이터 더 모으기 — 아직 판단 일러", tone: "watch" };
  if (e.pattern.shallow) return { text: "🛑 보류 — 잠깐 떴다 식는 거품 의심", tone: "hold" };
  switch (e.rung) {
    case "L1": return { text: "🈂️ 자막부터 — 관심은 큰데 끝까지 안 봄(언어장벽)", tone: "test" };
    case "L2": return { text: "🔵 유료 광고 추천 — 뜨는 중 + 진입 쉬움", tone: "go" };
    case "L3": return { text: "🤝 현지 PR — 자생 반응 확인됨", tone: "go" };
    case "L4": return { text: "🚀 진출 검토 — 규모 확보", tone: "go" };
    default: return { text: "👀 지켜보기 — 아직 투자 보류", tone: "watch" };
  }
}

// 약점 진단 — 가장 약한 드라이버에 대해 '왜 약한지 + 어떻게 해결'을 국가 맥락
// (언어격차·시장 성숙도)에 맞춰 제시. 같은 약점이라도 시장에 따라 처방이 다르다.
export interface WeaknessAdvice { driver: string; why: string; fix: string }
export function weaknessAdvice(e: EnrichedCountry): WeaknessAdvice {
  const m = metaOf(e.row.country);
  const c = e.row.country;
  const d = e.drivers;
  const ranked: Array<[string, number]> = [
    ["growth", d.growth], ["retention", d.retention], ["sub", d.sub], ["share", d.share],
  ];
  const weak = ranked.sort((a, b) => a[1] - b[1])[0]![0];

  if (weak === "retention")
    return m.langGap === "high" || m.langGap === "mid"
      ? { driver: "끝까지 보는 정도",
          why: `언어 장벽 가능성 — ${c}는 현지어 자막이 없어 중간에 이해가 끊겨 이탈했을 수 있음(언어격차 큰 시장).`,
          fix: "현지어 자막 + 핀 댓글 번역으로 1개월 A/B → 유지율 상승폭으로 효과 확인." }
      : { driver: "끝까지 보는 정도",
          why: `언어보다 콘텐츠 적합도 — ${c}는 영어권이라 자막 문제가 아니라 템포·소재가 현지 취향과 어긋날 수 있음.`,
          fix: "현지 인기 포맷·길이로 조정, 쇼츠 훅으로 초반 이탈 방지 후 본편 연결." };

  if (weak === "sub")
    return m.market === "mature"
      ? { driver: "팬 전환(구독)",
          why: `성숙 시장 — ${c}는 구독할 코어가 이미 구독을 끝내 '신규' 전환이 평탄(예: 일본). 보긴 많이 봐도 새 구독은 적음.`,
          fix: "신규 구독보다 기존 팬 심화 — 멤버십·커뮤니티·현지어 공지로 깊이를 키움." }
      : { driver: "팬 전환(구독)",
          why: `${c}는 보긴 하는데 구독으로 안 이어짐 — 구독 유인·동선이 약함.`,
          fix: "영상 내·엔드스크린 구독 CTA, 시리즈/플레이리스트로 '다음 영상' 연결해 구독 동기 부여." };

  if (weak === "growth")
    return { driver: "성장세",
      why: `${c}는 신규 유입이 정체 — 업로드 공백이거나 알고리즘 노출이 약해졌을 수 있음.`,
      fix: "업로드 빈도·쇼츠로 신규 도달 확대, 컴백·이벤트·현지 협업으로 재점화." };

  return { driver: "시청 비중(규모)",
    why: `${c}는 아직 도달 규모가 작음 — 인지도 초기 단계.`,
    fix: "현지 PR·소액 광고로 도달부터 키워 표본 확보. (작아도 유지·전환이 좋으면 먼저 잡을 후보)" };
}

export function enrichCountries(
  raw: CountryRow[], daysToDebut: number | null = null,
): EnrichedCountry[] {
  // 정량(점수·모멘텀·PRI·사분면)은 수축된 성장으로 — 노이즈 방어(#2).
  // 서술·플래그·표시는 원값(raw)으로 — 운영자가 실제값을 본다.
  // 데뷔 단계(#1)에 따라 점수 가중치를 바꾼다 (launch=적합도 우선).
  const phase: Phase = phaseOf(daysToDebut);
  const weights = PHASE_WEIGHTS[phase];
  const scored = raw.map((r) => ({ ...r, growthMoM: shrinkGrowth(r, raw) }));
  return raw.map((row, i) => {
    const sr = scored[i]!;
    const exp = scoreExpansion({
      country: sr.country, watchShare: sr.watchShare, growthMoM: sr.growthMoM,
      retentionRel: sr.retentionRel, subPer1k: sr.subPer1k,
    }, weights);
    const pattern = patternFlags(sr, scored);
    // 표본부족은 marketAnalysis(절대 시청시간) 단일 기준으로 통일한다.
    // scoreExpansion 은 watchShare<1% 로 insufficient 를 매기는데, 분 기준
    // 충분한 국가(TW: 0.3%지만 2.1K분)가 그 탓에 tier=insufficient(액션 '관찰만')
    // 인데 서술은 R6b(검증 후보)로 떠 모순됐다. → 분 기준으로 일원화하고,
    // watchShare 탓에 insufficient 처리된 경우는 점수로 tier 재판정.
    const insufficient = isInsufficient(row);
    let tier: ExpansionTier = exp.tier;
    if (insufficient) tier = "insufficient";
    else if (tier === "insufficient")
      tier = exp.score >= 70 ? "candidate" : exp.score >= 50 ? "test" : "watch";
    return {
      row, score: exp.score, tier, drivers: exp.drivers,
      // 분류는 수축(sr/scored)으로 tier·액션과 정합, 서술의 성장% 표시만 원값.
      // → "검증 후보"인데 액션은 "관망" 같은 모순(원값 high vs 수축 mid)을 차단.
      interpretation: interpretCountry(sr, scored, row.growthMoM),
      flags: contextFlags(row, raw), warnings: distortionWarnings(row, raw),
      momentum: momentum(sr, scored), quality: quality(row, raw),
      quadrant: quadrant(sr), pri: pri(sr, scored),
      pattern, rung: currentRung(tier, pattern),
      action: actionCard(row, tier, pattern),
      fandom: fandomFit(row, raw),
      insufficient,
    };
  });
}

/** 헤드라인 1줄 — 각 국가의 '실제 추천 액션'(베팅 큐)에서 뽑아 드릴다운과
 *  일치시킨다. (예: "광고 우선: X" 하면 X 드릴다운 액션도 광고여야 한다.) */
export function headline(enriched: EnrichedCountry[]): string {
  const ok = enriched.filter((e) => !e.insufficient);
  if (ok.length < 3)
    return `데뷔 초기 — 표본 누적 중 (충분국 ${ok.length}개). 진출 결정 보류 권장.`;
  // 점유 집중도는 '해외' 기준 — 본진(KR)이 점유 1위라 포함하면 의미 없음.
  const pop = ok.filter((e) => e.row.country !== "KR").map((e) => e.row);
  const q = bettingQueue(enriched);
  const parts: string[] = [];
  // 광고(유료) 1순위 = 베팅 큐의 첫 슬롯 (그 국가 드릴다운 액션 = 유료 광고).
  if (q.paidSlots[0]) parts.push(`광고 우선: ${q.paidSlots[0].row.country}`);
  // 자막 테스트 = 자막 단계(L1) 중 자막 ROI(시청량×언어장벽) 최고.
  const sub = [...q.subtitleEligible].sort((a, b) =>
    subtitlePriority(b.row, pop) - subtitlePriority(a.row, pop))[0];
  if (sub) parts.push(`자막 테스트: ${sub.row.country}`);
  const h = hhi(pop);
  parts.push(`점유 ${hhiLabel(h)}(TOP3 ${Math.round(cr3(pop) * 100)}%)`);
  return parts.join(" · ") + ` — 충분표본 ${ok.length}개국`;
}

export interface BettingQueue {
  subtitleEligible: EnrichedCountry[]; // L1 — 무료, 동시 가능
  paidSlots: EnrichedCountry[];        // L2+ 상위 2개 (다양성 적용)
  paidQueue: EnrichedCountry[];        // 나머지 대기
}
/** 순차 베팅 — 유료(L2+)는 동시 2슬롯, 다양성(서로 다른 권역) 적용. */
export function bettingQueue(enriched: EnrichedCountry[]): BettingQueue {
  // 본진(KR)은 해외 진출 액션 대상이 아니다 — retention_rel 기준선(1.0)이라
  // 모든 렌즈 상단에 고정되는데 "본진에 진출 광고를 때려라"는 무의미. 액션
  // 레이어(베팅/헤드라인)에서만 제외, 점수 랭킹·지도엔 본진으로 그대로 노출.
  const overseas = enriched.filter((e) => e.row.country !== "KR");
  const subtitleEligible = overseas.filter((e) => e.rung === "L1");
  const paid = overseas.filter((e) => e.rung === "L2" || e.rung === "L3" || e.rung === "L4")
    .sort((a, b) => b.pri - a.pri);
  // 다양성: 2번째 슬롯은 1번째와 다른 시장 성숙도를 우선. 단 후보가 모두 같은
  // 성숙도면(데뷔 초기 흔함) 슬롯을 비우지 말고 PRI 순으로 채운다(폴백).
  const slots: EnrichedCountry[] = [];
  if (paid[0]) slots.push(paid[0]);
  if (slots.length === 1) {
    const diverse = paid.slice(1).find(
      (e) => metaOf(e.row.country).market !== metaOf(slots[0]!.row.country).market);
    const second = diverse ?? paid[1]; // 다양성 후보 없으면 PRI 2위로 폴백
    if (second) slots.push(second);
  }
  return {
    subtitleEligible,
    paidSlots: slots,
    paidQueue: paid.filter((e) => !slots.includes(e)),
  };
}
