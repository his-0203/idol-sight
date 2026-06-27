// frontend/src/views/Insights.tsx
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import type { RawRef } from "../components/Tooltip";
import { formatKSTDate } from "../lib/datetime";
import { InsightCard } from "../components/InsightCard";
import { extractGroupKeys, TYPE_LABEL } from "../lib/insightFormat";

const STORAGE_KEY = "idol-sight.insights.lastSeen";

export function Insights() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
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
    }).catch((e) => setErr(String(e)));
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

  // 자사 우선 (R2#7): 본문에 "miiwan" 그룹 키가 포함된 항목을 상단 고정.
  const ownFiltered = useMemo(
    () => filtered.filter((i: any) => extractGroupKeys(i.body).includes("miiwan")),
    [filtered],
  );
  const otherFiltered = useMemo(
    () => filtered.filter((i: any) => !extractGroupKeys(i.body).includes("miiwan")),
    [filtered],
  );

  if (err) return <div class="text-rose-400">불러오기 실패: {err}</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;

  return (
    <div class="space-y-3">
      {/* 필터 바 — N건 카운트는 섹션 제목으로 이동 */}
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
      </div>

      {filtered.length === 0 && (
        <div class="text-zinc-500">조건에 맞는 인사이트 없음.</div>
      )}

      {/* 자사 섹션 */}
      {ownFiltered.length > 0 && (
        <section class="space-y-2">
          <p class="text-label text-own font-medium">자사 ({ownFiltered.length}건)</p>
          <ul class="space-y-2.5 text-sm">
            {ownFiltered.map((i: any) => {
              const isNew = !!(lastSeen && i.generated_at > lastSeen);
              return (
                <InsightCard
                  key={i.id}
                  insight={i}
                  sourceRefs={(i.source_refs ?? []) as RawRef[]}
                  dateDisplay={i.week_start ?? formatKSTDate(i.generated_at)}
                  isNew={isNew}
                  showInterim={i.report_kind === "interim"}
                  isOwn={true}
                />
              );
            })}
          </ul>
        </section>
      )}

      {/* 시장 섹션 */}
      {otherFiltered.length > 0 && (
        <section class="space-y-2">
          <p class="text-label text-zinc-500">
            {ownFiltered.length > 0 ? `시장 (${otherFiltered.length}건)` : `전체 (${otherFiltered.length}건)`}
          </p>
          <ul class="space-y-2.5 text-sm">
            {otherFiltered.map((i: any) => {
              const isNew = !!(lastSeen && i.generated_at > lastSeen);
              return (
                <InsightCard
                  key={i.id}
                  insight={i}
                  sourceRefs={(i.source_refs ?? []) as RawRef[]}
                  dateDisplay={i.week_start ?? formatKSTDate(i.generated_at)}
                  isNew={isNew}
                  showInterim={i.report_kind === "interim"}
                />
              );
            })}
          </ul>
        </section>
      )}
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
