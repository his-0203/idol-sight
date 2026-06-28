// frontend/src/views/Insights.tsx
import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import type { RawRef } from "../components/Tooltip";
import { formatKSTDate } from "../lib/datetime";
import { InsightCard } from "../components/InsightCard";
import { extractGroupKeys, TYPE_LABEL } from "../lib/insightFormat";

const STORAGE_KEY = "idol-sight.insights.lastSeen";
const OWN_ACCENT = "#75d7d1";
const MARKET_ACCENT = "#ABE3E4";

export function Insights() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [scopeFilter, setScopeFilter] = useState<string | null>(null);
  // 상단 탭(자사/시장). userPicked 전까지는 데이터 기반으로 자사→비면 시장 폴백.
  const [view, setView] = useState<"own" | "market">("own");
  const [userPicked, setUserPicked] = useState(false);
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

  // 자사 우선 (R2#7): 본문에 "miiwan" 그룹 키가 포함된 항목을 자사 탭으로.
  const ownFiltered = useMemo(
    () => filtered.filter((i: any) => extractGroupKeys(i.body).includes("miiwan")),
    [filtered],
  );
  const otherFiltered = useMemo(
    () => filtered.filter((i: any) => !extractGroupKeys(i.body).includes("miiwan")),
    [filtered],
  );

  // 활성 탭 — 사용자가 명시적으로 고르기 전엔 자사 우선, 자사 0건이면 시장으로.
  const activeView: "own" | "market" = userPicked
    ? view
    : (ownFiltered.length > 0 ? "own" : "market");
  const activeItems = activeView === "own" ? ownFiltered : otherFiltered;

  if (err) return <div class="text-rose-400">불러오기 실패: {err}</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;

  const pick = (v: "own" | "market") => { setView(v); setUserPicked(true); };

  return (
    <div class="space-y-3">
      {/* 상단 탭: 자사 / 시장 — 세로로 쌓지 않고 전환해 스크롤 줄임 */}
      <div role="tablist" aria-label="인사이트 범위" class="flex gap-1 card p-1">
        <ScopeTab
          active={activeView === "own"} accent={OWN_ACCENT}
          label="자사" count={ownFiltered.length} onClick={() => pick("own")}
        />
        <ScopeTab
          active={activeView === "market"} accent={MARKET_ACCENT}
          label="시장" count={otherFiltered.length} onClick={() => pick("market")}
        />
      </div>

      {/* 필터 바 — 선택된 탭 안에서 유형·범위로 좁힘 */}
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

      {activeItems.length === 0 ? (
        <div class="text-zinc-500">
          {activeView === "own" ? "조건에 맞는 자사 인사이트 없음." : "조건에 맞는 시장 인사이트 없음."}
        </div>
      ) : (
        <ul class="space-y-2.5 text-sm">
          {activeItems.map((i: any) => {
            const isNew = !!(lastSeen && i.generated_at > lastSeen);
            return (
              <InsightCard
                key={i.id}
                insight={i}
                sourceRefs={(i.source_refs ?? []) as RawRef[]}
                dateDisplay={i.week_start ?? formatKSTDate(i.generated_at)}
                isNew={isNew}
                showInterim={i.report_kind === "interim"}
                isOwn={activeView === "own"}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ScopeTab(
  { active, accent, label, count, onClick }:
  { active: boolean; accent: string; label: string; count: number; onClick: () => void },
) {
  return (
    <button
      type="button" role="tab" aria-selected={active}
      onClick={onClick}
      class={"flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition " +
        (active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200")}
      style={active ? { color: accent } : undefined}
    >
      {label} <span class="tabular-nums opacity-70">({count})</span>
    </button>
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
