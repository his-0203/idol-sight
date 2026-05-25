// frontend/src/lib/insightFormat.test.ts
//
// humanizeInsightText safety-net 변환기 + parseInsightBody 통합 검증.

import { describe, it, expect } from "vitest";
import {
  humanizeInsightText,
  parseInsightBody,
} from "./insightFormat";

describe("humanizeInsightText — null safety", () => {
  it("null/undefined 모두 빈 문자열", () => {
    expect(humanizeInsightText(null)).toBe("");
    expect(humanizeInsightText(undefined)).toBe("");
  });

  it("이미 자연어인 텍스트는 그대로 (no-op)", () => {
    const text = "플레이브의 주간 구독자가 자연 유입 성장 가능성을 보였다.";
    expect(humanizeInsightText(text)).toBe(text);
  });

  it("idempotent — humanize(humanize(x)) === humanize(x)", () => {
    const raw = "구독자 z=2.3, WoW +48%, **organic_growth** 가능성.";
    const once = humanizeInsightText(raw);
    const twice = humanizeInsightText(once);
    expect(twice).toBe(once);
  });
});

describe("humanizeInsightText — z-score 변환", () => {
  it("z=2.3 → 큰 폭의 증가 (zMagnitude 임계 abs>=2)", () => {
    const out = humanizeInsightText("구독자 z=2.3으로 급증");
    expect(out).toContain("평소 대비 큰 폭의 증가");
    expect(out).not.toMatch(/\bz\s*=/);
  });

  it("z=1.6 → 두드러진 증가 (임계 abs>=1.5)", () => {
    const out = humanizeInsightText("구독자 z=1.6");
    expect(out).toContain("평소 대비 두드러진 증가");
  });

  it("z=-2.5 → 감소", () => {
    const out = humanizeInsightText("뉴스 z=-2.5");
    expect(out).toContain("(평소 대비 큰 폭의 감소)");
  });

  it("z=3.5 → 매우 큰 폭의 증가", () => {
    const out = humanizeInsightText("조회수 z=3.5");
    expect(out).toContain("매우 큰 폭의 증가");
  });
});

describe("humanizeInsightText — temporal z-score", () => {
  it("temporal z=9.23 → 최근 8주 평균 대비 매우 큰 폭의 증가", () => {
    const out = humanizeInsightText("조회수 temporal z=9.23");
    expect(out).toContain("최근 8주 평균 대비 매우 큰 폭의 증가");
    expect(out).not.toContain("temporal z");
  });

  it("temporal z=-8.10 → 최근 8주 평균 대비 매우 큰 폭의 감소", () => {
    const out = humanizeInsightText("구독자 temporal z=-8.10");
    expect(out).toContain("최근 8주 평균 대비 매우 큰 폭의 감소");
  });

  it("temporal z 가 일반 z 변환에 또 잡히지 않음 (이중 변환 회피)", () => {
    const out = humanizeInsightText("temporal z=2.0");
    // "최근 8주 평균 대비" 가 한 번만 등장
    const occurrences = (out.match(/최근 8주 평균 대비/g) || []).length;
    expect(occurrences).toBe(1);
    // "(평소 대비" 가 추가로 생기면 안 됨
    expect(out).not.toContain("(평소 대비");
  });
});

describe("humanizeInsightText — WoW 변환", () => {
  it("WoW +48% → 지난 주 대비 48% 증가", () => {
    const out = humanizeInsightText("조회수 WoW +48%");
    expect(out).toContain("지난 주 대비 48% 증가");
    expect(out).not.toContain("WoW");
  });

  it("WoW -25% → 지난 주 대비 25% 감소", () => {
    const out = humanizeInsightText("구독자 WoW -25%");
    expect(out).toContain("지난 주 대비 25% 감소");
  });

  it("WoW 234.6% (sign 없음) → 증가", () => {
    const out = humanizeInsightText("WoW 234.6%");
    expect(out).toContain("지난 주 대비 234.6% 증가");
  });
});

describe("humanizeInsightText — ER WoW (WoW 전에 먼저)", () => {
  it("ER WoW -28% → 팬 참여율 28% 하락", () => {
    const out = humanizeInsightText("ER WoW -28%");
    expect(out).toContain("팬 참여율(좋아요·댓글 비율) 28% 하락");
    expect(out).not.toContain("ER WoW");
  });

  it("ER WoW 가 일반 WoW 매칭에 이중 변환되지 않음", () => {
    const out = humanizeInsightText("PLAVE ER WoW -28% 하락");
    expect(out).toContain("팬 참여율(좋아요·댓글 비율) 28% 하락");
    expect(out).not.toMatch(/ER\s+WoW/i);
    expect(out.match(/지난 주 대비/g)).toBeNull();
  });

  it("ER WoW +5% → 팬 참여율 5% 증가", () => {
    const out = humanizeInsightText("ER WoW +5%");
    expect(out).toContain("팬 참여율(좋아요·댓글 비율) 5% 증가");
  });
});

