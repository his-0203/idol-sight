// frontend/functions/lib/debutWindowBuckets.ts
//
// V2.49 (2026-06-11): 롤링 윈도우 — 정적 FRONTEND_BUCKET_MAP identity 맵
// 폐기. 버킷 라벨은 worker bucket_for (debut_window.py) 와 동일한 산술
// 규칙으로 생성/검증한다:
//   음수 측: D-60(-70..-51) / D-40(-50..-31) / D-20(-30..-11) / D-Day(-10..9)
//   d >= 10: D+20k (k = floor((d-10)/20) + 1) — 20일 폭 무한 시리즈
// 표시 창은 anchor 그룹(MiiWAN)의 데뷔 경과일이 속한 버킷을 오른쪽 끝으로
// 한 연속 7버킷. 오른쪽 끝 최소 D+60 — 데뷔 전~D+69 는 현행 고정 창과 동일.
// worker 와의 경계 동일성은 tests/lib/debutWindowBuckets.test.ts 의
// BOUNDARY_FIXTURE 가 핀 (worker 쪽은 test_debut_window.py parametrize).

export const ANCHOR_GROUP_KEY = "miiwan";
export const WINDOW_SIZE = 7;
export const UNDATED_BUCKET = "Undated";

// 개념적 무한 시퀀스의 고정 prefix (index 0..3). index 4+ 는 D+20(i-3).
const NEGATIVE_LABELS = ["D-60", "D-40", "D-20", "D-Day"] as const;

// 시퀀스 index → 버킷 라벨.
export function labelForIndex(i: number): string {
  if (i < 0 || !Number.isInteger(i)) {
    throw new Error(`bucket index out of range: ${i}`);
  }
  if (i < NEGATIVE_LABELS.length) return NEGATIVE_LABELS[i]!;
  return `D+${20 * (i - 3)}`;
}

// 데뷔 경과일 → 그 날이 속한 버킷의 시퀀스 index.
// worker bucket_for 와 동일 경계. -51 미만(Pre 포함)은 0 으로 clamp —
// 표시 창 계산 용도라 Pre 구분이 필요 없다.
export function bucketIndexForAge(ageDays: number): number {
  if (ageDays <= -51) return 0;
  if (ageDays <= -31) return 1;
  if (ageDays <= -11) return 2;
  if (ageDays <= 9) return 3;
  return Math.floor((ageDays - 10) / 20) + 4;
}

// 오늘이 속한 버킷 라벨 — 컴포넌트의 기본 선택 탭.
export function currentBucket(ageDays: number): string {
  return labelForIndex(bucketIndexForAge(ageDays));
}

// 표시 창: 오른쪽 끝 = max(오늘 버킷, D+60(index 6)) 인 연속 7버킷.
// currentBucket(ageDays) 는 항상 이 창 안에 있다 (오른쪽 끝이 오늘 버킷
// 이상으로만 확장되고 창 폭 7 > 음수 측 깊이 4 이므로).
export function displayBuckets(ageDays: number): string[] {
  const right = Math.max(6, bucketIndexForAge(ageDays));
  const start = right - (WINDOW_SIZE - 1);
  return Array.from({ length: WINDOW_SIZE }, (_, j) => labelForIndex(start + j));
}

// ?bucket= 파라미터 검증 — named 4종 + "D+N (N = 20 의 배수 ≥ 20)".
export function isValidBucketLabel(label: string): boolean {
  if ((NEGATIVE_LABELS as readonly string[]).includes(label)) return true;
  const m = /^D\+(\d+)$/.exec(label);
  if (!m) return false;
  const n = Number(m[1]);
  return n >= 20 && n % 20 === 0;
}

// KST 달력 기준 데뷔 경과일. debut_date 는 'YYYY-MM-DD' (KST 달력 날짜),
// now 는 UTC Date. 둘 다 UTC midnight 타임스탬프로 환산해 정수일 차분.
export function debutAgeDaysKST(debutDate: string, now: Date): number {
  const kstTodayIso = new Date(now.getTime() + 9 * 3_600_000)
    .toISOString().slice(0, 10);
  return Math.round((Date.parse(kstTodayIso) - Date.parse(debutDate)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Legacy exports — consumed by summary.ts / videos.ts (Task 4 에서 교체 예정).
// 이 시점에는 기존 소비처가 여전히 이 export 를 import 하므로 컴파일 오류를
// 막기 위해 빈 stub 을 유지한다. 내용은 무의미 — Task 4 에서 삭제.
// ---------------------------------------------------------------------------
/** @deprecated Task 4 에서 삭제 예정 */
export const FRONTEND_BUCKET_MAP: Record<string, string[]> = {};
/** @deprecated Task 4 에서 삭제 예정 */
export const VALID_BUCKETS: Set<string> = new Set();
