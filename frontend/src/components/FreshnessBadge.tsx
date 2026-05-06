import { formatKST, formatKSTRelative } from "../lib/datetime";

type Freshness = "fresh" | "stale" | "broken";

function classify(lastSuccessAt: string | null, intervalH: number): Freshness {
  if (!lastSuccessAt) return "broken";
  const ageH = (Date.now() - Date.parse(lastSuccessAt)) / 3_600_000;
  if (ageH < intervalH * 1.5) return "fresh";
  if (ageH < intervalH * 4)   return "stale";
  return "broken";
}

const COLORS: Record<Freshness, string> = {
  fresh:  "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  stale:  "bg-amber-500/10  text-amber-400  border-amber-500/30",
  broken: "bg-red-500/10    text-red-400    border-red-500/30",
};

const ICONS: Record<Freshness, string> = { fresh: "✓", stale: "⏳", broken: "⚠️" };

export function FreshnessBadge(props: {
  label?: string;
  lastSuccessAt: string | null;
  intervalH: number;
}) {
  const f = classify(props.lastSuccessAt, props.intervalH);
  // Relative wording ("5분 전") for at-a-glance freshness, KST absolute
  // on hover so the operator can audit the exact moment without doing
  // UTC→KST math in their head.
  const ageText = formatKSTRelative(props.lastSuccessAt);
  const exactKST = props.lastSuccessAt ? formatKST(props.lastSuccessAt) : null;
  return (
    <span
      class={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${COLORS[f]}`}
      title={exactKST ?? "마지막 갱신 없음"}
    >
      <span>{ICONS[f]}</span>
      {props.label && <span class="text-zinc-300">{props.label}:</span>}
      <span>{ageText}</span>
    </span>
  );
}
