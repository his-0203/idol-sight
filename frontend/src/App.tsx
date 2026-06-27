import { useEffect, useState } from "preact/hooks";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Breadcrumb } from "./components/Breadcrumb";
import { LoginGate } from "./components/LoginGate";
import { applyTheme } from "./theme";
import { onStateChange, readState } from "./router";
import { api } from "./api";
import { MarketOverview } from "./views/MarketOverview";
import { WeeklyUpdate } from "./views/WeeklyUpdate";
import { GroupContent } from "./views/GroupContent";
import { Members } from "./views/Members";
import { Community } from "./views/Community";
import { PRRisk } from "./views/PRRisk";
import { GroupGrowth } from "./views/GroupGrowth";
import { Insights } from "./views/Insights";
import { MiiWANBriefing } from "./views/MiiWANBriefing";
import { ShortsTrend } from "./views/ShortsTrend";
import { SystemStatus } from "./views/SystemStatus";
import { SearchPalette } from "./components/SearchPalette";

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [state, setState] = useState(readState());
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => { applyTheme(); }, []);
  useEffect(() => onStateChange(setState), []);

  // Liveness check: hit /api/meta. If 401 → show login gate.
  useEffect(() => {
    api.meta().then(() => setAuthed(true)).catch((e) => {
      if (String(e).includes("401")) setAuthed(false);
      else setAuthed(true);   // network/other → show app, individual views handle errors
    });
  }, []);

  if (authed === null) return <div class="p-8 text-zinc-500">Loading…</div>;
  if (authed === false) return <LoginGate />;

  return (
    <div class="min-h-screen">
      <TopBar onMenu={() => setNavOpen(true)} />
      <SearchPalette />
      <div class="flex">
        {/* desktop sidebar */}
        <aside class="hidden md:block shrink-0 border-r border-zinc-800 min-h-[calc(100vh-3rem)] sticky top-12 self-start">
          <Sidebar state={state} />
        </aside>
        {/* mobile overlay sidebar */}
        {navOpen && (
          <div class="md:hidden fixed inset-0 z-30 flex" onClick={() => setNavOpen(false)}>
            <div class="absolute inset-0 bg-black/50"></div>
            <aside class="relative z-10 bg-surface border-r border-zinc-800 min-h-screen"
                   onClick={(e) => e.stopPropagation()}>
              <Sidebar state={state} onNavigate={() => setNavOpen(false)} />
            </aside>
          </div>
        )}
        <main class="flex-1 min-w-0 p-4">
          <Breadcrumb state={state} />
          {state.tab === "market"    && <MarketOverview />}
          {state.tab === "weekly"    && <WeeklyUpdate />}
          {state.tab === "content"   && <GroupContent groupKey={state.group} />}
          {state.tab === "members"   && <Members groupKey={state.group} />}
          {state.tab === "community" && <Community groupKey={state.group} period={state.period} />}
          {state.tab === "risk"      && <PRRisk groupKey={state.group} />}
          {state.tab === "growth"    && <GroupGrowth groupKey={state.group} />}
          {state.tab === "insights"  && <Insights />}
          {state.tab === "miiwan"    && <MiiWANBriefing />}
          {state.tab === "shorts"    && <ShortsTrend />}
          {state.tab === "status"    && <SystemStatus />}
        </main>
      </div>
    </div>
  );
}
