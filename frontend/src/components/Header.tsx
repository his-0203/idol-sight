import { writeState, type RouterState } from "../router";
import { toggleTheme } from "../theme";

const TABS: Array<[RouterState["tab"], string]> = [
  ["market", "Market Overview"],
  ["weekly", "Weekly Update"],
  ["content", "Group Content"],
  ["members", "Member View"],
  ["community", "Community"],
  ["risk", "PR & Risk"],
  ["insights", "Insights"],
];

export function Header({ state }: { state: RouterState }) {
  return (
    <header class="border-b border-zinc-800 px-4 py-3 [.light_&]:border-zinc-200">
      <div class="mx-auto flex max-w-7xl items-center gap-4">
        <h1 class="text-xl font-bold tracking-tight">
          IDOL<span class="text-violet-400">-SIGHT</span>
        </h1>
        <nav class="flex gap-1 overflow-x-auto text-sm">
          {TABS.map(([k, label]) => (
            <button
              class={
                "rounded px-3 py-1 transition-colors " +
                (state.tab === k
                  ? "bg-violet-500/20 text-violet-300"
                  : "text-zinc-400 hover:bg-zinc-800/60")
              }
              onClick={() => writeState({ tab: k })}
            >{label}</button>
          ))}
        </nav>
        <button
          class="ml-auto rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
          onClick={() => toggleTheme()}
          title="Theme"
        >{state.theme === "dark" ? "🌙" : "☀️"}</button>
      </div>
    </header>
  );
}
