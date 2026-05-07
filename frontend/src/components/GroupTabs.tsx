import { useEffect, useState } from "preact/hooks";
import { onStateChange, readState, writeState, type RouterState } from "../router";

// Group-scope tab navigation. Renders inline at the top of each group-
// scope view (GroupContent / Members / Community / PRRisk) so the user
// can switch context without going back through MarketOverview.
//
// History: V2.5 had GroupContextBar.tsx which rendered these tabs in a
// sticky sub-header above all views. That component was deleted in
// commit 0747673 (MiiWAN Orbit rebrand), and the comment in Header.tsx
// claimed group entry would be "via MarketOverview cards or
// SearchPalette" — true for first entry, but there was no way to switch
// between content/members/community/risk once on a group page. This
// component restores switching without bringing back the heavy sticky
// bar.
//
// Reads/writes router state directly so callers don't need to thread
// `tab` through their props.
const GROUP_TABS: Array<[RouterState["tab"], string]> = [
  ["content",   "그룹 상세"],
  ["members",   "멤버"],
  ["community", "커뮤니티"],
  ["risk",      "PR/리스크"],
];

export function GroupTabs() {
  const [state, setState] = useState(readState());
  useEffect(() => onStateChange(setState), []);

  // Defensive: if no group selected, render nothing — the parent view
  // will be showing its EmptyState ("그룹을 선택하세요") and the tabs
  // would all be no-ops without a group key in the URL.
  if (!state.group) return null;

  return (
    <nav
      class="mb-3 flex gap-1 overflow-x-auto border-b border-zinc-800 pb-2 text-data"
      aria-label="그룹 컨텍스트 탭"
    >
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
          aria-current={state.tab === k ? "page" : undefined}
        >{label}</button>
      ))}
    </nav>
  );
}
