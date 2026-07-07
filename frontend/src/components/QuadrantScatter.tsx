// QuadrantScatter — 모멘텀(성장) × 품질(유지율) 사분면 버블 차트.
// X=growthMoM, Y=retentionRel, 버블크기=watch_share, 색=tier.
// 기준선: x=0(전월 동일), y=1.0(국내 동등) → 4분면. 클릭 시 국가 선택.
//
// 데뷔 초기 robust 처리:
//   - 축 범위를 데이터 P5~P95(클램프 한계 내)로 고정 → +230000% 같은 극단치
//     한 점이 전체 축을 파괴하지 못하게. 범위 초과 점은 가장자리에 핀.
//   - 성장 데이터 없는(신규) 국가는 호출부가 제외하고 넘긴다.
//   - 본진(KR)은 금색 테두리로 구분(진출 대상엔 포함, 기준선 의미).
//
// chart.js v4 bubble. 사분면 가이드선/라벨은 의존성 없이 커스텀 플러그인.

import { useEffect, useRef } from "preact/hooks";
import Chart from "chart.js/auto";
import { percentile, fmtGrowthPct, type EnrichedCountry } from "../lib/marketAnalysis";

const TIER_COLOR: Record<string, string> = {
  candidate: "#22d3ee", test: "#a78bfa", watch: "#64748b", insufficient: "#475569",
};
const HOME = "KR";
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
  // selected 는 색/테두리(스타일)만 바꾼다 → 차트 통째 재생성(깜빡임) 대신
  // ref 로 콜백에 주입하고 아래 effect 에서 update("none")로 재페인트.
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
    chart.current?.update("none");
  }, [selected]);

  useEffect(() => {
    if (!canvas.current || countries.length === 0) return;

    // robust 축 범위 — 극단치가 축을 지배하지 못하도록 P5~P95 + 절대 한계.
    const gs = countries.map((c) => c.row.growthMoM);
    const rs = countries.map((c) => c.row.retentionRel);
    const xLo = clamp(percentile(gs, 0.05), -1, -0.1);
    const xHi = clamp(percentile(gs, 0.95), 0.3, 2);
    const yLo = 0;
    const yHi = clamp(percentile(rs, 0.95), 1.4, 2.5);

    // 버블 반지름(픽셀)이 축 경계에 걸쳐 짤리지 않도록, 데이터 클램프 범위(xLo..xHi/
    // yLo..yHi, 핀 위치)는 그대로 두고 '표시 축 범위'만 상하좌우로 넓혀 여백을 준다.
    // 위쪽(2.5×)·양옆(±극단)에 핀되는 큰 버블이 있어 위/좌우를 조금 더 넉넉히.
    const xSpan = xHi - xLo || 1, ySpan = yHi - yLo || 1;
    const xMin = xLo - xSpan * 0.09, xMax = xHi + xSpan * 0.09;
    const yMin = yLo - ySpan * 0.07, yMax = yHi + ySpan * 0.12;

    const points = countries.map((c) => {
      const gx = clamp(c.row.growthMoM, xLo, xHi);
      const gy = clamp(c.row.retentionRel, yLo, yHi);
      const pinned = gx !== c.row.growthMoM || gy !== c.row.retentionRel;
      return {
        x: gx, y: gy, r: 3 + Math.sqrt(Math.max(0, c.row.watchShare)) * 22,
        _c: c, _pinned: pinned,
      };
    });

    const quadrantPlugin = {
      id: "quadrant",
      // 4분면 색 배경 — '어느 칸이 좋은가'를 학습 없이 색으로 전달.
      beforeDatasetsDraw(ch: any) {
        const { ctx, chartArea: a, scales } = ch;
        const x0 = Math.max(a.left, Math.min(a.right, scales.x.getPixelForValue(0)));
        const y1 = Math.max(a.top, Math.min(a.bottom, scales.y.getPixelForValue(1.0)));
        ctx.save();
        const fill = (x: number, y: number, w: number, h: number, c: string) => {
          ctx.fillStyle = c; ctx.fillRect(x, y, w, h);
        };
        // 우상=초록(명당), 우하=빨강(거품), 좌상=파랑(육성), 좌하=회색(관망)
        fill(x0, a.top, a.right - x0, y1 - a.top, "rgba(34,197,94,0.07)");
        fill(x0, y1, a.right - x0, a.bottom - y1, "rgba(239,68,68,0.06)");
        fill(a.left, a.top, x0 - a.left, y1 - a.top, "rgba(59,130,246,0.06)");
        fill(a.left, y1, x0 - a.left, a.bottom - y1, "rgba(100,116,139,0.05)");
        ctx.restore();
      },
      afterDraw(ch: any) {
        const { ctx, chartArea: a, scales } = ch;
        const x0 = scales.x.getPixelForValue(0);
        const y1 = scales.y.getPixelForValue(1.0);
        ctx.save();
        ctx.strokeStyle = "rgba(148,163,184,0.35)";
        ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
        if (x0 >= a.left && x0 <= a.right) { ctx.beginPath(); ctx.moveTo(x0, a.top); ctx.lineTo(x0, a.bottom); ctx.stroke(); }
        if (y1 >= a.top && y1 <= a.bottom) { ctx.beginPath(); ctx.moveTo(a.left, y1); ctx.lineTo(a.right, y1); ctx.stroke(); }
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(148,163,184,0.55)";
        ctx.font = "11px ui-sans-serif, system-ui";
        ctx.textAlign = "right"; ctx.textBaseline = "top";
        ctx.fillText("✅ 공략 1순위", a.right - 6, a.top + 4);
        ctx.textBaseline = "bottom"; ctx.fillText("⚠️ 거품 의심", a.right - 6, a.bottom - 4);
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText("안정·육성", a.left + 6, a.top + 4);
        ctx.textBaseline = "bottom"; ctx.fillText("관망", a.left + 6, a.bottom - 4);
        ctx.restore();
      },
    };

    chart.current = new Chart(canvas.current, {
      type: "bubble",
      data: {
        datasets: [{
          data: points as any,
          clip: false,   // 축 패딩을 넘는 최대 크기 버블도 캔버스 여백으로 흘려 잘리지 않게
          backgroundColor: (cx: any) => {
            const c: EnrichedCountry = cx.raw?._c; if (!c) return "#475569";
            const base = TIER_COLOR[c.tier] ?? "#64748b";
            const alpha = c.insufficient ? 0.22 : selectedRef.current === c.row.country ? 0.92 : 0.55;
            return hexA(base, alpha);
          },
          borderColor: (cx: any) => {
            const c: EnrichedCountry = cx.raw?._c; if (!c) return "transparent";
            if (selectedRef.current === c.row.country) return "#e2e8f0";
            if (c.row.country === HOME) return "#fbbf24";   // 본진 금색
            return "rgba(15,18,22,0.8)";                     // 분리용 어두운 테두리
          },
          borderWidth: (cx: any) => {
            const c: EnrichedCountry = cx.raw?._c;
            return c && (selectedRef.current === c.row.country || c.row.country === HOME) ? 2 : 1;
          },
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { top: 10, right: 12, bottom: 4, left: 4 } }, // 플롯 외곽 여백
        onClick(_e, els) {
          if (!els.length) return;
          const p = points[els[0]!.index];
          if (p) onSelectRef.current(p._c.row.country);
        },
        scales: {
          x: {
            min: xMin, max: xMax,
            title: { display: true, text: "→ 뜨는 중 (전월비 성장)" },
            ticks: { callback: (v: any) => `${Math.round(Number(v) * 100)}%` },
          },
          y: {
            min: yMin, max: yMax,
            title: { display: true, text: "↑ 끝까지 보는 정도 (본진=1.0×)" },
            // 아래쪽 여백 구간의 음수 눈금(−0.x×)은 숨긴다 — 유지율은 0 미만이 없음.
            ticks: { callback: (v: any) => (Number(v) < -1e-9 ? "" : `${Number(v).toFixed(1)}×`) },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label(cx: any) {
                const c: EnrichedCountry = cx.raw?._c; if (!c) return "";
                return [
                  `${c.row.country}${c.row.country === HOME ? " (본진)" : ""} · ${c.score}점 · ${c.tier}`,
                  `성장 ${pct(c.row.growthMoM)} · 유지 ${c.row.retentionRel.toFixed(2)}×`,
                  `점유 ${(c.row.watchShare * 100).toFixed(1)}% · 전환 ${c.row.subPer1k.toFixed(1)}/1k`,
                  cx.raw?._pinned ? "↳ 표시범위 초과(가장자리에 핀)" : "",
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
  }, [countries]);

  return (
    <div class="relative h-80">
      <canvas ref={canvas} role="img"
        aria-label="국가별 성장세×끝까지 보는 정도 사분면 시각화. 같은 데이터는 아래 '유망도 점수 랭킹' 목록에서 키보드로 확인할 수 있습니다." />
    </div>
  );
}

function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
const pct = fmtGrowthPct;
