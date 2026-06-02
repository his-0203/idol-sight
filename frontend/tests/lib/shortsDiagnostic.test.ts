import { describe, expect, test } from "vitest";
import {
  median, mean, stdev, coefficientOfVariation,
  breakoutRatio, bandConcentration, cadenceDays,
  titleHasGroupToken, titleHasDecoration, titleHasHashtag,
  coveragePct, normalizedHHI, groupNameVariants,
} from "../../functions/lib/shortsDiagnostic";
import { statusByThresholds, buildDiagnostic, type DiagnosticInput } from "../../functions/lib/shortsDiagnostic";

describe("기초 통계", () => {
  test("median 홀/짝", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  test("mean / stdev / CV", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(stdev([2, 4, 6])).toBeCloseTo(1.633, 2);
    expect(coefficientOfVariation([2, 4, 6])).toBeCloseTo(0.408, 2);
    expect(coefficientOfVariation([5, 5, 5])).toBe(0); // 평탄
  });
  test("breakoutRatio = max/median", () => {
    expect(breakoutRatio([1128, 2259, 866])).toBeCloseTo(2.0, 1);
    expect(breakoutRatio([])).toBe(0);
  });
  test("bandConcentration — median ±40% 밴드 내 비율", () => {
    // median=1000, 밴드 [600,1400]. 5개 중 4개가 밴드 안 → 0.8
    expect(bandConcentration([700, 900, 1000, 1300, 5000])).toBeCloseTo(0.8, 5);
  });
});

describe("cadenceDays — 게시 간격 중앙값(일)", () => {
  test("3일·1일 간격 → 중앙값 2일", () => {
    const dates = [
      "2026-05-01T00:00:00Z",
      "2026-05-04T00:00:00Z", // +3d
      "2026-05-05T00:00:00Z", // +1d
    ];
    expect(cadenceDays(dates)).toBe(2);
  });
  test("1개 이하 → 0", () => {
    expect(cadenceDays(["2026-05-01T00:00:00Z"])).toBe(0);
    expect(cadenceDays([])).toBe(0);
  });
});

describe("제목 정규식", () => {
  test("그룹명 식별자 포함 (대소문자 무시)", () => {
    expect(titleHasGroupToken("미완소년 데뷔무대 직캠", ["미완소년", "MiiWAN"])).toBe(true);
    expect(titleHasGroupToken("MIIWAN debut stage", ["미완소년", "MiiWAN"])).toBe(true);
    expect(titleHasGroupToken("똑똑똑? 복복복!", ["미완소년", "MiiWAN"])).toBe(false);
    expect(titleHasGroupToken(null, ["MiiWAN"])).toBe(false);
  });
  test("장식/이모지 감지", () => {
    expect(titleHasDecoration("˚₊‧꒰ა 어디까지 날아갈지…~")).toBe(true); // 장식 기호
    expect(titleHasDecoration("그룹 내 게임 서열 1위 겜율이 🎮🏆")).toBe(true); // 이모지
    expect(titleHasDecoration("최고의 인테리어는 마하진 ⟡")).toBe(true);
    expect(titleHasDecoration("포켓몬 박사 나이선 학위 박탈 논란?!")).toBe(false); // ?! 는 장식 아님
    expect(titleHasDecoration("미완소년 신곡 무대")).toBe(false);
    // \p{S} 오탐 회귀 가드: 수학기호·물결은 장식 아님.
    expect(titleHasDecoration("미완소년 D-7~")).toBe(false);
    expect(titleHasDecoration("최종 점수 = 100")).toBe(false);
    expect(titleHasDecoration("A+B 콜라보")).toBe(false);
    // \p{So} 는 별·하트 등 '기타 기호' 는 여전히 장식으로 잡는다.
    expect(titleHasDecoration("별 ★ 모음")).toBe(true);
  });
  test("해시태그 감지", () => {
    expect(titleHasHashtag("데뷔 #미완소년 #MiiWAN")).toBe(true);
    expect(titleHasHashtag("데뷔 무대")).toBe(false);
  });
});

describe("coveragePct", () => {
  test("predicate 충족 비율 (%)", () => {
    const rows = [{ title: "a #x" }, { title: "b" }, { title: "c #y" }, { title: "d" }];
    expect(coveragePct(rows, (r) => titleHasHashtag(r.title))).toBe(50);
    expect(coveragePct([], () => true)).toBe(0);
  });
});

describe("normalizedHHI", () => {
  test("완전 균등 → 0, 완전 집중 → 1", () => {
    expect(normalizedHHI([1, 1, 1, 1])).toBeCloseTo(0, 5);
    expect(normalizedHHI([5, 0, 0, 0])).toBeCloseTo(1, 5);
    expect(normalizedHHI([])).toBeNull();
    expect(normalizedHHI([3])).toBeNull(); // n<2 의미 없음
  });
});

