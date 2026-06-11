// V2.49 롤링 윈도우: 표시 탭은 summary API 의 window 메타가 내려준다
// (서버가 anchor=MiiWAN 데뷔 경과일로 계산 — functions/lib/debutWindowBuckets
// 의 displayBuckets). 아래 정적 목록은 메타 부재 시(네트워크 오류 등)
// fallback 전용 — 데뷔 전 고정 창과 동일한 값.
export const DEFAULT_DISPLAY_BUCKETS: string[] = [
  "D-60", "D-40", "D-20", "D-Day", "D+20", "D+40", "D+60",
];
export const DEFAULT_CURRENT_BUCKET = "D-Day";
