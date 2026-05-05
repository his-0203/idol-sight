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
  const ageH = props.lastSuccessAt
    ? (Date.now() - Date.parse(props.lastSuccessAt)) / 3_600_000
    : null;
  const ageText = ageH == null
    ? "마지막 갱신 없음"
    : ageH < 1 ? `${Math.round(ageH * 60)}분 전`
    : ageH < 48 ? `${Math.round(ageH)}시간 전`
    : `${Math.round(ageH / 24)}일 전`;
  return (
    <span class={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${COLORS[f]}`}>
      <span>{ICONS[f]}</span>
      {props.label && <span class="text-zinc-300">{props.label}:</span>}
      <span>{ageText}</span>
    </span>
  );
}