describe("humanizeInsightText — enum key 변환", () => {
  it("organic_growth → 자연 유입 성장", () => {
    expect(humanizeInsightText("유력 가설은 **organic_growth** 가능성"))
      .toContain("자연 유입 성장");
  });

  it("9개 가설 enum key 모두 한국어로 치환", () => {
    const keys = [
      "organic_growth", "paid_youtube_ads", "subscriber_purchase",
      "comeback_cycle", "broadcast_appearance", "community_word_of_mouth",
      "controversy_spike", "platform_concentrated_promo", "member_centric_spike",
    ];
    for (const k of keys) {
      const out = humanizeInsightText(`가설: ${k}`);
      expect(out, `${k} 변환 실패`).not.toContain(k);
    }
  });

  it("markdown bold 안의 enum 도 변환됨", () => {
    const out = humanizeInsightText("**paid_youtube_ads** 가능성");
    expect(out).toContain("**유튜브 광고 의심**");
  });

  it("word boundary — organic_growth_v2 같은 변형은 매칭 안 됨", () => {
    const out = humanizeInsightText("organic_growth_v2 는 가상");
    // organic_growth 가 변환되면 "자연 유입 성장_v2" 가 되어 의미 깨짐
    // word boundary 가 영문/숫자/_ 직후 매칭을 막아야 함
    expect(out).toContain("organic_growth_v2");
  });
});

describe("humanizeInsightText — 실제 production 카드 본문 변환", () => {
  it("PLAVE diagnosis raw → 자연어 (전문 용어 0)", () => {
    const raw =
      "**플레이브**는 주간 구독자 z=2.3, 조회수 z=2.3으로 급증했으며, " +
      "뉴스 z=1.9 (WoW +31%), 커뮤니티 z=2.2 (WoW +57%)도 동반 상승했습니다. " +
      "유력 가설은 **organic_growth** 가능성. 대안 가설 없음.";
    const out = humanizeInsightText(raw);
    expect(out).not.toMatch(/\bz\s*=/);
    expect(out).not.toContain("WoW");
    expect(out).not.toContain("organic_growth");
    expect(out).toContain("자연 유입 성장");
    expect(out).toContain("지난 주 대비 31% 증가");
    expect(out).toContain("지난 주 대비 57% 증가");
  });

  it("MiiWAN ipx_action raw → 자연어", () => {
    const raw =
      "**미완소년** 주간 조회수가 WoW +48%로 급증했으나, ER WoW는 -25%로 " +
      "하락했습니다. 신규 영상의 paid 의심 비중이 42%로 나타나, 유력 가설은 " +
      "**paid_youtube_ads** 가능성입니다.";
    const out = humanizeInsightText(raw);
    expect(out).toContain("지난 주 대비 48% 증가");
    expect(out).toContain("팬 참여율(좋아요·댓글 비율) 25% 하락");
    expect(out).toContain("유튜브 광고 의심");
    expect(out).not.toContain("WoW");
    expect(out).not.toContain("paid_youtube_ads");
  });

  it("ISEDOL insight raw → 자연어", () => {
    const raw =
      "**이세계아이돌**은 주간 구독자 temporal z=-8.10으로 감소세를 보였으나, " +
      "조회수는 temporal z=9.23으로 견조하게 증가했습니다.";
    const out = humanizeInsightText(raw);
    expect(out).toContain("최근 8주 평균 대비 매우 큰 폭의 감소");
    expect(out).toContain("최근 8주 평균 대비 매우 큰 폭의 증가");
    expect(out).not.toContain("temporal z");
  });
});

describe("parseInsightBody — humanize 자동 적용", () => {
  it("raw 통계 용어 body 는 humanize 후 token 분해", () => {
    const tokens = parseInsightBody(
      "**organic_growth** 가능성으로 z=2.3 급증",
    );
    // 토큰 안에 enum key / z= 가 잔존하면 안 됨
    const joined = tokens
      .map((t) => (t.kind === "text" ? t.text : t.kind === "tone" ? t.text : t.label))
      .join("");
    expect(joined).not.toContain("organic_growth");
    expect(joined).not.toMatch(/\bz\s*=/);
    expect(joined).toContain("자연 유입 성장");
  });

  it("이미 자연어인 body 도 동일하게 token 분해 (회귀 안전)", () => {
    const tokens = parseInsightBody(
      "**플레이브**의 조회수가 두드러진 증가를 기록.",
    );
    expect(tokens.length).toBeGreaterThan(0);
    // 그룹 alias '플레이브' 가 group 토큰으로 인식되는지
    expect(tokens.some((t) => t.kind === "group" && t.key === "plave")).toBe(true);
  });
});
