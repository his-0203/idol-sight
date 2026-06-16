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
  metaOf,
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
  it("watch_share < 0.005 면 insufficient", () => {
    expect(isInsufficient(C("MX", 0.004, 0, 1, 1))).toBe(true);
    expect(isInsufficient(C("JP", 0.18, 0, 1, 1))).toBe(false);
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

describe("패턴 + 액션 사다리", () => {
  it("shallow: 큰 시청 + 유지<0.5 → L0 억제", () => {
    const pop = [...POP, C("XX", 0.2, 0.3, 0.4, 5)];
    const p = patternFlags(C("XX", 0.2, 0.3, 0.4, 5), pop);
    expect(p.shallow).toBe(true);
    expect(currentRung("test", p)).toBe("L0");
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
  it("headline — 충분국 충분하면 자막/PR/점유 요약", () => {
    const h = headline(enrichCountries(POP));
    expect(h).toMatch(/자막 최우선/);
    expect(h).toMatch(/TOP3/);
  });
  it("bettingQueue — 유료 슬롯 최대 2개, 다양성(시장성숙 다름)", () => {
    const q = bettingQueue(enrichCountries(POP));
    expect(q.paidSlots.length).toBeLessThanOrEqual(2);
    if (q.paidSlots.length === 2) {
      expect(metaOf(q.paidSlots[0]!.row.country).market)
        .not.toBe(metaOf(q.paidSlots[1]!.row.country).market);
    }
  });
});
