// frontend/src/lib/marketAnalysis.test.ts
//
// 시장 분석 엔진 검증 — 규칙엔진·파생지표·PRI·액션사다리·헤드라인·큐.
// 핵심: 점수 불변(해석/플래그/경고는 점수를 안 바꾼다), 표본부족 분리,
// '왜' 서술이 데이터 패턴과 일치.

import { describe, it, expect } from "vitest";
import {
  type CountryRow,
  isInsufficient, quantize, interpretCountry, contextFlags, distortionWarnings,
  quadrant, hhi, cr3, subtitlePriority, prPriority, retentionGate, pri,
  patternFlags, currentRung, actionCard, enrichCountries, headline, bettingQueue,
  metaOf, shrinkGrowth, fandomFit,
} from "./marketAnalysis";

const C = (country: string, watchShare: number, growthMoM: number,
  retentionRel: number, subPer1k: number): CountryRow =>
  ({ country, watchShare, growthMoM, retentionRel, subPer1k });

// 미완소년 같은 분포 (JP 성숙, US 큰데안봄, ID 언어장벽, DE 고품질소형, MX 소표본)
const POP: CountryRow[] = [
  C("JP", 0.18, 0.04, 1.02, 9),
  C("US", 0.14, 0.35, 0.72, 4),
  C("ID", 0.06, 0.62, 0.81, 8),
  C("TH", 0.05, 0.20, 0.88, 5),
  C("DE", 0.015, 0.10, 0.97, 8),
  C("MX", 0.004, 0.78, 0.95, 12),
];

describe("표본 게이트", () => {
  it("watch_share < 0.005 면 insufficient (절대 분 없을 때)", () => {
    expect(isInsufficient(C("MX", 0.004, 0, 1, 1))).toBe(true);
    expect(isInsufficient(C("JP", 0.18, 0, 1, 1))).toBe(false);
  });
  it("#1 절대 시청시간이 있으면 그걸 우선 — 점유 높아도 분이 적으면 부족", () => {
    expect(isInsufficient({ ...C("XX", 0.2, 0, 1, 1), watchMinutes: 500 })).toBe(true);
    expect(isInsufficient({ ...C("XX", 0.2, 0, 1, 1), watchMinutes: 9000 })).toBe(false);
  });
});

describe("#2 성장 수축", () => {
  const pop: CountryRow[] = [
    { ...C("A", 0.4, 0.1, 1, 5), watchMinutes: 100000 },
    { ...C("B", 0.3, 0.1, 1, 5), watchMinutes: 50000 },
    { ...C("C", 0.01, 5.0, 1, 5), watchMinutes: 800 }, // 소표본 폭발
  ];
  it("소표본 국가의 성장이 0 쪽으로 강하게 당겨짐", () => {
    const big = shrinkGrowth(pop[0]!, pop);
    const tiny = shrinkGrowth(pop[2]!, pop);
    expect(tiny).toBeLessThan(pop[2]!.growthMoM);     // 수축됨
    expect(big).toBeCloseTo(pop[0]!.growthMoM, 1);    // 큰 표본은 거의 그대로
    // 폭발(500%)이 큰 표본 성장(10%)보다 낮게 눌릴 수 있음
    expect(tiny).toBeLessThan(pop[2]!.growthMoM * 0.5);
  });
  it("절대 분 없으면 원값 유지", () => {
    expect(shrinkGrowth(C("Z", 0.1, 0.3, 1, 5), [C("Z", 0.1, 0.3, 1, 5)])).toBe(0.3);
  });
});

describe("규칙엔진 — 데이터 패턴 → 해석", () => {
  it("R1 소표본 우선 (다른 강신호 있어도)", () => {
    expect(interpretCountry(C("MX", 0.004, 0.78, 0.95, 12), POP).ruleId).toBe("R1");
  });
  it("R8 큰데 안 봄 — 큰 시청+저유지+고성장", () => {
    const r = interpretCountry(C("US", 0.14, 0.35, 0.72, 4), POP);
    expect(r.ruleId).toBe("R8");
    expect(r.action).toMatch(/자막/);
  });
  it("R2 언어장벽 — 고성장+저유지", () => {
    expect(interpretCountry(C("ID", 0.06, 0.62, 0.81, 8), POP).ruleId).toBe("R2");
  });
  it("R4 성숙·정체 — 큰 시청+저성장+고유지", () => {
    expect(interpretCountry(C("JP", 0.18, 0.04, 1.02, 9), POP).ruleId).toBe("R4");
  });
  it("R5 고품질 소형 — 고유지+고전환+작은 시청", () => {
    expect(interpretCountry(C("DE", 0.015, 0.10, 0.97, 8), POP).ruleId).toBe("R5");
  });
  it("서술문에 실제 국가명·값이 박힘", () => {
    expect(interpretCountry(C("ID", 0.06, 0.62, 0.81, 8), POP).narrative).toContain("ID");
  });
});

