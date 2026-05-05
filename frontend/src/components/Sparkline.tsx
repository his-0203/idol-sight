// Sparkline — tiny inline trend chart for KPI cards. Self-normalizing
// (each instance scales to its own min/max), so a 1.2M view sparkline
// and a 12-post sparkline fit in the same fixed footprint without
// hard-coded axes. We render an SVG polyline + gradient area so the
// shape is readable even at 60×16. ≤2 points renders nothing — a
// "trend" line of one or two points is just noise.
//
// Width/height props are visual fallbacks; the SVG uses
// preserveAspectRatio='none' so it stretches into a flex slot when
// the parent constrains the width.

interface SparklineProps {
  points: Array<number | null | undefined>;
  width?: number;
  height?: number;
  /** CSS color for the line + gradient. Defaults to currentColor so
      the consumer can re-tint via Tailwind text-* classes. */
  stroke?: string;
  /** Highlight last point with a small dot — useful when the sparkline
      sits next to the headline number. */
  showLastDot?: boolean;
}

export function Sparkline({
  points,
  width = 80,
  height = 22,
  stroke = "currentColor",
  showLastDot = true,
}: SparklineProps) {
  const cleaned = points
    .map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null))
    .filter((v): v is number => v != null);
  if (cleaned.length < 2) return null;

  const min = Math.min(...cleaned);
  const max = Math.max(...cleaned);
  const range = max - min || 1;

  // Map indices into 0..width and values into pad..(height-pad). The
  // 2px pad keeps the polyline from clipping at the top/bottom edge
  // when there's a saturating value.
  const pad = 2;
  const innerH = height - pad * 2;
  const dx = cleaned.length > 1 ? width / (cleaned.length - 1) : 0;
  const xy = cleaned.map((v, i) => {
    const x = i * dx;
    const y = pad + innerH - ((v - min) / range) * innerH;
    return [x, y] as const;
  });
  const polyline = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const lastPoint = xy[xy.length - 1];
  const lastX = lastPoint?.[0] ?? 0;
  const lastY = lastPoint?.[1] ?? 0;
  const areaPath = `M0,${height} L${polyline.replace(/ /g, " L")} L${width},${height} Z`;
  const id = `spark-grad-${Math.random().toString(36).slice(2, 8)}`;

  return (
    <svg
      class="inline-block align-middle"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color={stroke} stop-opacity="0.25" />
          <stop offset="100%" stop-color={stroke} stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${id})`} />
      <polyline
        points={polyline}
        fill="none"
        stroke={stroke}
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
      {showLastDot && (
        <circle cx={lastX} cy={lastY} r={1.8} fill={stroke} />
      )}
    </svg>
  );
}
