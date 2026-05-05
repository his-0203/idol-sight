import { fmt } from "../format";
import { Sparkline } from "./Sparkline";

export function KPI(props: {
  label: string;
  value: number | string | null;
  delta?: number | null;
  /** Optional pp/% suffix for the delta chip. Defaults to absolute
      number formatting via fmt(). Use 'pct' when the delta is already
      a percentage point (e.g. share-of-voice WoW). */
  deltaUnit?: "abs" | "pct";
  hint?: string;
  /** Optional inline qualifier shown after the value, e.g. "(누적)" / "(90d)". */
  unit?: string;
  /** Optional 30d trend points for an inline sparkline. Self-normalizing
      so callers can pass raw counts without scaling. ≤2 points renders
      nothing. Color follows the delta sign (positive=emerald,
      negative=red, zero/missing=zinc) so trend direction reads at a
      glance. */
  sparkline?: Array<number | null | undefined>;
}) {
  const v = typeof props.value === "number" ? fmt(props.value) : (props.value ?? "—");
  const d = props.delta;
  const deltaTone =
    d == null || d === 0
      ? "text-zinc-500"
      : d > 0
      ? "text-emerald-400"
      : "text-red-400";
  const sparkTone =
    d == null
      ? "text-zinc-500"
      : d > 0
      ? "text-emerald-500/70"
      : d < 0
      ? "text-red-500/70"
      : "text-zinc-500/70";
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 [.light_&]:border-zinc-200 [.light_&]:bg-white">
      <div class="flex items-start justify-between gap-2">
        <div class="text-xs uppercase tracking-wider text-zinc-500">{props.label}</div>
        {props.sparkline && props.sparkline.length >= 2 && (
          <span class={sparkTone}>
            <Sparkline points={props.sparkline} width={56} height={16} />
          </span>
        )}
      </div>
      <div class="mt-1 flex items-baseline gap-2">
        <div class="text-2xl font-bold tabular-nums">{v}</div>
        {props.unit && <div class="text-xs normal-case text-zinc-500">{props.unit}</div>}
        {d != null && d !== 0 && (
          <span class={`text-xs font-semibold tabular-nums ${deltaTone}`}>
            {d > 0 ? "▲" : "▼"}{" "}
            {props.deltaUnit === "pct" ? `${Math.abs(d).toFixed(1)}pp` : fmt(Math.abs(d))}
          </span>
        )}
      </div>
      {props.hint && <div class="mt-0.5 text-xs normal-case text-zinc-500">{props.hint}</div>}
    </div>
  );
}
