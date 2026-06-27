// frontend/src/components/InsightCard.tsx
//
// 공유 인사이트 카드 렌더러.  Insights.tsx / WeeklyUpdate.tsx 양쪽에서
// 쓰이던 near-identical 마크업을 단일 컴포넌트로 추출 (R2#1/#5).
//
// 데이터 정규화는 caller 책임:
//   - source_refs_json (string) vs source_refs (array) 차이는 caller 가
//     파싱해서 `sourceRefs: RawRef[]` 로 통일해서 넘긴다.
//   - date 표시 문자열 (week_start, formatKSTDate 조합 등) 도 caller 가
//     `dateDisplay` 로 넘긴다. 미지정 시 insight.week_start 를 사용.
//
// Props:
//   insight       — 정규화된 인사이트 필드 (id/type/scope/title/body/…)
//   sourceRefs    — caller-normalized RawRef 배열
//   dateDisplay   — 날짜 표시 문자열 (선택)
//   isNew         — NEW 뱃지 (ml-auto, Insights 뷰)
//   showInterim   — 중간점검 뱃지 (report_kind==="interim" 칸)
//   showTimestamp — generated_at 를 ml-auto 타임스탬프로 표시 (WeeklyUpdate 뷰)
//   isOwn         — 자사 MiiWAN 카드: accent bar 를 #75d7d1 으로 강제

import { DataSourceDetails, type RawRef } from "./Tooltip";
import { InsightBody } from "./InsightBody";
import { GroupBadge } from "./GroupBadge";
import {
  extractGroupKeys,
  humanizeInsightText,
  TYPE_LABEL,
} from "../lib/insightFormat";
import { colorOf } from "../design/groups";
import type { GroupKey } from "../design/groups";
import { formatKST } from "../lib/datetime";

export type InsightCardData = {
  id: string | number;
  type?: string | null;
  scope?: string | null;
  title?: string | null;
  body?: string | null;
  ai_comment?: string | null;
  generated_at?: string | null;
  week_start?: string | null;
  report_kind?: string | null;
};

export type InsightCardProps = {
  insight: InsightCardData;
  sourceRefs: RawRef[];
  /** Pre-computed date label. Falls back to insight.week_start if absent. */
  dateDisplay?: string;
  /** Show NEW badge (ml-auto). */
  isNew?: boolean;
  /** Show 중간점검 badge. */
  showInterim?: boolean;
  /** Show generated_at as a right-aligned timestamp (WeeklyUpdate variant). */
  showTimestamp?: boolean;
  /** 자사 (MiiWAN) 카드: accent bar 를 #75d7d1 (#miiwan) 으로 강제. */
  isOwn?: boolean;
};

export function InsightCard({
  insight,
  sourceRefs,
  dateDisplay,
  isNew,
  showInterim,
  showTimestamp,
  isOwn,
}: InsightCardProps) {
  const bodyGroups = extractGroupKeys(insight.body);
  // isOwn 카드: accent bar 를 항상 miiwan 색(#75d7d1)으로 고정.
  const accentKey: GroupKey | null = isOwn
    ? "miiwan"
    : (bodyGroups[0] ?? null);

  const displayDate = dateDisplay ?? insight.week_start ?? null;

  return (
    <li
      class={
        "rounded-lg border bg-zinc-900/30 px-3 py-2.5 border-l-4 " +
        (isNew ? "border-emerald-500/40 bg-emerald-500/5" : "border-zinc-800")
      }
      style={{ borderLeftColor: colorOf(accentKey) }}
    >
      {/* 1) 상단 라인 — 그룹 뱃지 + scope/type 칩 + date + NEW/timestamp */}
      <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
        {bodyGroups.slice(0, 3).map((k) => (
          <GroupBadge key={k} groupKey={k} size="sm" />
        ))}
        <span class="rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] uppercase tracking-wider text-zinc-400">
          {TYPE_LABEL[insight.type ?? ""] ?? insight.type ?? "weekly"}
        </span>
        {showInterim && (
          <span class="rounded bg-amber-500/15 px-1.5 py-[1px] text-[10px] tracking-wider text-amber-300">
            중간점검
          </span>
        )}
        <span class="text-zinc-600">·</span>
        <span>{insight.scope}</span>
        {displayDate && (
          <>
            <span class="text-zinc-600">·</span>
            <span
              class="tabular-nums"
              title={insight.generated_at ? formatKST(insight.generated_at) : undefined}
            >
              {displayDate}
            </span>
          </>
        )}
        {isNew && (
          <span class="ml-auto rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-[1px] text-[10px] uppercase tracking-wider text-emerald-300">
            NEW
          </span>
        )}
        {showTimestamp && insight.generated_at && (
          <span
            class="ml-auto text-[10px] text-zinc-500 tabular-nums"
            title={formatKST(insight.generated_at)}
          >
            {formatKST(insight.generated_at)}
          </span>
        )}
      </div>

      {/* 2) Title */}
      <div class="mt-1 text-base font-semibold tracking-tight text-zinc-100">
        {humanizeInsightText(insight.title)}
      </div>

      {/* 3) Body — 그룹 뱃지/톤 강조 포함 */}
      <InsightBody
        body={insight.body}
        class="mt-1 block text-sm leading-relaxed text-zinc-400"
      />

      {/* 4) AI 코멘트 — 옅은 배경 / 인용구 */}
      {insight.ai_comment && (
        <div class="mt-2 rounded border-l-2 border-violet-500/40 bg-violet-500/5 px-2 py-1 text-[12px] italic text-zinc-300">
          <span class="not-italic mr-1 rounded bg-violet-500/15 px-1 py-[1px] text-[9px] uppercase tracking-wider text-violet-300">
            AI
          </span>
          {humanizeInsightText(insight.ai_comment)}
        </div>
      )}

      {/* 5) 메타/출처 — details 폴딩 */}
      <DataSourceDetails refs={sourceRefs} />
    </li>
  );
}
