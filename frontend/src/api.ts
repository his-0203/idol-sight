async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "include" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

// /api/groups는 그룹 목록(거의 불변) — 세션 1회 페치 후 캐시(GroupSwitcher·Breadcrumb 공유).
let _groupsCache: Promise<any> | null = null;
const _groupCache = new Map<string, Promise<any>>();

export const api = {
  meta:        () => getJson<any>("/api/meta"),
  groups:      () => getJson<any>("/api/groups"),
  groupsCached: () => (_groupsCache ||= getJson<any>("/api/groups")
    .catch((e) => { _groupsCache = null; throw e; })),   // 실패 시 캐시 비워 다음 호출에 재시도
  market:      () => getJson<any>("/api/market"),
  marketShare: (weeks = 13) => getJson<any>(`/api/market-share?weeks=${weeks}`),
  group:       (k: string) => getJson<any>(`/api/group/${encodeURIComponent(k)}`),
  // 그룹 상세는 content/community/risk 탭이 공유 — 탭 전환 시 같은 그룹 재페치를
  // 막으려 per-key 프로미스 캐시(실패 시 해당 키만 비워 재시도).
  groupCached: (k: string): Promise<any> =>
    (_groupCache.get(k) ?? (() => {
      const p = getJson<any>(`/api/group/${encodeURIComponent(k)}`)
        .catch((e) => { _groupCache.delete(k); throw e; });
      _groupCache.set(k, p);
      return p;
    })()),
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
  monthlyReports: () => getJson<{
    reports: Array<{ month: string; generated_at: string; size_bytes: number }>;
  }>("/api/monthly-report?list=1"),
  shortsTrend: () => getJson<any>("/api/shorts-trend"),
  insights:    (week?: string) =>
    getJson<any>("/api/insights" + (week ? `?week=${encodeURIComponent(week)}` : "")),
  miiwan:      () => getJson<any>("/api/miiwan"),
  miiwanLiveChat: (videoId?: string) =>
    getJson<any>("/api/miiwan-live-chat" +
      (videoId ? `?video_id=${encodeURIComponent(videoId)}` : "")),
  miiwanCohort: () => getJson<any>("/api/miiwan-cohort"),
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
  adminStatus: () => getJson<any>("/api/admin/status"),
  // Debut Window API — row 타입은 caller (KPI / CompetitorOrganicityBar /
  // DebutWindowVideoTable) 가 자체 interface 로 정의 → generic T 노출.
  debutWindowSummary: <T = unknown>(bucket?: string): Promise<{
    rows: T[];
    // V2.49: 롤링 창 메타 — 표시 버킷 리스트 + 오늘(anchor 기준) 버킷.
    window?: { buckets: string[]; current_bucket: string };
  }> =>
    getJson<{
      rows: T[];
      window?: { buckets: string[]; current_bucket: string };
    }>(
      "/api/debut-window/summary"
      + (bucket ? `?bucket=${encodeURIComponent(bucket)}` : ""),
    ),
  growthTrajectory: <T = unknown>(group: string): Promise<T> =>
    getJson<T>(`/api/growth-trajectory?group=${encodeURIComponent(group)}`),
  debutWindowVideos: <T = unknown>(
    group: string,
    bucket: string,
    type: "all" | "long" | "short" = "all",
  ): Promise<{ group: string; bucket: string; type: string; rows: T[] }> =>
    getJson<{ group: string; bucket: string; type: string; rows: T[] }>(
      `/api/debut-window/videos?group=${encodeURIComponent(group)}`
      + `&bucket=${encodeURIComponent(bucket)}&type=${type}`,
    ),
  debutWindowVideosAll: <T = unknown>(
    group: string,
    offset: number,
    limit: number,
    type: "all" | "long" | "short" = "all",
  ): Promise<{
    group: string;
    type: string;
    total?: number;     // V3.x: backend 가 offset===0 일 때만 COUNT 실행
    offset: number;
    limit: number;
    rows: T[];
  }> =>
    getJson<{
      group: string;
      type: string;
      total?: number;
      offset: number;
      limit: number;
      rows: T[];
    }>(
      `/api/debut-window/videos-all?group=${encodeURIComponent(group)}`
      + `&offset=${offset}&limit=${limit}&type=${type}`,
    ),
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
