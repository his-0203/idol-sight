// frontend/src/lib/decisionSupport.ts
//
// DECISION 탭 스코어링 — 미완소년 공식 채널 데이터를 "해외진출 / 굿즈"
// 의사결정으로 환산하는 순수함수 모음.
//
// 설계 원칙 (대화 합의된 프레임 A·C):
//   1. 모든 출력에 confidence를 붙인다.
//        verified     — 소유자 Analytics 실측 + 표본 충분
//        estimated    — 공개 프록시거나 가정값 포함 (시청 ≠ 구매)
//        insufficient — 표본 부족 / OAuth 미연결 → 점등 대기
//   2. 굿즈 멤버배분은 공개 per-member 인기 프록시 → 절대 verified 아님.
//   3. 선행→커밋이 아니라 선행→테스트. 액션 카피는 "자막 AB / 소량
//      예약판매"처럼 테스트를 권고하지 "1만 개 찍자"고 말하지 않는다.
//
// 정규화는 cross-country z-score 대신 "절대 기준 스케일"을 쓴다 — 추적
// 국가가 2~3개뿐일 때 z-score가 퇴화(degenerate)하는 문제를 피하고,
// 임계치(70/50)가 절대적 의미를 갖게 하기 위함.

export type Confidence = "verified" | "estimated" | "insufficient";

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

// ─────────────────────────────────────────────────────────────────────
// 해외진출 — 국가별 진출 점수
// ─────────────────────────────────────────────────────────────────────

export interface CountryAnalytics {
  country: string;      // ISO 코드 또는 표시명
  watchShare: number;   // 0..1, 전체 시청시간 중 이 국가 비중
  growthMoM: number;    // 소수, 0.15 = +15% MoM
  retentionRel: number; // 국가 유지율 / 국내 유지율 (1.0 = 동등)
  subPer1k: number;     // 1k 조회당 구독 증가 수
}

export type ExpansionTier = "candidate" | "test" | "watch" | "insufficient";

export interface ExpansionResult {
  country: string;
  score: number; // 0..100
  tier: ExpansionTier;
  confidence: Confidence;
  drivers: { growth: number; retention: number; sub: number; share: number };
  action: string;
}

// 절대 기준 만점선 — 이 값에 도달하면 해당 축 1.0.
const REF_GROWTH = 0.30;   // +30% MoM = 만점
const REF_SUB_PER_1K = 10; // 1k당 10구독(=1% 전환) = 만점
const REF_SHARE = 0.15;    // 시청점유 15% = 만점

const W_GROWTH = 0.35;
const W_RETENTION = 0.30;
const W_SUB = 0.25;
const W_SHARE = 0.10;

// 표본 가드 — 이 미만이면 노이즈로 보고 판단 보류.
const MIN_WATCH_SHARE = 0.01;

export function scoreExpansion(c: CountryAnalytics): ExpansionResult {
  const drivers = {
    growth: clamp01(c.growthMoM / REF_GROWTH),
    // 유지율은 국내 대비 0.5 → 0, 1.2 → 1 로 매핑.
    retention: clamp01((c.retentionRel - 0.5) / 0.7),
    sub: clamp01(c.subPer1k / REF_SUB_PER_1K),
    share: clamp01(c.watchShare / REF_SHARE),
  };

  const score = Math.round(
    100 *
      (W_GROWTH * drivers.growth +
        W_RETENTION * drivers.retention +
        W_SUB * drivers.sub +
        W_SHARE * drivers.share),
  );

  // 표본부족이 최우선 — 점수가 높아도 데이터가 노이즈면 행동 금지.
  if (c.watchShare < MIN_WATCH_SHARE) {
    return {
      country: c.country, score, tier: "insufficient", confidence: "insufficient",
      drivers,
      action: "표본(시청 점유) 부족 — 누적될 때까지 판단 보류. VPN/교포 트래픽 가능성도 함께 점검.",
    };
  }

  let tier: ExpansionTier;
  let action: string;

  const bigButLeaky = c.watchShare >= 0.03 && c.retentionRel < 0.8;

  if (score >= 70 && c.retentionRel >= 0.9 && c.growthMoM >= 0.15) {
    tier = "candidate";
    action = "진출 후보 — 현지 자막 상시화 + 현지 PR/플랫폼 파트너 탐색. 소량 예약판매로 전환 검증 후 규모 확정.";
  } else if ((score >= 50 && score < 70) || bigButLeaky) {
    tier = "test";
    action = bigButLeaky
      ? "조회는 큰데 유지율이 낮음(언어장벽 가설) — 현지어 자막 AB 1개월 → 유지율 상승폭으로 ROI 측정."
      : "잠재 후보 — 자막 AB 테스트로 1개월 관찰 후 candidate 승급 여부 판단.";
  } else {
    tier = "watch";
    action = "관망 — 성장률·유지율 추세만 모니터. 별도 투자 없음.";
  }

  return { country: c.country, score, tier, confidence: "verified", drivers, action };
}

