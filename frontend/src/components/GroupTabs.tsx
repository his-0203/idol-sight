import { useEffect, useState } from "preact/hooks";
import { onStateChange, readState, writeState, type RouterState } from "../router";
import { GroupSwitcher } from "./GroupSwitcher";

// 그룹 master-detail 헤더. 각 group-scope 뷰(GroupContent/Members/Community/
// PRRisk/GroupGrowth) 상단에 인라인 렌더 — GroupSwitcher(그룹 전환) + 하위 탭.
// MarketOverview로 되돌아가지 않고 그룹·하위탭을 모두 전환할 수 있게 한다.
//
// Reads/writes router state directly so callers don't need to thread
// `tab` through their props (each view just renders <GroupTabs />).
const GROUP_TABS: Array<[RouterState["tab"], string]> = [
  ["content",   "그룹 상세"],
  ["members",   "멤버"],
  ["community", "커뮤니티"],
  ["risk",      "PR/리스크"],
  ["growth",    "성장"],
];

export function GroupTabs() {
  const [state, setState] = useState(readState());
  useEffect(() => onStateChange(setState), []);

  // Defensive: if no group selected, render nothing — the parent view
  // will be showing its EmptyState ("그룹을 선택하세요") and the tabs
  // would all be no-ops without a group key in the URL.
  if (!state.group) return null;

  return (
    <div class="mb-3 border-b border-zinc-800 pb-2">
      {/* master-detail 그룹 헤더: 전환 셀렉터 + 하위 탭 */}
      <div class="mb-2 flex items-center gap-2">
        <GroupSwitcher />
        <span class="hidden sm:inline text-hint text-zinc-500">그룹 전환 · 하위 탭</span>
      </div>
      <nav class="flex gap-1 overflow-x-auto text-data" aria-label="그룹 컨텍스트 탭">
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
    </div>
  );
}
