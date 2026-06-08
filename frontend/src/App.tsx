import { useEffect, useState } from "preact/hooks";
import { Header } from "./components/Header";
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
      <Header state={state} />
      <SearchPalette />
      <Breadcrumb state={state} />
      <main class="mx-auto max-w-7xl p-4">
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
  );
}
