import { describe, expect, test } from "vitest";
import {
  median, mean, stdev, coefficientOfVariation,
  breakoutRatio, bandConcentration, cadenceDays,
  titleHasGroupToken, titleHasDecoration, titleHasHashtag,
  coveragePct, normalizedHHI, groupNameVariants,
} from "../../functions/lib/shortsDiagnostic";

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
