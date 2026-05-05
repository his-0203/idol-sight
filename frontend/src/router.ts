export interface RouterState {
  tab: "market" | "weekly" | "content" | "members" | "community" | "risk" | "insights" | "miiwan";
  group: string | null;
  period: number | null;        // days; null = all
  theme: "dark" | "light";
}

const DEFAULT: RouterState = {
  tab: "market", group: null, period: 7, theme: "dark",
};

export function readState(): RouterState {
  const params = new URLSearchParams(location.hash.slice(1));
  return {
    tab: (params.get("tab") as RouterState["tab"]) || DEFAULT.tab,
    group: params.get("group"),
    period: params.get("period") != null
      ? (params.get("period") === "0" ? null : Number(params.get("period")))
      : DEFAULT.period,
    theme: (params.get("theme") as RouterState["theme"]) || DEFAULT.theme,
  };
}

export function writeState(patch: Partial<RouterState>): void {
  const cur = readState();
  const next = { ...cur, ...patch };
  const params = new URLSearchParams();
  params.set("tab", next.tab);
  if (next.group) params.set("group", next.group);
  if (next.period == null) params.set("period", "0");
  else if (next.period !== DEFAULT.period) params.set("period", String(next.period));
  if (next.theme !== "dark") params.set("theme", next.theme);
  location.hash = "#" + params.toString();
}

export function onStateChange(handler: (s: RouterState) => void): () => void {
  const fn = () => handler(readState());
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
}