describe("groupNameVariants — 공식 그룹명만 (별명 제외)", () => {
  test("name/name_kr + 이름 변형만 추출, 초성·별명 제외", () => {
    const v = groupNameVariants("MiiWAN", "미완소년",
      ["miiwan", "MIIWAN", "미완", "ㅁㅇㅅㄴ", "겜율이"]);
    expect(v).toContain("MiiWAN");
    expect(v).toContain("미완소년");
    expect(v).toContain("miiwan");
    expect(v).toContain("미완");      // 미완소년의 부분문자열 → 변형으로 인정
    expect(v).not.toContain("ㅁㅇㅅㄴ"); // 초성 약자 — 검색 텍스트 아님
    expect(v).not.toContain("겜율이");  // 멤버 별명
  });
});

describe("statusByThresholds", () => {
  test("higher-better: good/warn/bad 경계", () => {
    const t = { good: 10, warn: 3, direction: "higher" as const };
    expect(statusByThresholds(12, t)).toBe("good");
    expect(statusByThresholds(10, t)).toBe("good");
    expect(statusByThresholds(5, t)).toBe("warn");
    expect(statusByThresholds(3, t)).toBe("warn");
    expect(statusByThresholds(2, t)).toBe("bad");
  });
  test("lower-better: good/warn/bad 경계", () => {
    const t = { good: 0.2, warn: 0.5, direction: "lower" as const };
    expect(statusByThresholds(0.1, t)).toBe("good");
    expect(statusByThresholds(0.2, t)).toBe("good");
    expect(statusByThresholds(0.4, t)).toBe("warn");
    expect(statusByThresholds(0.5, t)).toBe("warn");
    expect(statusByThresholds(0.7, t)).toBe("bad");
  });
});

const REPORT_VIEWS = [2259, 1519, 1403, 1334, 1321, 1303, 1128, 1098, 969, 912, 902, 866, 740];
function reportInput(over: Partial<DiagnosticInput> = {}): DiagnosticInput {
  const shorts = REPORT_VIEWS.map((v, i) => ({
    video_id: `v${i}`,
    title: "˚₊‧꒰ა 내부 별명 영상",
    published_at: `2026-05-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
    views: v, likes: Math.round(v * 0.06), comments: 5,
    viral_velocity_ratio: 1.1,
  }));
  return {
    group_key: "miiwan", shorts,
    groupTokens: ["미완소년", "MiiWAN"],
    subscribers: 1300,
    memberShares: [3, 2, 2, 2, 1],
    ...over,
  };
}

describe("buildDiagnostic — 리포트 재현", () => {
  test("브레이크아웃 배율 ≈ 2.0× → bad", () => {
    const d = buildDiagnostic(reportInput());
    const k = d.dimensions.viral_physics.find((x) => x.id === "breakout_ratio")!;
    expect(k.value).toBeCloseTo(2.0, 1);
    expect(k.status).toBe("bad");
  });
  test("그룹명 커버리지 0% → bad", () => {
    const d = buildDiagnostic(reportInput());
    const k = d.dimensions.discoverability.find((x) => x.id === "group_name_coverage")!;
    expect(k.value).toBe(0);
    expect(k.status).toBe("bad");
  });
  test("장식 특수문자 100% → bad, 평균 ER ≈ 6% → good", () => {
    const d = buildDiagnostic(reportInput());
    const dec = d.dimensions.discoverability.find((x) => x.id === "decoration_ratio")!;
    expect(dec.status).toBe("bad");
    const er = d.dimensions.core_strength.find((x) => x.id === "avg_er")!;
    expect(er.status).toBe("good");
  });
  test("DC 갤러리 활동·발견 채널 차원은 제외됨", () => {
    const d = buildDiagnostic(reportInput());
    expect((d.dimensions as Record<string, unknown>).discovery_channels).toBeUndefined();
    expect(d.dimensions.core_strength.find((k) => k.id === "dc_activity")).toBeUndefined();
  });
  test("우선순위 TOP3 = bad KPI, 차원 우선순위 순", () => {
    const d = buildDiagnostic(reportInput());
    expect(d.priorities).toHaveLength(3);
    expect(d.priorities[0]!.id).toBe("breakout_ratio");
    expect(d.priorities[0]!.fix.length).toBeGreaterThan(0);
  });
  test("표본 부족(n<5): 분포 KPI status=na + caveat", () => {
    const d = buildDiagnostic(reportInput({ shorts: reportInput().shorts.slice(0, 3) }));
    const k = d.dimensions.viral_physics.find((x) => x.id === "breakout_ratio")!;
    expect(k.status).toBe("na");
    expect(d.caveats.some((c) => c.includes("표본"))).toBe(true);
  });
  test("항상 식별자 caveat 포함", () => {
    const d = buildDiagnostic(reportInput());
    expect(d.caveats.some((c) => c.includes("공식 그룹명"))).toBe(true);
  });
  test("숏폼 0개 → shorts_n 0, 분포 na, 크래시 없음", () => {
    const d = buildDiagnostic(reportInput({ shorts: [] }));
    expect(d.shorts_n).toBe(0);
    expect(d.dimensions.viral_physics.every((k) => k.status === "na")).toBe(true);
  });
});
