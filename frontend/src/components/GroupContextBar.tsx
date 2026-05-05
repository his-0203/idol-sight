import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { writeState, type RouterState } from "../router";
import { colorOf } from "../design/groups";

// Sticky sub-header that surfaces "which group, which freshness, which view"
// at all times whenever the user is on a group-scope tab. Shows:
//   - group selector (with native <select> for keyboard a11y)
//   - debut D-day chip
//   - per-source freshness dots (YT / DC / Naver / Twitter)
//   - 4 group-scope tabs
//
// Hidden whenever the active tab is a market-scope tab.
const GROUP_TABS: Array<[RouterState["tab"], string]> = [
  ["content",   "그룹 상세"],
  ["members",   "멤버"],
  ["community", "커뮤니티"],
  ["risk",      "PR/리스크"],
];

const GROUP_TABS_SET = new Set(GROUP_TABS.map(([k]) => k));

// Map crawl_meta.job → display label. We collapse multi-stage jobs (e.g.
// "naver_news" + "naver_articles") under one source heading by prefix.
const SOURCES: Array<{ key: string; label: string; jobs: string[]; intervalH: number }> = [
  { key: "yt",      label: "YT",     jobs: ["youtube"],            intervalH: 6 },
  { key: "dc",      label: "DC",     jobs: ["dc", "dcinside"],     intervalH: 6 },
  { key: "naver",   label: "Naver",  jobs: ["naver"],              intervalH: 6 },
  { key: "twitter", label: "Twitter", jobs: ["twitter", "x"],      intervalH: 12 },
];

type Freshness = "fresh" | "stale" | "broken" | "unknown";

function classify(lastSuccessAt: string | null, intervalH: number): Freshness {
  if (!lastSuccessAt) return "unknown";
  const ageH = (Date.now() - Date.parse(lastSuccessAt)) / 3_600_000;
  if (!Number.isFinite(ageH)) return "unknown";
  if (ageH < intervalH * 1.5) return "fresh";
  if (ageH < intervalH * 4)   return "stale";
  return "broken";
}

const DOT: Record<Freshness, string> = {
  fresh:   "bg-emerald-500",
  stale:   "bg-amber-500",
  broken:  "bg-red-500",
  unknown: "bg-zinc-700",
};

function pickJob(byJob: Array<{ job: string; last_success_at: string | null }>, prefixes: string[]) {
  for (const prefix of prefixes) {
    const m = byJob.find((r) => r.job?.startsWith(prefix));
    if (m) return m;
  }
  return null;
}

function formatDday(debutDate: string | null): string | null {
  if (!debutDate) return null;
  const ms = Date.parse(debutDate) - Date.now();
  const days = Math.ceil(ms / 86_400_000);
  if (days > 0) return `D-${days}`;
  if (days === 0) return "D-DAY";
  return `D+${-days}`;
}

export function GroupContextBar({ state }: { state: RouterState }) {
  const [groups, setGroups] = useState<Array<{ key: string; name: string; name_kr: string; debut_date: string | null }>>([]);
  const [meta, setMeta] = useState<{ by_job: Array<{ job: string; last_success_at: string | null }> } | null>(null);

  useEffect(() => { api.groups().then((r) => setGroups(r.groups)).catch(() => {}); }, []);
  useEffect(() => { api.meta().then(setMeta).catch(() => {}); }, []);

  // The bar persists across BOTH group-scope and market-scope tabs so
  // the operator never loses sight of "which group am I focused on".
  // On market-scope tabs we hide the group-tab nav (those tabs only
  // make sense for a selected group) but keep the selector + freshness
  // dots + D-day chip visible. Previous behaviour returned null on
  // market-scope, which made the operator's group selection feel like
  // it had been silently dropped when toggling between Insights and
  // a group-scope view.
  const onGroupTab = GROUP_TABS_SET.has(state.tab);

  const current = groups.find((g) => g.key === state.group) ?? null;
  const dday = current ? formatDday(current.debut_date) : null;

  return (
    <div
      class="sticky top-0 z-30 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur"
      role="region"
      aria-label="그룹 컨텍스트"
    >
      <div class="mx-auto max-w-7xl px-4 py-2">
        <div class="flex flex-wrap items-center gap-2 text-data">
          {/* group selector */}
          <span
            class="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: colorOf(state.group) }}
            aria-hidden="true"
          />
          <select
            class="rounded-ctrl border border-zinc-700 bg-zinc-950 px-2 py-1 text-data
                   focus:border-brand focus:outline-none"
            value={state.group ?? ""}
            onChange={(e: any) => writeState({ group: e.currentTarget.value || null })}
            aria-label="그룹 선택"
          >
            <option value="">— 그룹 선택 —</option>
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.name} · {g.name_kr}
              </option>
            ))}
          </select>

          {dday && (
            <span class="chip" title={`데뷔일 ${current?.debut_date ?? ""}`}>
              데뷔 {dday}
            </span>
          )}

          {/* freshness dots */}
          {meta && (
            <div class="ml-1 flex items-center gap-2 text-hint text-zinc-500"
                 aria-label="데이터 신선도">
              {SOURCES.map((s) => {
                const job = pickJob(meta.by_job, s.jobs);
                const f = classify(job?.last_success_at ?? null, s.intervalH);
                const ageH = job?.last_success_at
                  ? (Date.now() - Date.parse(job.last_success_at)) / 3_600_000
                  : null;
                const ageText = ageH == null
                  ? "갱신 정보 없음"
                  : ageH < 1 ? `${Math.round(ageH * 60)}분 전`
                  : ageH < 48 ? `${Math.round(ageH)}시간 전`
                  : `${Math.round(ageH / 24)}일 전`;
                return (
                  <span key={s.key} class="inline-flex items-center gap-1"
                        title={`${s.label} · ${ageText}`}>
                    <span class={`inline-block h-2 w-2 rounded-full ${DOT[f]}`} aria-hidden="true" />
                    {s.label}
                  </span>
                );
              })}
            </div>
          )}

          {/* group-scope tabs — only meaningful when one of these tabs is
              active. On market-scope tabs we suppress the nav (the tabs
              would imply navigation into group-scope, which Header
              already provides) but keep the rest of the bar so the
              user's "current group" context persists. */}
          {onGroupTab && (
            <nav class="ml-auto flex gap-1 overflow-x-auto" aria-label="그룹">
              {GROUP_TABS.map(([k, label]) => (
                <button
                  key={k}
                  class={
                    "rounded-ctrl px-3 py-1 transition-colors " +
                    (state.tab === k
                      ? "bg-brand-weak text-brand-fg"
                      : "text-zinc-400 hover:bg-zinc-800/60")
                  }
                  onClick={() => writeState({ tab: k })}
                >{label}</button>
              ))}
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
