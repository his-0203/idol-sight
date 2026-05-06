// frontend/src/components/GroupBadge.tsx
//
// 그룹별 색상 점 + 라벨로 구성된 작은 인라인 뱃지. InsightBody 가 본문
// 안의 그룹 alias 를 만나면 이 컴포넌트로 대체해 시각 일관성을 준다.
// 카드 헤더 / 코호트 표 등 다른 곳에서도 재사용 가능하도록 size 옵션
// (sm/md) 만 받는 단순한 prop API 로 유지.
//
// Tailwind v3 의 임의 색상 클래스는 빌드 타임 처리이므로 그룹별 hex 는
// inline style 로 직접 주입한다 (ChartConfig 와 동일한 패턴, 카드 좌측
// accent bar 와 색이 일치하게 된다).

import { colorOf } from "../design/groups";

export type GroupBadgeProps = {
  /** 그룹 키 ("plave" 등). 알 수 없는 키는 zinc fallback. */
  groupKey: string | null | undefined;
  /** 표시 라벨. 미지정 시 groupKey 를 그대로 사용. */
  label?: string;
  /** sm: 본문 인라인용 (text-[11px]), md: 카드 헤더용 (text-xs) */
  size?: "sm" | "md";
  /** 추가 클래스 (외부 spacing 등). */
  class?: string;
};

export function GroupBadge(props: GroupBadgeProps) {
  const { groupKey, label, size = "sm" } = props;
  const color = colorOf(groupKey ?? null);
  const text = label ?? groupKey ?? "—";
  const sizeCls = size === "md"
    ? "text-xs px-1.5 py-0.5 gap-1.5"
    : "text-[11px] px-1 py-[1px] gap-1";
  return (
    <span
      class={
        "inline-flex items-center rounded-full border align-baseline tabular-nums " +
        sizeCls + " " + (props.class ?? "")
      }
      style={{ borderColor: `${color}55`, backgroundColor: `${color}14`, color: color }}
    >
      <span
        class="inline-block rounded-full"
        style={{
          width: size === "md" ? "8px" : "6px",
          height: size === "md" ? "8px" : "6px",
          backgroundColor: color,
        }}
      />
      <span class="font-medium leading-none">{text}</span>
    </span>
  );
}
