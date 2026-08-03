import { fmt } from "../format";
import { Sparkline } from "./Sparkline";
import { Tooltip } from "./Tooltip";
import type { ComponentChildren } from "preact";

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
  /** Optional tooltip content rendered next to the label. Use for 4-factor
      cards (Reach / RitualVictory / Mobilization / Intimacy) where the
      label alone doesn't convey what is being measured. */
  labelTooltip?: ComponentChildren;
  /** Optional one-line AI commentary slot. When provided, renders as a
      muted italic line under the value (placeholder for V2.x AI-comment
      feature — not surfaced unless populated). */
  aiComment?: string;
  /** "neutral" keeps the delta/sparkline zinc regardless of sign — for
      metrics where more isn't inherently good (community post counts,
      news volume: a spike can be a controversy, not a win). */
  polarity?: "up-good" | "neutral";
  /** Short suffix after the delta chip naming the comparison point,
      e.g. "vs 7/27" — without it the delta reads as WoW even when the
      previous snapshot is older than 7 days. */
  deltaHint?: string;
}) {
  const v = typeof props.value === "number" ? fmt(props.value) : (props.value ?? "—");
  const d = props.delta;
  const neutral = props.polarity === "neutral";
  const deltaTone =
    d == null || d === 0 || neutral
      ? "text-zinc-500"
      : d > 0
      ? "text-emerald-400"
      : "text-red-400";
  const sparkTone =
    d == null || neutral
      ? "text-zinc-500"
      : d > 0
      ? "text-emerald-500/70"
      : d < 0
      ? "text-red-500/70"
      : "text-zinc-500/70";
  return (
    <div class="card [.light_&]:border-zinc-200 [.light_&]:bg-white">
      <div class="flex items-start justify-between gap-2">
        <div class="text-xs uppercase tracking-wider text-zinc-500">
          {props.labelTooltip
            ? <Tooltip content={props.labelTooltip}>{props.label}</Tooltip>
            : props.label}
        </div>
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
          <span class={`text-xs font-semibold tabular-nums ${deltaTone}`} title={props.deltaHint}>
            {d > 0 ? "▲" : "▼"}{" "}
            {props.deltaUnit === "pct" ? `${Math.abs(d).toFixed(1)}pp` : fmt(Math.abs(d))}
            {props.deltaHint && (
              <span class="ml-1 font-normal text-zinc-500">{props.deltaHint}</span>
            )}
          </span>
        )}
      </div>
      {props.hint && <div class="mt-0.5 text-xs normal-case text-zinc-500">{props.hint}</div>}
      {props.aiComment && (
        <div class="mt-1 border-t border-zinc-800/60 pt-1 text-hint italic text-zinc-400">
          <span class="not-italic mr-1 rounded bg-violet-500/15 px-1 py-[1px] text-[9px] uppercase tracking-wider text-violet-300">
            AI
          </span>
          {props.aiComment}
        </div>
      )}
    </div>
  );
}
