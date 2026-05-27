// frontend/functions/lib/debutWindowBuckets.ts
//
// V2.34 (2026-05-27): worker WINDOW_BUCKETS 가 9 named bucket 으로 균등
// 15일 폭 통일됨 (이전 V3.1 의 비대칭 11 bucket 폐기). frontend UI 도
// 동일하게 9 탭 노출 → worker bucket ↔ frontend bucket 이 1:1 identity
// 매핑. 이전 V3 의 union 매핑 (D-30 → [D-30, D-20, D-10]) 은 폭 비대칭
// 결과를 5탭 UI 에 합쳤던 우회였고 균등 폭 통일 후 불필요.
//
// summary.ts / videos.ts 양쪽이 이 모듈을 single source of truth 로 공유.

// V2.34: identity map. 키 = worker bucket = frontend bucket.
// 의도적으로 List value 를 유지 — summary.ts 의 GROUP BY CASE 빌더와
// videos.ts 의 WHERE IN() 빌더가 둘 다 array iteration 을 가정하기 때문.
export const FRONTEND_BUCKET_MAP: Record<string, string[]> = {
  "D-60":  ["D-60"],
  "D-40":  ["D-40"],
  "D-20":  ["D-20"],
  "D-Day": ["D-Day"],
  "D+20":  ["D+20"],
  "D+40":  ["D+40"],
  "D+60":  ["D+60"],
};

// drift defense — VALID_BUCKETS 는 FRONTEND_BUCKET_MAP 의 키에서 파생
// (backlog: VALID_BUCKETS ↔ FRONTEND_BUCKET_MAP drift defense).
export const VALID_BUCKETS: Set<string> = new Set(Object.keys(FRONTEND_BUCKET_MAP));
