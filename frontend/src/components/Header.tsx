import { writeState, type RouterState } from "../router";

// Market-scope tabs only. Group-scope tabs (그룹 상세/멤버/커뮤니티/PR·리스크)
// are entered via the MarketOverview group cards or the SearchPalette;
// the group-context sub-bar has been removed.
//
// MiiWAN gets a dedicated GNB slot — IPX/Abyss build it together, so the
// team needs an own-brand briefing view next to the cross-market tabs
// rather than buried inside the generic group-detail flow.
const MARKET_TABS: Array<[RouterState["tab"], string]> = [
  ["market",   "시장 개요"],
  ["weekly",   "주간 업데이트"],
  ["insights", "인사이트"],
  ["miiwan",   "MiiWAN"],
];

const GROUP_TABS_SET = new Set(["content", "members", "community", "risk"]);

export function Header({ state }: { state: RouterState }) {
  const onMarketTab = !GROUP_TABS_SET.has(state.tab);
  return (
    <header class="border-b border-zinc-800 px-4 py-3">
      <div class="mx-auto flex max-w-7xl items-center gap-4">
        <button
          class="text-xl font-bold tracking-tight"
          onClick={() => writeState({ tab: "market" })}
          title="홈 (시장 개요)"
        >
          MiiWAN<span class="text-brand-fg"> Orbit</span>
        </button>
        <nav class="flex gap-1 overflow-x-auto text-data" aria-label="시장">
          {MARKET_TABS.map(([k, label]) => (
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
        {!onMarketTab && (
          <span class="hidden md:inline text-hint text-zinc-500">
            그룹 모드
          </span>
        )}
        {/* Light-mode toggle disabled in Phase 1 — most components still
            hard-code zinc shades. Reactivate once tokens cover all surfaces. */}
        <button
          class="ml-auto rounded-ctrl border border-zinc-800 px-2 py-1 text-hint
                 text-zinc-600 cursor-not-allowed opacity-60"
          disabled
          title="다크 전용 (라이트 모드는 Phase 2 예정)"
          aria-label="라이트 모드는 곧 지원됩니다"
        >🌙</button>
      </div>
    </header>
  );
}
