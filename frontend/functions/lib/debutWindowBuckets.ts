// frontend/functions/lib/debutWindowBuckets.ts
//
// V3 (2026-05-25): frontend 5 탭 ↔ worker 9 bucket union 매핑 (single source
// of truth). videos.ts / summary.ts 양쪽에서 공유.
//
// Worker WINDOW_BUCKETS (analysis/debut_window.py) 는 V2.22 의 ±30 10일
// 정밀도 (D-30/D-20/D-10/D+10/D+20/D+30) 를 유지하면서 ±60 까지 확장됐다.
// frontend UI 는 5 탭 (D-60/D-30/D-Day/D+30/D+60) 만 노출하므로, 5 탭 →
// worker bucket(s) union 매핑이 필요. summary 도 동일 매핑으로 GROUP BY.
//
// V3.1 (2026-05-25): worker 가 Pre/Post bucket 도 저장하지만 5 탭 UI 에는
// 포함하지 않음. 매핑에서 자동 제외 → KPI/CompetitorOrganicityBar 무영향.
//
// spec docs/superpowers/specs/2026-05-25-debut-window-expansion-and-all-time-view-design.md §3.3

export const FRONTEND_BUCKET_MAP: Record<string, string[]> = {
  "D-60":  ["D-60"],
  "D-30":  ["D-30", "D-20", "D-10"],
  "D-Day": ["D-Day"],
  "D+30":  ["D+10", "D+20", "D+30"],
  "D+60":  ["D+60"],
};

// drift defense — VALID_BUCKETS 는 FRONTEND_BUCKET_MAP 의 키에서 파생
// (backlog: VALID_BUCKETS ↔ FRONTEND_BUCKET_MAP drift defense).
export const VALID_BUCKETS: Set<string> = new Set(Object.keys(FRONTEND_BUCKET_MAP));
