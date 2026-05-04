// Chart.js global defaults + helpers. Call applyGlobalDefaults() once at boot
// in main.tsx. Then in any chart effect:
//
//   const datasets = groupDatasets(groupKeys, fn);   // group color per dataset
//   chart = new Chart(ctx, { type: "line", data: { labels, datasets },
//     options: { scales: { y: { ticks: { callback: fmtScale } } } } });
import Chart from "chart.js/auto";
import { colorOf, fillOf } from "./groups";
import { fmt } from "../format";

export function applyGlobalDefaults(): void {
  // Dark-surface defaults. Light mode is currently disabled (Phase 2).
  Chart.defaults.color           = "#a1a1aa";              // zinc-400
  Chart.defaults.borderColor     = "rgba(63, 63, 70, 0.5)"; // zinc-700/50 grid
  Chart.defaults.font.family     =
    "ui-sans-serif, system-ui, -apple-system, 'Apple SD Gothic Neo', " +
    "'Pretendard Variable', Pretendard, 'Noto Sans KR', sans-serif";
  Chart.defaults.font.size       = 11;
  Chart.defaults.plugins.legend.labels.boxWidth   = 10;
  Chart.defaults.plugins.legend.labels.boxHeight  = 10;
  Chart.defaults.plugins.legend.labels.padding    = 12;
  Chart.defaults.plugins.tooltip.backgroundColor  = "rgba(24, 24, 27, 0.95)"; // zinc-900
  Chart.defaults.plugins.tooltip.titleColor       = "#e4e4e7"; // zinc-200
  Chart.defaults.plugins.tooltip.bodyColor        = "#d4d4d8"; // zinc-300
  Chart.defaults.plugins.tooltip.borderColor      = "rgba(63, 63, 70, 0.7)";
  Chart.defaults.plugins.tooltip.borderWidth      = 1;
  Chart.defaults.plugins.tooltip.padding          = 8;
  Chart.defaults.plugins.tooltip.cornerRadius     = 6;
  Chart.defaults.plugins.tooltip.displayColors    = true;
  Chart.defaults.plugins.tooltip.boxPadding       = 4;
  Chart.defaults.responsive          = true;
  Chart.defaults.maintainAspectRatio = false;
}

// Y-axis tick formatter — abbreviates large numbers (3.2M, 540K).
export function fmtScale(value: number | string): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return String(value);
  return fmt(n);
}

// Build chart datasets from a list of group keys, each colored by `colorOf`.
// `pickValue(key)` returns the data array (or scalar series) for that group.
//
// Type is loose by design — Chart.js dataset shapes vary by chart type.
export function groupDatasets<T>(
  keys: string[],
  pickValue: (key: string) => T,
  opts?: { fill?: boolean; pointRadius?: number },
): Array<Record<string, unknown>> {
  return keys.map((k) => ({
    label: k,
    data: pickValue(k),
    borderColor: colorOf(k),
    backgroundColor: opts?.fill ? fillOf(k, 0.20) : colorOf(k),
    borderWidth: 2,
    pointRadius: opts?.pointRadius ?? 0,
    pointHoverRadius: 4,
    fill: opts?.fill ?? false,
    tension: 0.25,
  }));
}

// Build a tooltip callback that runs values through `fmt()`.
export function fmtTooltipCallback(): (item: { dataset: { label?: string }; parsed: { y?: number } | number }) => string {
  return (item) => {
    const label = item.dataset?.label ?? "";
    const v = typeof item.parsed === "number"
      ? item.parsed
      : item.parsed?.y ?? 0;
    return `${label}: ${fmt(v)}`;
  };
}