// ─────────────────────────────────────────────────────────────────────
// 굿즈 — 멤버 배분 비율 (공개 per-member 인기 프록시)
// ─────────────────────────────────────────────────────────────────────

export interface MemberPopularity {
  memberId: number;
  name: string;
  compositeScore: number | null; // agg_member_popularity.composite_score
  sufficient: boolean;           // agg_member_popularity.yt_sufficient
}

export interface MerchAllocationResult {
  memberId: number;
  name: string;
  sharePct: number; // 0..100, 합 ≈ 100
  confidence: Confidence;
}

export interface AllocateOptions {
  floorPct?: number;   // 멤버 최소 비율 (기본 0.10)
  capFactor?: number;  // 평균 대비 상한 배수 (기본 2)
}

// 인기 점유대로 포카 비율을 산정하되:
//   floor — 인기 낮은 멤버도 최소 보장 (0장 = 팬덤 정치 리스크)
//   cap   — 한 멤버 과잉생산 방어 (인기는 변동하므로 몰빵 금지)
export function allocateMerch(
  members: MemberPopularity[],
  opts: AllocateOptions = {},
): MerchAllocationResult[] {
  const n = members.length;
  if (n === 0) return [];

  // floor는 n명에 분배 가능한 범위로 자동 축소 (n>8이면 10% 불가).
  const floor = Math.min(opts.floorPct ?? 0.1, 0.8 / n);
  const cap = (opts.capFactor ?? 2) / n;

  const weights = members.map((m) => Math.max(0, m.compositeScore ?? 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  // 1차 비율 → floor/cap 클램프 → 재정규화.
  const clamped = weights.map((w) =>
    Math.min(cap, Math.max(floor, w / total)),
  );
  const cTotal = clamped.reduce((a, b) => a + b, 0) || 1;

  return members.map((m, i) => ({
    memberId: m.memberId,
    name: m.name,
    sharePct: (clamped[i]! / cTotal) * 100,
    // 공개 프록시이므로 최선이 estimated. 데이터 부족 멤버는 insufficient.
    confidence: m.sufficient && m.compositeScore != null ? "estimated" : "insufficient",
  }));
}

// ─────────────────────────────────────────────────────────────────────
// 굿즈 — 수요 하한 신뢰밴드 (OAuth 데이터 필요)
// ─────────────────────────────────────────────────────────────────────

export interface DemandInputs {
  returningViewers30d: number | null; // OAuth (Analytics)
  membershipCount: number | null;     // OAuth
  convLow?: number;  // 가정 전환율 하한 (기본 0.02)
  convHigh?: number; // 가정 전환율 상한 (기본 0.08)
}

export interface DemandFloorResult {
  low: number | null;
  high: number | null;
  coreFans: number | null;
  confidence: Confidence;
  note: string;
}

export function estimateDemandFloor(inp: DemandInputs): DemandFloorResult {
  const { returningViewers30d, membershipCount } = inp;
  if (returningViewers30d == null && membershipCount == null) {
    return {
      low: null, high: null, coreFans: null, confidence: "insufficient",
      note: "OAuth(Analytics) 연결 필요 — 재방문 시청자·멤버십 데이터가 들어오면 점등.",
    };
  }
  const convLow = inp.convLow ?? 0.02;
  const convHigh = inp.convHigh ?? 0.08;
  const core = (returningViewers30d ?? 0) + (membershipCount ?? 0);
  return {
    coreFans: core,
    low: Math.round(core * convLow),
    high: Math.round(core * convHigh),
    confidence: "estimated",
    note: "전환율은 가정값(2~8%) — 과거 판매 실측이 없으므로 소량 예약판매로 반드시 검증 후 규모 확정.",
  };
}

// ─────────────────────────────────────────────────────────────────────
// 굿즈 — 지불의향 등급 (가격 라인 결정)
// ─────────────────────────────────────────────────────────────────────

export interface WtpInputs {
  membershipPenetration: number | null; // 멤버십가입 / 구독자
  hasSuperChat: boolean | null;
  premiumThreshold?: number; // 기본 0.02 (2%)
}

export interface WtpResult {
  tier: "premium" | "standard" | "unknown";
  confidence: Confidence;
  note: string;
}

export function gradeWillingnessToPay(inp: WtpInputs): WtpResult {
  const { membershipPenetration, hasSuperChat } = inp;
  if (membershipPenetration == null && hasSuperChat == null) {
    return {
      tier: "unknown", confidence: "insufficient",
      note: "OAuth(Analytics) 연결 필요 — 멤버십·슈퍼챗 데이터가 들어오면 점등.",
    };
  }
  const threshold = inp.premiumThreshold ?? 0.02;
  const premium =
    (membershipPenetration ?? 0) >= threshold || hasSuperChat === true;
  return {
    tier: premium ? "premium" : "standard",
    confidence: "estimated",
    note: premium
      ? "고래(멤버십/슈퍼챗) 비중 충분 — 프리미엄 라인 여지."
      : "지불의향 신호 약함 — 보급형 위주 권장.",
  };
}
