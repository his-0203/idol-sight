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
  weekly:      () => getJson<any>("/api/weekly"),
  insights:    (week?: string) =>
    getJson<any>("/api/insights" + (week ? `?week=${encodeURIComponent(week)}` : "")),
  miiwan:      () => getJson<any>("/api/miiwan"),
  debutCurve:  (metric = "yt_subscribers", from = -60, to = 180) =>
    getJson<any>(`/api/debut-curve?metric=${encodeURIComponent(metric)}&from=${from}&to=${to}`),
  externalCohort: () => getJson<any>("/api/external-cohort"),
  search:      (q: string) => getJson<any>(`/api/search?q=${encodeURIComponent(q)}`),
  healthSpec:  () => getJson<any>("/api/health/spec"),
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
