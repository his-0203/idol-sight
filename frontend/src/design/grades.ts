// Grade color tokens. NOTE: violet is reserved for the IDOL-SIGHT brand,
// so grade B uses cyan instead. PRE = data-not-yet-aggregated (debut < 3mo).
//
// Each entry is a Tailwind class triplet { fg, bd, bg } plus a raw hex for
// chart usage. Apply via classes: `${G.fg} ${G.bd} ${G.bg}` on a span.
export const GRADE_TOKENS = {
  S:   { fg: "text-emerald-400", bd: "border-emerald-500/40", bg: "bg-emerald-500/10", hex: "#10b981" },
  A:   { fg: "text-blue-400",    bd: "border-blue-500/40",    bg: "bg-blue-500/10",    hex: "#3b82f6" },
  B:   { fg: "text-cyan-400",    bd: "border-cyan-500/40",    bg: "bg-cyan-500/10",    hex: "#06b6d4" },
  C:   { fg: "text-amber-400",   bd: "border-amber-500/40",   bg: "bg-amber-500/10",   hex: "#f59e0b" },
  D:   { fg: "text-red-400",     bd: "border-red-500/40",     bg: "bg-red-500/10",     hex: "#ef4444" },
  PRE: { fg: "text-zinc-400",    bd: "border-zinc-500/40",    bg: "bg-zinc-500/10",    hex: "#71717a" },
} as const;

export type Grade = keyof typeof GRADE_TOKENS;

export function gradeClasses(grade: string | null | undefined): string {
  const g = (grade ?? "PRE") as Grade;
  const t = GRADE_TOKENS[g] ?? GRADE_TOKENS.PRE;
  return `${t.fg} ${t.bd} ${t.bg}`;
}

export function gradeRingClass(grade: string | null | undefined): string {
  const g = (grade ?? "PRE") as Grade;
  switch (g) {
    case "S":   return "ring-emerald-500";
    case "A":   return "ring-blue-500";
    case "B":   return "ring-cyan-500";
    case "C":   return "ring-amber-500";
    case "D":   return "ring-red-500";
    default:    return "ring-zinc-500";
  }
}