describe("컨텍스트 플래그 — 데이터 교차 시만, 최대 2개", () => {
  it("언어격차 큰 국가 + 저유지 → 자막 가설 플래그", () => {
    const f = contextFlags(C("US", 0.14, 0.35, 0.72, 4), POP);
    expect(f.some((x) => x.includes("자막 가설"))).toBe(true);
    expect(f.length).toBeLessThanOrEqual(2);
  });
  it("성숙시장 저성장 → '저성장 정상' 플래그 (JP)", () => {
    expect(contextFlags(C("JP", 0.18, 0.04, 1.02, 9), POP)
      .some((x) => x.includes("저성장이 정상"))).toBe(true);
  });
});

describe("왜곡 경고 — 점수 불변, 신뢰만 확대", () => {
  it("교포 과대대표: 디아스포라 high + 완주 국내급 + 언어격차 high (US)", () => {
    expect(distortionWarnings(C("US", 0.14, 0.1, 0.98, 5), POP)
      .some((w) => w.includes("교포 과대대표"))).toBe(true);
  });
  it("소표본 스파이크: 소표본+급증+고전환 (MX)", () => {
    expect(distortionWarnings(C("MX", 0.004, 0.78, 0.95, 12), POP)
      .some((w) => w.includes("소표본 스파이크"))).toBe(true);
  });
});

describe("파생 지표", () => {
  it("quadrant 4분면", () => {
    expect(quadrant(C("x", 0.1, 0.3, 1.1, 5))).toBe("invest");      // 성장+ 유지≥1
    expect(quadrant(C("x", 0.1, -0.1, 1.1, 5))).toBe("nurture");    // 저성장 유지≥1
    expect(quadrant(C("x", 0.1, 0.3, 0.7, 5))).toBe("watch");       // 성장+ 유지<1
    expect(quadrant(C("x", 0.1, -0.1, 0.7, 5))).toBe("deprioritize");
  });
  it("HHI = Σ share² , CR3 = 상위3 합", () => {
    expect(hhi(POP)).toBeCloseTo(POP.reduce((s, r) => s + r.watchShare ** 2, 0), 9);
    expect(cr3(POP)).toBeCloseTo(0.18 + 0.14 + 0.06, 9);
  });
  it("자막 우선도: 유지율≥1 이면 0 (자막 불필요)", () => {
    expect(subtitlePriority(C("x", 0.2, 0.1, 1.1, 5), POP)).toBe(0);
    expect(subtitlePriority(C("US", 0.14, 0.35, 0.72, 4), POP)).toBeGreaterThan(0);
  });
  it("retentionGate: <0.5→0.3, ≥0.7→1.0, 사이 선형", () => {
    expect(retentionGate(0.4)).toBe(0.3);
    expect(retentionGate(0.7)).toBe(1.0);
    expect(retentionGate(0.6)).toBeCloseTo(0.3 + 0.5 * 0.7, 9);
  });
  it("PRI: 0~1 근방, 저유지 국가가 게이트로 눌림", () => {
    const high = pri(C("ID", 0.06, 0.62, 0.81, 8), POP);
    const leaky = pri(C("LK", 0.06, 0.62, 0.40, 8), POP); // 동일하나 유지 0.40
    expect(high).toBeGreaterThan(leaky);
  });
});

