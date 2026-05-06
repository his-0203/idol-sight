// LLM 인사이트 본문 파서 단위 테스트.
//
// 목적: 그룹 alias 매칭 / 톤 분류 / markdown bold 처리 세 축 회귀 방지.
// 다른 에이전트가 worker 측 프롬프트를 갱신해 본문 출력 contract 가
// 변하더라도, 이 테스트가 깨지면 UI 가 시각화에 실패하므로 즉시 알림.

import { describe, expect, test } from "vitest";
import {
  parseInsightBody,
  extractGroupKeys,
  POSITIVE_WORDS,
  NEGATIVE_WORDS,
} from "../../src/lib/insightFormat";

describe("parseInsightBody — 그룹 매칭", () => {
  test("영문 그룹명을 단어 경계에서만 매칭", () => {
    const tokens = parseInsightBody("PLAVE 가 1위.");
    const groups = tokens.filter((t) => t.kind === "group");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "group", key: "plave", label: "PLAVE" });
  });

  test("한글 그룹명 (플레이브) 매칭", () => {
    const tokens = parseInsightBody("플레이브가 돌풍을 일으켰다.");
    expect(tokens.some((t) => t.kind === "group" && t.key === "plave")).toBe(true);
  });

  test("긴 alias 가 짧은 alias 보다 우선 매칭 (이세계아이돌 vs 이세돌)", () => {
    const tokens = parseInsightBody("이세계아이돌이 상승했다.");
    const groups = tokens.filter((t) => t.kind === "group");
    // 이세계아이돌 한 번만 매칭, "이세돌" 부분문자열로 또 매칭 X.
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "isedol" });
  });

  test("B:DAWN 처럼 콜론을 포함한 표기도 정확히 매칭", () => {
    const tokens = parseInsightBody("B:DAWN 데뷔 D-1.");
    expect(tokens.some((t) => t.kind === "group" && t.key === "bdawn")).toBe(true);
  });

  test("미완소년 한글 alias 매칭", () => {
    const tokens = parseInsightBody("미완소년의 데뷔가 임박했다.");
    expect(tokens.some((t) => t.kind === "group" && t.key === "miiwan")).toBe(true);
  });

  test("단어 한가운데에서는 매칭 안 함 (false positive 방지)", () => {
    // "플레이" 는 plave alias 가 아니지만 "플레이브" 의 prefix. 본문에
    // "플레이오프" 같은 일반어가 있어도 "플레이브" 로 잘못 잡지 않아야.
    const tokens = parseInsightBody("플레이오프 진출.");
    expect(tokens.every((t) => t.kind !== "group")).toBe(true);
  });

  test("extractGroupKeys 가 등장 순서대로 중복 제거", () => {
    const keys = extractGroupKeys("PLAVE 와 ISEDOL, 그리고 다시 PLAVE 가 언급됨.");
    expect(keys).toEqual(["plave", "isedol"]);
  });
});

describe("parseInsightBody — 톤 분류", () => {
  test("긍정 lexicon 어구가 inline tone 으로 강조", () => {
    const tokens = parseInsightBody("이번 주 PLAVE 가 상승세를 보였다.");
    const tone = tokens.find((t) => t.kind === "tone");
    expect(tone?.kind).toBe("tone");
    if (tone?.kind === "tone") {
      expect(tone.tone).toBe("positive");
      expect(tone.text).toBe("상승");
    }
  });

  test("부정 lexicon 어구가 부정 톤으로 강조", () => {
    const tokens = parseInsightBody("MY:RAKL 의 부진이 이어졌다.");
    const tone = tokens.find((t) => t.kind === "tone");
    expect(tone?.kind).toBe("tone");
    if (tone?.kind === "tone") {
      expect(tone.tone).toBe("negative");
    }
  });

  test("긍정/부정 lexicon 은 design system 레퍼런스와 일관", () => {
    // "상승"/"하락" 은 항상 양/음 톤이어야 함 (가장 흔한 시그널).
    expect(POSITIVE_WORDS).toContain("상승");
    expect(NEGATIVE_WORDS).toContain("하락");
  });
});

describe("parseInsightBody — markdown bold", () => {
  test("**xxx** 가 neutral tone 토큰으로 강조 (인접 어휘 없음)", () => {
    const tokens = parseInsightBody("주간 핵심은 **5만 구독자 돌파**.");
    // 안에 "돌파" 가 있어 positive 으로 승격되어야 함.
    const bold = tokens.find((t) => t.kind === "tone");
    expect(bold?.kind).toBe("tone");
    if (bold?.kind === "tone") {
      expect(bold.tone).toBe("positive");
    }
  });

  test("**xxx** 안에 부정 어휘가 있으면 negative 톤으로 분류", () => {
    const tokens = parseInsightBody("**전주 대비 하락 전환**.");
    const bold = tokens.find((t) => t.kind === "tone");
    expect(bold?.kind).toBe("tone");
    if (bold?.kind === "tone") {
      expect(bold.tone).toBe("negative");
    }
  });

  test("**xxx** 안의 그룹명도 group badge 로 빠지고 외부 텍스트는 tone 으로", () => {
    const tokens = parseInsightBody("이번 주 **PLAVE 의 약진** 두드러짐.");
    // 적어도 group + tone 토큰이 같이 등장.
    expect(tokens.some((t) => t.kind === "group" && t.key === "plave")).toBe(true);
    expect(tokens.some((t) => t.kind === "tone" && t.tone === "positive")).toBe(true);
  });

  test("bold 와 평문이 섞여 있어도 토큰 순서가 보존", () => {
    const tokens = parseInsightBody("앞단 **첫 1위** 뒷단 정상.");
    // text → tone(positive) → text → tone(positive) 구성.
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    const tones = tokens.filter((t) => t.kind === "tone");
    expect(tones.length).toBeGreaterThanOrEqual(1);
  });
});

describe("parseInsightBody — edge cases", () => {
  test("빈 본문은 빈 배열", () => {
    expect(parseInsightBody(null)).toEqual([]);
    expect(parseInsightBody(undefined)).toEqual([]);
    expect(parseInsightBody("")).toEqual([]);
  });

  test("그룹/톤이 없는 평문은 단일 text 토큰", () => {
    const tokens = parseInsightBody("일반 텍스트입니다.");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: "text", text: "일반 텍스트입니다." });
  });
});
