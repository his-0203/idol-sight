// QuadrantScatter — 모멘텀(성장) × 품질(유지율) 사분면 버블 차트.
// X=growthMoM, Y=retentionRel, 버블크기=watch_share, 색=tier.
// 기준선: x=0(전월 동일), y=1.0(국내 동등) → 4분면. 클릭 시 국가 선택.
//
// chart.js v4 bubble. 사분면 가이드선/라벨은 의존성(annotation 플러그인)
// 없이 커스텀 인라인 플러그인(afterDraw)으로 직접 그린다.

import { useEffect, useRef } from "preact/hooks";
import Chart from "chart.js/auto";
import type { EnrichedCountry } from "../lib/marketAnalysis";

const TIER_COLOR: Record<string, string> = {
  candidate: "#22d3ee", test: "#a78bfa", watch: "#64748b", insufficient: "#475569",
};

function bubbleRadius(watchShare: number): number {
  return 4 + Math.sqrt(Math.max(0, watchShare)) * 28;
}

export function QuadrantScatter({
  countries, selected, onSelect,
}: {
  countries: EnrichedCountry[];
  selected: string | null;
  onSelect: (country: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<Chart | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  useEffect(() => {
    if (!canvas.current) return;

    const points = countries.map((c) => ({
      x: c.row.growthMoM,
      y: c.row.retentionRel,
      r: bubbleRadius(c.row.watchShare),
      _c: c,
    }));

    // 사분면 기준선 + 코너 라벨을 그리는 커스텀 플러그인.
    const quadrantPlugin = {
      id: "quadrant",
      afterDraw(ch: any) {
        const { ctx, chartArea: a, scales } = ch;
        const x0 = scales.x.getPixelForValue(0);
        const y1 = scales.y.getPixelForValue(1.0);
        ctx.save();
        ctx.strokeStyle = "rgba(148,163,184,0.35)";
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        if (x0 >= a.left && x0 <= a.right) {
          ctx.beginPath(); ctx.moveTo(x0, a.top); ctx.lineTo(x0, a.bottom); ctx.stroke();
        }
        if (y1 >= a.top && y1 <= a.bottom) {
          ctx.beginPath(); ctx.moveTo(a.left, y1); ctx.lineTo(a.right, y1); ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(148,163,184,0.6)";
        ctx.font = "11px ui-sans-serif, system-ui";
        ctx.textBaseline = "top";
        ctx.fillText("공략 1순위", a.right - 70, a.top + 4);
        ctx.textBaseline = "bottom";
        ctx.fillText("거품 의심", a.right - 64, a.bottom - 4);
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText("안정·육성", a.left + 4, a.top + 4);
        ctx.textBaseline = "bottom";
        ctx.fillText("관망", a.left + 4, a.bottom - 4);
        ctx.restore();
      },
    };

    chart.current = new Chart(canvas.current, {
      type: "bubble",
      data: {
        datasets: [{
          data: points as any,
          backgroundColor: (cx: any) => {
            const c: EnrichedCountry = cx.raw?._c;
            if (!c) return "#475569";
            const base = TIER_COLOR[c.tier] ?? "#64748b";
            const sel = selected === c.row.country;
            const alpha = c.insufficient ? 0.25 : sel ? 0.95 : 0.6;
            return hexA(base, alpha);
          },
          borderColor: (cx: any) => {
            const c: EnrichedCountry = cx.raw?._c;
            return c && selected === c.row.country ? "#e2e8f0" : "transparent";
          },
          borderWidth: (cx: any) => {
            const c: EnrichedCountry = cx.raw?._c;
            return c && selected === c.row.country ? 2 : 0;
          },
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick(_e, els) {
          if (!els.length) return;
          const p = points[els[0]!.index];
          if (p) onSelectRef.current(p._c.row.country);
        },
        scales: {
          x: {
            title: { display: true, text: "모멘텀 (전월비 시청 성장)" },
            ticks: { callback: (v: any) => `${Math.round(Number(v) * 100)}%` },
          },
          y: {
            title: { display: true, text: "품질 (국내 대비 유지율)" },
            ticks: { callback: (v: any) => `${Number(v).toFixed(1)}×` },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(cx: any) {
                const c: EnrichedCountry = cx.raw?._c;
                if (!c) return "";
                return [
                  `${c.row.country} · ${c.score}점 · ${c.tier}`,
                  `성장 ${pct(c.row.growthMoM)} · 유지 ${c.row.retentionRel.toFixed(2)}×`,
                  `점유 ${(c.row.watchShare * 100).toFixed(1)}% · 전환 ${c.row.subPer1k.toFixed(1)}/1k`,
                  c.insufficient ? "⚠ 표본부족" : "",
                ].filter(Boolean);
              },
            },
          },
        },
      },
      plugins: [quadrantPlugin],
    });

    return () => { chart.current?.destroy(); chart.current = null; };
  }, [countries, selected]);

  return (
    <div class="relative h-80">
      <canvas ref={canvas} role="img"
        aria-label="국가별 모멘텀 × 품질 사분면" />
    </div>
  );
}

function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}
const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