describe("팬덤 안착력 — 끝까지+전환+자연유입 (성장·크기 무관)", () => {
  it("고유지+고전환 = 안착 좋음, 저유지+저전환 = 약함", () => {
    expect(fandomFit(C("JP", 0.18, 0.04, 1.02, 9), POP).level).toBe("strong");
    expect(fandomFit(C("US", 0.14, 0.35, 0.72, 4), POP).level).toBe("weak");
  });
  it("성장/크기는 안착에 영향 없음 (같은 유지·전환이면 동일)", () => {
    const a = fandomFit({ ...C("X", 0.3, 2.0, 0.9, 7) }, POP).score;
    const b = fandomFit({ ...C("Y", 0.01, -0.5, 0.9, 7) }, POP).score;
    expect(a).toBeCloseTo(b, 9); // watch_share·growth 달라도 동일
  });
  it("자연 유입(organic) 높으면 안착력 가산", () => {
    const lo = fandomFit({ ...C("Z", 0.1, 0.1, 0.9, 6), organicShare: 0.2 }, POP).score;
    const hi = fandomFit({ ...C("Z", 0.1, 0.1, 0.9, 6), organicShare: 0.9 }, POP).score;
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("패턴 + 액션 사다리", () => {
  it("shallow: 큰 시청 + 유지<0.5 → L0 억제", () => {
    const pop = [...POP, C("XX", 0.2, 0.3, 0.4, 5)];
    const p = patternFlags(C("XX", 0.2, 0.3, 0.4, 5), pop);
    expect(p.shallow).toBe(true);
    expect(currentRung("test", p)).toBe("L0");
  });
  it("R6b — 고성장+중간유지+전환 약하지않음이 R10으로 안 샘", () => {
    // growth high, retention mid(0.88), sub 중간 → R6b (구버전은 R10 추락)
    const r = interpretCountry(C("XX", 0.05, 0.5, 0.88, 6), POP);
    expect(r.ruleId).toBe("R6b");
  });

  it("insufficient → L0 액션금지 카드", () => {
    const card = actionCard(C("MX", 0.004, 0.78, 0.95, 12), "insufficient",
      patternFlags(C("MX", 0.004, 0.78, 0.95, 12), POP));
    expect(card.costTier).toBe("L0");
    expect(card.verb).toMatch(/관찰/);
  });
  it("watch tier → 자막 AB 카드 (L1)", () => {
    const card = actionCard(C("US", 0.14, 0.35, 0.72, 4), "watch",
      patternFlags(C("US", 0.14, 0.35, 0.72, 4), POP));
    expect(card.costTier).toBe("L1");
    expect(card.verb).toMatch(/자막/);
  });
});

describe("enrich + 헤드라인 + 큐", () => {
  it("enrichCountries — 점수와 해석을 동시에 부착, 점수는 scoreExpansion 그대로", () => {
    const en = enrichCountries(POP);
    expect(en).toHaveLength(POP.length);
    const us = en.find((e) => e.row.country === "US")!;
    expect(us.interpretation.ruleId).toBe("R8");
    expect(us.score).toBeGreaterThanOrEqual(0);
    expect(us.score).toBeLessThanOrEqual(100);
  });
  it("headline — 충분국 3개 미만이면 보류 메시지", () => {
    const thin = enrichCountries([C("MX", 0.004, 0.5, 1, 5), C("BR", 0.003, 0.3, 1, 4)]);
    expect(headline(thin)).toMatch(/보류/);
  });
  it("headline — 충분국 충분하면 추천 액션/점유 요약", () => {
    const h = headline(enrichCountries(POP));
    expect(h).toMatch(/(광고 우선|자막 테스트)/);
    expect(h).toMatch(/TOP3/);
  });

  it("tier 통일 — 시청비중 낮아도(0.3%) 절대 분 충분하면 insufficient 아님", () => {
    // TW 케이스 회귀: watchShare 0.003(scoreExpansion은 insufficient 처리)이지만
    // watchMinutes 2100(≥2000) → 분 기준 충분 → tier/action 이 '관찰만' 아님.
    const tw: CountryRow = {
      country: "TW", watchShare: 0.003, growthMoM: 1.45, retentionRel: 0.87,
      subPer1k: 1, watchMinutes: 2100,
    };
    const en = enrichCountries([tw, ...POP]);
    const t = en.find((e) => e.row.country === "TW")!;
    expect(t.insufficient).toBe(false);
    expect(t.tier).not.toBe("insufficient");
    expect(t.action.verb).not.toMatch(/관찰만/);
  });
  it("bettingQueue — 유료 슬롯 최대 2개, 다양성(시장성숙 다름)", () => {
    const q = bettingQueue(enrichCountries(POP));
    expect(q.paidSlots.length).toBeLessThanOrEqual(2);
    if (q.paidSlots.length === 2) {
      expect(metaOf(q.paidSlots[0]!.row.country).market)
        .not.toBe(metaOf(q.paidSlots[1]!.row.country).market);
    }
  });
  it("bettingQueue — 후보가 다 같은 성숙도여도 슬롯을 비우지 않음(폴백)", () => {
    // ID/TH/PH 모두 growth 시장 → 다양성 후보 없음. 그래도 2슬롯 채워야.
    const sameMarket = [
      C("ID", 0.06, 0.6, 0.9, 9), C("TH", 0.05, 0.5, 0.9, 8), C("PH", 0.04, 0.4, 0.9, 8),
    ];
    const q = bettingQueue(enrichCountries(sameMarket));
    const paidCount = q.paidSlots.length + q.paidQueue.length;
    if (paidCount >= 2) expect(q.paidSlots.length).toBe(2);
  });
});
