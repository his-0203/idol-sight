// Fixed 8-group color palette. Pick distinguishable hues across the wheel
// while staying inside the dark-surface readable band (S>=55%, L 55-70%).
//
// Usage: <span style={{ borderLeftColor: colorOf(key) }} class="border-l-4">
//        or via Tailwind: bg-group-plave / text-group-plave / border-group-plave
//
// Rule: ALWAYS pick the same color per group across all charts and cards so
// users learn "PLAVE = pink" once and recognize it everywhere.
export const GROUP_COLORS = {
  plave:    "#ec4899", // pink-500   — flagship, warmest
  isedol:   "#22c55e", // green-500
  stellive: "#818cf8", // indigo-400 — 자사 MiiWAN 청록(#75d7d1)과 충돌 회피 (was cyan)
  skinz:    "#f59e0b", // amber-500
  myrakl:   "#a855f7", // purple-500
  owis:     "#3b82f6", // blue-500
  miiwan:   "#75d7d1", // 자사 MiiWAN 메인 정체성 (가시성 우선, 2026-06 확정 · was teal #14b8a6)
  bdawn:    "#ef4444", // red-500
  wegosix:  "#f97316", // orange-500 — 23rd Century Kids virtual boy group
  uryael:   "#84cc16", // lime-500   — UR:L (유아렐) Sandbox Network 첫 버추얼
  hollin:   "#d946ef", // fuchsia-500 — WhOLLiN (홀린) 플레이리스트 첫 버추얼 보이그룹
  begritz:  "#0ea5e9", // sky-500    — BEGRITZ (비그릿츠) 디네이블 버추얼 아이돌
  // BTHD (비더후드) — 동시기 코호트 차트(MiiWANCohortReport)에는
  // skinz(amber 38°)·bdawn(red 0°)·owis(blue 217°)·myrakl(purple 271°)·
  // miiwan(teal 176°)·plave(pink 330°)와 함께 그려져 hue 공백(38°~176°)만
  // 으로 충분하지만, 가장 가까운 실제 공동 렌더 이웃은 DebutCurve 차트의
  // isedol(green-500 #22c55e, hue 142°, L45%)이다 — hue 108° 로 그 옆(팔레트
  // 전체에서 가장 가까운 lime-500 82°·green-500 142° 사이)에 두되 isedol보다
  // 밝게(L 62%) 잡아 겹쳐 그려도 명도차로 구분된다.
  bthd:     "#78dd5f", // leaf green — BTHD (비더후드)
} as const;

export type GroupKey = keyof typeof GROUP_COLORS;

const FALLBACK = "#71717a"; // zinc-500

export function colorOf(key: string | null | undefined): string {
  if (!key) return FALLBACK;
  return (GROUP_COLORS as Record<string, string>)[key] ?? FALLBACK;
}

// Fill helper for chart areas: same hue, low alpha. Pass a 0..1 alpha.
export function fillOf(key: string | null | undefined, alpha = 0.18): string {
  const hex = colorOf(key);
  // Convert #RRGGBB -> rgba()
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const GROUP_KEYS: GroupKey[] = [
  "plave", "isedol", "stellive", "skinz",
  "myrakl", "owis", "miiwan", "bdawn", "wegosix", "uryael",
  "hollin", "begritz", "bthd",
];
