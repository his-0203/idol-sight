// RegionDonut — 권역별 분포 도넛(chart.js doughnut). 시청 비중·시청 시간·
// 구독 유입 등 '합이 의미 있는' 지표를 권역으로 묶어 한눈에 보여준다.

import { useEffect, useRef } from "preact/hooks";
import Chart from "chart.js/auto";

export interface DonutSegment { label: string; value: number }

// 권역 고정 색 — 다크 테마 대비.
const REGION_COLOR: Record<string, string> = {
  동아시아: "#22d3ee", 동남아: "#34d399", 북미: "#a78bfa", 중남미: "#fbbf24",
  유럽: "#f472b6", 오세아니아: "#60a5fa", 남아시아: "#f87171", 중동: "#c084fc",
  기타: "#64748b",
};
const colorOf = (label: string) => REGION_COLOR[label] ?? "#64748b";

export function RegionDonut({
  segments, centerLabel, fmt,
}: {
  segments: DonutSegment[];
  centerLabel?: string;
  fmt?: (v: number) => string;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvas.current) return;
    const data = [...segments].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    const f = fmt ?? ((v: number) => `${Math.round(v)}`);

    chart.current = new Chart(canvas.current, {
      type: "doughnut",
      data: {
        labels: data.map((d) => d.label),
        datasets: [{
          data: data.map((d) => d.value),
          backgroundColor: data.map((d) => colorOf(d.label)),
          borderColor: "#0b0f14", borderWidth: 2,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "62%",
        plugins: {
          legend: {
            position: "right",
            labels: { boxWidth: 10, boxHeight: 10, padding: 8, font: { size: 11 } },
          },
          tooltip: {
            callbacks: {
              label(cx: any) {
                const v = Number(cx.raw) || 0;
                return ` ${cx.label}: ${f(v)} (${Math.round((v / total) * 100)}%)`;
              },
            },
          },
        },
      },
    });
    return () => { chart.current?.destroy(); chart.current = null; };
  }, [segments, fmt]);

  return (
    <div class="relative h-56">
      <canvas ref={canvas} role="img"
        aria-label={`권역별 분포 도넛${centerLabel ? ` — ${centerLabel}` : ""}`} />
    </div>
  );
}
