// frontend/src/components/InsightBody.tsx
//
// LLM 인사이트 본문을 토큰 단위로 렌더한다. 평문은 그대로, 그룹 alias 는
// <GroupBadge> 로, markdown bold / 톤 lexicon 매칭은 색이 들어간 강조로
// 표시. 색은 design system 의 emerald(positive) / rose(negative) /
// zinc-bold(neutral) 한정.
//
// 사용처:
//   - WeeklyUpdate.tsx Weekly Insights 카드 본문
//   - Insights.tsx 인사이트 리스트 카드 본문
//   - MiiWANBriefing.tsx IPX 액션 / 전략 인사이트 본문
//
// 컴포넌트는 의도적으로 본문 1줄짜리 인라인 렌더만 책임진다 (제목/메타/
// AI 코멘트 박스는 caller 가 조립). 카드 outer 가 view 마다 미세하게
// 다르므로 통일하지 않고 재사용 부품만 공유한다.

import { parseInsightBody, type Tone } from "../lib/insightFormat";
import { GroupBadge } from "./GroupBadge";

const TONE_CLS: Record<Tone, string> = {
  // emerald: 다크모드 가독성 ≥ 4.5:1, 라이트모드도 충분.
  positive: "font-semibold text-emerald-300",
  // rose: 위기/하락 톤. red-* 보다 살짝 부드러운 rose 계열을 design
  //  system 다른 부정 표시와 일관 유지.
  negative: "font-semibold text-rose-300",
  // zinc-bold: 일반 강조 (수치/고유명사). 색 변화 없이 weight 만 ↑.
  neutral:  "font-semibold text-zinc-100",
};

export type InsightBodyProps = {
  body: string | null | undefined;
  /** 추가 wrapper 클래스 (text-xs, leading-relaxed 등 caller 지정). */
  class?: string;
};

export function InsightBody(props: InsightBodyProps) {
  const tokens = parseInsightBody(props.body);
  if (tokens.length === 0) return null;
  return (
    <span class={props.class}>
      {tokens.map((t, i) => {
        if (t.kind === "text") {
          return <span key={i}>{t.text}</span>;
        }
        if (t.kind === "group") {
          return (
            <GroupBadge
              key={i}
              groupKey={t.key}
              label={t.label}
              size="sm"
              class="mx-0.5"
            />
          );
        }
        // tone
        return (
          <span key={i} class={TONE_CLS[t.tone]}>
            {t.text}
          </span>
        );
      })}
    </span>
  );
}
