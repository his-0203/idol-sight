// RegionDonut — 권역별 분포 도넛(chart.js doughnut). 시청 비중·시청 시간·
// 구독 유입 등 '합이 의미 있는' 지표를 권역으로 묶어 한눈에 보여준다.

import { useEffect, useRef } from "preact/hooks";
import Chart from "chart.js/auto";

export interface DonutSegment { label: string; value: number }

// 슬라이스 색 팔레트 — 국가별 등 임의 라벨에 입힌다. '기타'는 회색.
const PALETTE = [
  "#22d3ee", "#34d399", "#a78bfa", "#fbbf24", "#f472b6",
  "#60a5fa", "#f87171", "#c084fc", "#2dd4bf", "#fb923c",
];
// 라벨(국가)별 색 고정 레지스트리. 정렬 인덱스가 아니라 '처음 본 순서'로
// 색을 한 번 배정해 캐시하므로, 탭/정렬이 바뀌어도 같은 나라는 같은 색을 쓴다.
const colorByLabel = new Map<string, string>();
const colorAt = (label: string) => {
  if (label.startsWith("기타")) return "#475569";
  let c = colorByLabel.get(label);
  if (!c) {
    c = PALETTE[colorByLabel.size % PALETTE.length]!;
    colorByLabel.set(label, c);
  }
  return c;
};

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
          backgroundColor: data.map((d) => colorAt(d.label)),
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
