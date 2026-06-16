// frontend/src/lib/decisionSupport.test.ts
//
// DECISION 탭 스코어링 검증. 두 의사결정(해외진출 / 굿즈)의 산식,
// 임계치(tier), 신뢰등급(confidence) 판정을 고정.
//
// 핵심 원칙(프레임 C):
//   - 모든 출력에 confidence(verified / estimated / insufficient)가 붙는다.
//   - 굿즈 멤버배분은 공개 per-member 프록시 → 절대 verified 아님(estimated).
//   - 해외진출은 소유자 Analytics 실측 → 표본 충분하면 verified, 적으면 insufficient.
//   - 수요하한·지불의향은 OAuth 데이터 없으면 insufficient(점등 대기).

import { describe, it, expect } from "vitest";
import {
  scoreExpansion,
  allocateMerch,
  estimateDemandFloor,
  gradeWillingnessToPay,
  type CountryAnalytics,
  type MemberPopularity,
} from "./decisionSupport";

describe("scoreExpansion — 국가별 진출 점수", () => {
  const strong: CountryAnalytics = {
    country: "JP", watchShare: 0.12, growthMoM: 0.22, retentionRel: 1.05, subPer1k: 8,
  };
  const weakRetention: CountryAnalytics = {
    country: "US", watchShare: 0.05, growthMoM: 0.10, retentionRel: 0.6, subPer1k: 2,
  };
  const tiny: CountryAnalytics = {
    country: "BR", watchShare: 0.004, growthMoM: 0.5, retentionRel: 1.2, subPer1k: 9,
  };

  it("강한 후보국은 candidate tier + verified", () => {
    const r = scoreExpansion(strong);
    expect(r.tier).toBe("candidate");
    expect(r.confidence).toBe("verified");
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  it("점수는 0~100 범위로 클램프", () => {
    expect(scoreExpansion(strong).score).toBeLessThanOrEqual(100);
    expect(scoreExpansion(strong).score).toBeGreaterThanOrEqual(0);
  });

  it("조회 점유 큰데 유지율 낮으면 자막 테스트 tier", () => {
    const r = scoreExpansion(weakRetention);
    expect(r.tier).toBe("test");
    // 자막 가설을 액션에 담는다
    expect(r.action).toMatch(/자막/);
  });

  it("표본(시청 점유) 1% 미만이면 insufficient — 노이즈 판단보류", () => {
    const r = scoreExpansion(tiny);
    expect(r.tier).toBe("insufficient");
    expect(r.confidence).toBe("insufficient");
  });

  it("드라이버 분해는 4축을 모두 0~1로 보고", () => {
    const r = scoreExpansion(strong);
    for (const v of Object.values(r.drivers)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("allocateMerch — 멤버 배분 비율 (공개 프록시)", () => {
  const members: MemberPopularity[] = [
    { memberId: 1, name: "A", compositeScore: 80, sufficient: true },
    { memberId: 2, name: "B", compositeScore: 40, sufficient: true },
    { memberId: 3, name: "C", compositeScore: 20, sufficient: true },
    { memberId: 4, name: "D", compositeScore: 5, sufficient: true },
  ];

  it("배분 합은 100%에 수렴", () => {
    const out = allocateMerch(members);
    const sum = out.reduce((a, m) => a + m.sharePct, 0);
    expect(sum).toBeCloseTo(100, 1);
  });

  it("공개 프록시이므로 confidence는 절대 verified가 아님 (estimated)", () => {
    for (const m of allocateMerch(members)) {
      expect(m.confidence).toBe("estimated");
    }
  });

  it("하한 floor — 인기 낮은 멤버도 최소 비율 보장 (0 방지)", () => {
    const out = allocateMerch(members);
    const lowest = out.find((m) => m.memberId === 4)!;
    expect(lowest.sharePct).toBeGreaterThan(0);
  });

  it("상한 cap — water-filling 으로 정확히 평균×2 이하 (재정규화 위반 없음)", () => {
    // 극단 분포: 한 멤버가 압도적이어도 cap 을 깨면 안 됨 (구 코드 버그 회귀).
    const skewed: MemberPopularity[] = [
      { memberId: 1, name: "A", compositeScore: 1000, sufficient: true },
      { memberId: 2, name: "B", compositeScore: 1, sufficient: true },
      { memberId: 3, name: "C", compositeScore: 1, sufficient: true },
    ];
    const out = allocateMerch(skewed);
    const mean = 100 / skewed.length;
    const top = Math.max(...out.map((m) => m.sharePct));
    const bottom = Math.min(...out.map((m) => m.sharePct));
    expect(top).toBeLessThanOrEqual(mean * 2 + 0.01);   // 상한 엄수
    expect(bottom).toBeGreaterThanOrEqual(10 - 0.01);    // 하한 엄수
    expect(out.reduce((s, m) => s + m.sharePct, 0)).toBeCloseTo(100, 1);
  });

  it("yt_sufficient=false 멤버는 insufficient로 표기", () => {
    const sparse: MemberPopularity[] = [
      { memberId: 1, name: "A", compositeScore: 50, sufficient: true },
      { memberId: 2, name: "B", compositeScore: null, sufficient: false },
    ];
    const out = allocateMerch(sparse);
    expect(out.find((m) => m.memberId === 2)!.confidence).toBe("insufficient");
  });
});

describe("estimateDemandFloor — 수요 하한 신뢰밴드", () => {
  it("OAuth 데이터(재방문·멤버십) 없으면 insufficient + null 밴드", () => {
    const r = estimateDemandFloor({
      returningViewers30d: null, membershipCount: null,
    });
    expect(r.confidence).toBe("insufficient");
    expect(r.low).toBeNull();
    expect(r.high).toBeNull();
  });

  it("데이터 있으면 estimated + low<high 밴드, 점추정 금지", () => {
    const r = estimateDemandFloor({
      returningViewers30d: 8000, membershipCount: 1200,
    });
    expect(r.confidence).toBe("estimated");
    expect(r.low).not.toBeNull();
    expect(r.high! > r.low!).toBe(true);
    // 전환율 가정 검증 필요 안내
    expect(r.note).toMatch(/검증/);
  });
});

describe("gradeWillingnessToPay — 지불의향 등급", () => {
  it("데이터 없으면 unknown + insufficient", () => {
    const r = gradeWillingnessToPay({ membershipPenetration: null, hasSuperChat: null });
    expect(r.tier).toBe("unknown");
    expect(r.confidence).toBe("insufficient");
  });

  it("멤버십 침투율 높으면 premium", () => {
    const r = gradeWillingnessToPay({ membershipPenetration: 0.05, hasSuperChat: false });
    expect(r.tier).toBe("premium");
    expect(r.confidence).toBe("estimated");
  });

  it("슈퍼챗 존재만으로도 premium", () => {
    const r = gradeWillingnessToPay({ membershipPenetration: 0.001, hasSuperChat: true });
    expect(r.tier).toBe("premium");
  });

  it("둘 다 약하면 standard", () => {
    const r = gradeWillingnessToPay({ membershipPenetration: 0.005, hasSuperChat: false });
    expect(r.tier).toBe("standard");
  });
});
