export function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n == null) return "—";
  return n.toFixed(digits) + "%";
}

export function deltaSign(n: number): "up" | "down" | "flat" {
  return n > 0 ? "up" : n < 0 ? "down" : "flat";
}
