// frontend/src/views/Insights.tsx
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { DataSourceDetails, type RawRef } from "../components/Tooltip";
import { formatKST, formatKSTDate } from "../lib/datetime";
import { InsightBody } from "../components/InsightBody";
import { GroupBadge } from "../components/GroupBadge";
import { extractGroupKeys } from "../lib/insightFormat";
import { colorOf } from "../design/groups";

const TYPE_LABEL: Record<string, string> = {
  weekly: "주간",
  insight: "인사이트",
  ipx_action: "IPX 액션",
};

const STORAGE_KEY = "idol-sight.insights.lastSeen";

export function Insights() {
  const [data, setData] = useState<any>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<string | null>(null);
  const [lastSeen, setLastSeen] = useState<string | null>(() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  });

  useEffect(() => {
    api.insights().then((d) => {
      setData(d);
      // Persist the latest generated_at so the next visit can highlight new rows.
      const latest = d.insights?.[0]?.generated_at ?? null;
      if (latest) {
        try { localStorage.setItem(STORAGE_KEY, latest); } catch { /* ignore */ }
      }
    });
  }, []);

  const types = useMemo(() => {
    if (!data?.insights) return [];
    return Array.from(new Set<string>(data.insights.map((i: any) => i.type as string)));
  }, [data]);

  const scopes = useMemo(() => {
    if (!data?.insights) return [];
    return Array.from(new Set<string>(data.insights.map((i: any) => i.scope as string)));
  }, [data]);

  const filtered = useMemo(() => {
    if (!data?.insights) return [];
    return data.insights.filter((i: any) =>
      (typeFilter == null || i.type === typeFilter) &&
      (scopeFilter == null || i.scope === scopeFilter)
    );
  }, [data, typeFilter, scopeFilter]);

  if (!data) return <div class="text-zinc-500">Loading…</div>;

  return (
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="text-zinc-500">유형</span>
        <FilterChip active={typeFilter == null} onClick={() => setTypeFilter(null)}>전체</FilterChip>
        {types.map((t) => (
          <FilterChip key={t} active={typeFilter === t} onClick={() => setTypeFilter(t)}>
            {TYPE_LABEL[t] ?? t}
          </FilterChip>
        ))}

        <span class="ml-2 text-zinc-500">범위</span>
        <FilterChip active={scopeFilter == null} onClick={() => setScopeFilter(null)}>전체</FilterChip>
        {scopes.map((s) => (
          <FilterChip key={s} active={scopeFilter === s} onClick={() => setScopeFilter(s)}>
            {s}
          </FilterChip>
        ))}

        <span class="ml-auto text-xs text-zinc-500">{filtered.length}건</span>
      </div>

      <ul class="space-y-2.5 text-sm">
        {filtered.map((i: any) => {
          const isNew = lastSeen && i.generated_at > lastSeen;
          // 본문에서 검출된 그룹 → 좌측 accent bar 색 + 헤더 뱃지.
          const bodyGroups = extractGroupKeys(i.body);
          const accentKey = bodyGroups[0] ?? null;
          return (
            <li
              key={i.id}
              class={"rounded-lg border bg-zinc-900/30 px-3 py-2.5 border-l-4 " +
                (isNew ? "border-emerald-500/40 bg-emerald-500/5" : "border-zinc-800")}
              style={{ borderLeftColor: colorOf(accentKey) }}
            >
              {/* 1) 상단 라인 — 그룹 뱃지 + scope/type 칩 + KST + NEW */}
              <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                {bodyGroups.slice(0, 3).map((k) => (
                  <GroupBadge key={k} groupKey={k} size="sm" />
                ))}
                <span class="rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] uppercase tracking-wider text-zinc-400">
                  {TYPE_LABEL[i.type] ?? i.type}
                </span>
                <span class="text-zinc-600">·</span>
                <span>{i.scope}</span>
                <span class="text-zinc-600">·</span>
                <span
                  class="tabular-nums"
                  title={i.generated_at ? formatKST(i.generated_at) : undefined}
                >
                  {i.week_start ?? formatKSTDate(i.generated_at)}
                </span>
                {isNew && (
                  <span class="ml-auto rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-[1px] text-[10px] uppercase tracking-wider text-emerald-300">NEW</span>
                )}
              </div>
              {/* 2) Title */}
              <div class="mt-1 text-base font-semibold tracking-tight text-zinc-100">{i.title}</div>
              {/* 3) Body — 그룹 뱃지/톤 강조 포함 */}
              <InsightBody
                body={i.body}
                class="mt-1 block text-sm leading-relaxed text-zinc-400"
              />
              {/* 4) AI 코멘트 */}
              {i.ai_comment && (
                <div class="mt-2 rounded border-l-2 border-violet-500/40 bg-violet-500/5 px-2 py-1 text-[12px] italic text-zinc-300">
                  <span class="not-italic mr-1 rounded bg-violet-500/15 px-1 py-[1px] text-[9px] uppercase tracking-wider text-violet-300">AI</span>
                  {i.ai_comment}
                </div>
              )}
              {/* 5) 메타/출처 */}
              <DataSourceDetails refs={(i.source_refs ?? []) as RawRef[]} />
            </li>
          );
        })}
      </ul>
      {filtered.length === 0 && <div class="text-zinc-500">조건에 맞는 인사이트 없음.</div>}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      onClick={onClick}
      class={"rounded-md border px-2.5 py-1 text-xs transition-colors " +
        (active
          ? "border-violet-500 bg-violet-500/10 text-violet-300"
          : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
    >{children}</button>
  );
}
