import { fmt } from "../format";

export function KPI(props: {
  label: string;
  value: number | string | null;
  delta?: number | null;
  hint?: string;
}) {
  const v = typeof props.value === "number" ? fmt(props.value) : (props.value ?? "—");
  const d = props.delta;
  return (
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 [.light_&]:border-zinc-200 [.light_&]:bg-white">
      <div class="text-[10px] uppercase tracking-wide text-zinc-500">{props.label}</div>
      <div class="mt-1 flex items-baseline gap-2">
        <div class="text-xl font-bold">{v}</div>
        {d != null && d !== 0 && (
          <span class={`text-xs font-semibold ${d > 0 ? "text-emerald-400" : "text-red-400"}`}>
            {d > 0 ? "▲" : "▼"} {fmt(Math.abs(d))}
          </span>
        )}
      </div>
      {props.hint && <div class="mt-0.5 text-[10px] text-zinc-500">{props.hint}</div>}
    </div>
  );
}
