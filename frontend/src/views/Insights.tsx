// frontend/src/views/Insights.tsx
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { DataSourceDetails, type RawRef } from "../components/Tooltip";
import { formatKST, formatKSTDate } from "../lib/datetime";

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

      <ul class="space-y-2 text-sm">
        {filtered.map((i: any) => {
          const isNew = lastSeen && i.generated_at > lastSeen;
          return (
            <li
              key={i.id}
              class={"rounded-lg border p-3 " +
                (isNew
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : "border-zinc-800")}
            >
              <div class="flex items-center gap-2 text-xs text-zinc-500">
                <span>{i.scope}</span>
                <span>·</span>
                <span>{TYPE_LABEL[i.type] ?? i.type}</span>
                <span>·</span>
                <span title={i.generated_at ? formatKST(i.generated_at) : undefined}>
                  {i.week_start ?? formatKSTDate(i.generated_at)}
                </span>
                {isNew && (
                  <span class="ml-auto rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 text-emerald-400">NEW</span>
                )}
              </div>
              <div class="mt-1 font-semibold">{i.title}</div>
              <div class="mt-1 text-xs text-zinc-400">{i.body}</div>
              {i.ai_comment && (
                <div class="mt-1 text-[11px] italic text-zinc-400">
                  <span class="not-italic mr-1 rounded bg-violet-500/15 px-1 py-[1px] text-[9px] uppercase tracking-wider text-violet-300">AI</span>
                  {i.ai_comment}
                </div>
              )}
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
