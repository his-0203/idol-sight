async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "include" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

export const api = {
  meta:        () => getJson<any>("/api/meta"),
  groups:      () => getJson<any>("/api/groups"),
  market:      () => getJson<any>("/api/market"),
  marketShare: (weeks = 13) => getJson<any>(`/api/market-share?weeks=${weeks}`),
  group:       (k: string) => getJson<any>(`/api/group/${encodeURIComponent(k)}`),
  members:     (k: string) => getJson<any>(`/api/members/${encodeURIComponent(k)}`),
  melonHistory: (
    k: string,
    opts: { days?: number; type?: "daily" | "top100";
            anchor?: "lookback" | "release"; window?: number } = {},
  ) => {
    const qs = new URLSearchParams();
    qs.set("type", opts.type ?? "daily");
    qs.set("anchor", opts.anchor ?? "lookback");
    if ((opts.anchor ?? "lookback") === "release") {
      qs.set("window", String(opts.window ?? 90));
    } else {
      qs.set("days", String(opts.days ?? 30));
    }
    return getJson<any>(`/api/melon/${encodeURIComponent(k)}?${qs}`);
  },
  weekly:      () => getJson<any>("/api/weekly"),
  insights:    (week?: string) =>
    getJson<any>("/api/insights" + (week ? `?week=${encodeURIComponent(week)}` : "")),
  miiwan:      () => getJson<any>("/api/miiwan"),
  debutCurve:  (metric = "yt_subscribers", from = -60, to = 180) =>
    getJson<any>(`/api/debut-curve?metric=${encodeURIComponent(metric)}&from=${from}&to=${to}`),
  groupEvents: (group?: string, from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (group) qs.set("group", group);
    if (from)  qs.set("from", from);
    if (to)    qs.set("to", to);
    const q = qs.toString();
    return getJson<any>("/api/group-events" + (q ? `?${q}` : ""));
  },
  search:      (q: string) => getJson<any>(`/api/search?q=${encodeURIComponent(q)}`),
  healthSpec:  () => getJson<any>("/api/health/spec"),
  debutWindowSummary: (bucket?: string) =>
    getJson<any>("/api/debut-window/summary" + (bucket ? `?bucket=${encodeURIComponent(bucket)}` : "")),
  debutWindowVideos: (group: string, bucket: string, type: "all" | "long" | "short" = "all") =>
    getJson<any>(`/api/debut-window/videos?group=${encodeURIComponent(group)}&bucket=${encodeURIComponent(bucket)}&type=${type}`),
  flagIrrelevant: async (payload: { url_hash?: string; url?: string; group_key: string; reason?: string }) => {
    const r = await fetch("/api/relevance-feedback", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`/api/relevance-feedback: ${r.status}`);
    return r.json();
  },
};
