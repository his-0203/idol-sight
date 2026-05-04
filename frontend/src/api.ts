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
  search:      (q: string) => getJson<any>(`/api/search?q=${encodeURIComponent(q)}`),
  healthSpec:  () => getJson<any>("/api/health/spec"),
};
