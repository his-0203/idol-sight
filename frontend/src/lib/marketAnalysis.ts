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

import { scoreExpansion, type ExpansionTier } from "./decisionSupport";

export interface CountryRow {
  country: string;
  watchShare: number;   // 0..1
  growthMoM: number;    // 소수
  retentionRel: number; // 국내(KR) 대비, 1.0 = 동등
  subPer1k: number;
  watchMinutes?: number | null; // 절대 시청시간(분) — 표본 게이트(#1)
  organicShare?: number | null; // 오가닉(검색+추천) 트래픽 비중(#3)
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

export function interpretCountry(row: CountryRow, pop: CountryRow[]): Interpretation {
  const L = quantize(row, pop);
  const c = row.country;
  const subs = pop.map((r) => r.subPer1k);
  // 전환이 강한 편 = 중앙값 이상 (R3/R5 판정용).
  const subHigh = row.subPer1k >= percentile(subs, 0.5);

  // 위에서부터 평가, 첫 매칭 채택 (우선순위 = 신뢰도·규모·시급성).
  if (isInsufficient(row))
    return { ruleId: "R1", label: "🔬 소표본",
      narrative: `${c}는 시청 비중 ${(row.watchShare * 100).toFixed(1)}%로 표본이 얇아 지표가 출렁입니다. 추세 판단은 보류, 모니터링 대상으로만 둡니다.`,
      action: "관찰만 — 액션 보류" };

  if (L.watch === "high" && L.retention === "low" && L.growth === "high")
    return { ruleId: "R8", label: "⚠️ 큰데 안 봄",
      narrative: `${c}는 비중도 크고(${(row.watchShare * 100).toFixed(1)}%) 성장도 빠르나(${pct(row.growthMoM)}) 완주율이 국내의 ${x2(row.retentionRel)}에 그칩니다. 규모 있는 언어장벽 = 자막 ROI 최대.`,
      action: "자막 풀-로컬라이즈 (1순위)" };

  if (L.growth === "high" && L.retention === "low")
    return { ruleId: "R2", label: "🚨 언어장벽 의심",
      narrative: `${c}는 유입이 폭발(${pct(row.growthMoM)})하나 완주율이 ${x2(row.retentionRel)}입니다. 관심은 있는데 끝까지 안 봄 = 언어/자막 장벽 가설.`,
      action: "현지어 자막 A/B 테스트" };

  if (L.growth === "high" && L.retention === "high" && subHigh)
    return { ruleId: "R3", label: "🔥 핵심 확장",
      narrative: `${c}는 유입·완주·전환이 모두 강합니다(${pct(row.growthMoM)}, ret ${x2(row.retentionRel)}). 저항 없는 성장 시장 — 예산 0순위.`,
      action: "광고·현지 활성화 집중" };

  if (L.watch === "high" && L.growth === "low" && L.retention === "high")
    return { ruleId: "R4", label: "🪨 성숙·정체",
      narrative: `${c}는 비중은 크나(${(row.watchShare * 100).toFixed(1)}%) 성장이 멈췄습니다(${pct(row.growthMoM)}). 충성 코어는 견고 — 신규 유입보다 팬덤 심화로.`,
      action: "리텐션·커뮤니티 심화" };

  if (L.retention === "high" && subHigh && L.watch !== "high")
    return { ruleId: "R5", label: "💎 고품질 소형",
      narrative: `${c}는 작지만 보는 사람은 끝까지 보고 구독까지 합니다(ret ${x2(row.retentionRel)}). 숨은 고적합 시장 — 표본만 키우면 핵심 후보.`,
      action: "도달(노출) 확대 실험" };

  if (L.growth === "high" && L.retention === "mid" && L.sub === "low")
    return { ruleId: "R6", label: "📈 얕은 바이럴",
      narrative: `${c}는 조회는 늘지만(${pct(row.growthMoM)}) 구독 전환이 약합니다. 알고리즘/쇼츠 바이럴 유입 가능성 — 휘발 위험, 코어 전환 장치 필요.`,
      action: "구독 유도 CTA·롱폼 연결" };

  // R6b — 고성장 + 중간 완주 + 전환 약하지 않음. 명백한 유망 시장인데 R10으로
  // 새던 빠짐(gap) 보강.
  if (L.growth === "high" && L.retention === "mid")
    return { ruleId: "R6b", label: "📈 성장 유망(검증)",
      narrative: `${c}는 빠르게 크고(${pct(row.growthMoM)}) 완주·전환도 나쁘지 않습니다. 검증 가치 큰 후보 — 소액 테스트로 핵심 시장 승급 여부 확인.`,
      action: "유료 도달 소액 테스트" };

  if (L.retention === "low" && (L.growth === "mid" || L.growth === "low"))
    return { ruleId: "R7", label: "🧊 적합도 낮음",
      narrative: `${c}는 유입도 완주도 약합니다(ret ${x2(row.retentionRel)}, ${pct(row.growthMoM)}). 콘텐츠-시장 적합도 미달 — 자원 투입 보류, 분기 재평가.`,
      action: "보류" };

  if (L.growth === "low" && (L.watch === "mid" || L.watch === "high"))
    return { ruleId: "R9", label: "📉 식는 시장",
      narrative: `${c}는 비중은 있으나 직전 대비 꺾였습니다(${pct(row.growthMoM)}). 모멘텀 소실 — 원인(경쟁작·콘텐츠 공백) 점검, 컴백·이벤트로 재점화.`,
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
export const metaOf = (country: string): CountryMeta =>
  COUNTRY_META[country] ?? DEFAULT_META;

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
  const ease = Math.max(0.01, metaOf(row.country).ease);
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
  insufficient: boolean;
}

export function enrichCountries(raw: CountryRow[]): EnrichedCountry[] {
  // 정량(점수·모멘텀·PRI·사분면)은 수축된 성장으로 — 노이즈 방어(#2).
  // 서술·플래그·표시는 원값(raw)으로 — 운영자가 실제값을 본다.
  const scored = raw.map((r) => ({ ...r, growthMoM: shrinkGrowth(r, raw) }));
  return raw.map((row, i) => {
    const sr = scored[i]!;
    const exp = scoreExpansion({
      country: sr.country, watchShare: sr.watchShare, growthMoM: sr.growthMoM,
      retentionRel: sr.retentionRel, subPer1k: sr.subPer1k,
    });
    const pattern = patternFlags(sr, scored);
    return {
      row, score: exp.score, tier: exp.tier, drivers: exp.drivers,
      // 해석/표시는 원값(raw) 일관 — 서술의 성장%와 드라이버 막대의 성장%가
      // 같은 숫자여야 비전문가가 안 헷갈린다. tier(수축 기반)와는 렌즈가 달라
      // 등급이 1:1 아닐 수 있고, 그게 정상(점수=robust, 서술=실제 패턴).
      interpretation: interpretCountry(row, raw),
      flags: contextFlags(row, raw), warnings: distortionWarnings(row, raw),
      momentum: momentum(sr, scored), quality: quality(row, raw),
      quadrant: quadrant(sr), pri: pri(sr, scored),
      pattern, rung: currentRung(exp.tier, pattern),
      action: actionCard(row, exp.tier, pattern),
      insufficient: isInsufficient(row),
    };
  });
}

/** 헤드라인 1줄 — 충분표본국만 대상. 너무 적으면 보류 메시지. */
export function headline(enriched: EnrichedCountry[]): string {
  const ok = enriched.filter((e) => !e.insufficient);
  if (ok.length < 3)
    return `데뷔 초기 — 표본 누적 중 (충분국 ${ok.length}개). 진출 결정 보류 권장.`;
  const pop = ok.map((e) => e.row);
  const sub = [...ok].sort((a, b) =>
    subtitlePriority(b.row, pop) - subtitlePriority(a.row, pop))[0];
  const pr = [...ok].sort((a, b) =>
    prPriority(b.row, pop) - prPriority(a.row, pop))[0];
  const h = hhi(pop);
  return `자막 최우선: ${sub!.row.country} · PR 점화 후보: ${pr!.row.country}`
    + ` · 점유 ${hhiLabel(h)}(TOP3 ${Math.round(cr3(pop) * 100)}%) — 충분표본 ${ok.length}개국`;
}

export interface BettingQueue {
  subtitleEligible: EnrichedCountry[]; // L1 — 무료, 동시 가능
  paidSlots: EnrichedCountry[];        // L2+ 상위 2개 (다양성 적용)
  paidQueue: EnrichedCountry[];        // 나머지 대기
}
/** 순차 베팅 — 유료(L2+)는 동시 2슬롯, 다양성(서로 다른 권역) 적용. */
export function bettingQueue(enriched: EnrichedCountry[]): BettingQueue {
  const subtitleEligible = enriched.filter((e) => e.rung === "L1");
  const paid = enriched.filter((e) => e.rung === "L2" || e.rung === "L3" || e.rung === "L4")
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
