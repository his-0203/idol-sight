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
  stellive: "#06b6d4", // cyan-500
  skinz:    "#f59e0b", // amber-500
  myrakl:   "#a855f7", // purple-500
  owis:     "#3b82f6", // blue-500
  miiwan:   "#14b8a6", // teal-500   — MiiWAN brand
  bdawn:    "#ef4444", // red-500
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
  "myrakl", "owis", "miiwan", "bdawn",
];
