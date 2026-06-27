import { writeState } from "../router";

export function TopBar({ onMenu }: { onMenu?: () => void }) {
  return (
    <header class="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-zinc-800 bg-surface/95 px-4 backdrop-blur">
      <button class="md:hidden rounded-ctrl border border-zinc-800 px-2 py-1 text-zinc-400"
              onClick={onMenu} aria-label="메뉴 열기">☰</button>
      <button class="font-bold tracking-tight" onClick={() => writeState({ tab: "market", category: "all" })}
              title="홈 (시장 개요)">idol-sight</button>
      <span class="hidden sm:inline text-hint text-zinc-500">시장 인텔리전스 · 3사 사내</span>
      <div class="ml-auto flex items-center gap-2 text-data">
        <span class="flex items-center gap-1.5 rounded-ctrl border px-2.5 py-1"
              style={{ borderColor: "rgba(117,215,209,0.4)", background: "rgba(117,215,209,0.06)" }}>
          <span class="inline-block h-2 w-2 rounded-full" style={{ background: "#75d7d1" }}></span>
          관점: <b class="text-own">MiiWAN</b>
        </span>
        <button class="rounded-ctrl border border-zinc-800 px-2 py-1 text-zinc-400 hover:bg-zinc-800/60"
                onClick={() => window.dispatchEvent(new CustomEvent("idolsight:search-open"))}
                title="검색 (⌘K)">🔍 <span class="hidden md:inline">검색</span></button>
      </div>
    </header>
  );
}
