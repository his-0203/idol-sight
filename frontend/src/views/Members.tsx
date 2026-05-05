import { useEffect, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";

export function Members({ groupKey }: { groupKey: string | null }) {
  const [data, setData] = useState<any>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<Chart | null>(null);

  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    api.members(groupKey).then(setData);
  }, [groupKey]);

  useEffect(() => {
    if (!data || !canvas.current) return;
    chart.current?.destroy();
    chart.current = new Chart(canvas.current, {
      type: "bar",
      data: {
        labels: data.members.map((m: any) => m.name),
        datasets: [
          { label: "YT", stack: "s",
            data: data.members.map((m: any) => m.yt_score),
            backgroundColor: "rgb(139 92 246 / 0.7)" },
          { label: "Community", stack: "s",
            data: data.members.map((m: any) => m.community_score),
            backgroundColor: "rgb(20 184 166 / 0.7)" },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: { x: { stacked: true }, y: { stacked: true, max: 200 } },
      },
    });
  }, [data]);

  if (!groupKey) return <div class="text-zinc-500">상단에서 그룹을 선택하세요.</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;
  if (data.status === "insufficient") {
    return (
      <div class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-sm text-zinc-400">
        <div class="text-lg font-semibold text-zinc-200">데이터 부족</div>
        <p class="mt-1">해당 그룹은 활동량 부족으로 멤버 인기도 산출 불가 (HHI 미계산).</p>
      </div>
    );
  }
  return (
    <div class="space-y-4">
      <section class="grid grid-cols-2 gap-2">
        <div class="rounded-lg border border-zinc-800 p-3">
          <div class="text-xs uppercase tracking-wider text-zinc-500">HHI</div>
          <div class="text-2xl font-bold tabular-nums">{data.hhi?.toFixed(3) ?? "—"}</div>
          <div class="text-xs text-zinc-500">0=완전 균등, 1=한 명이 독점</div>
        </div>
        <div class="rounded-lg border border-zinc-800 p-3">
          <div class="text-xs uppercase tracking-wider text-zinc-500">Evenness</div>
          <div class="text-2xl font-bold tabular-nums">{data.evenness != null ? (data.evenness * 100).toFixed(0) + "%" : "—"}</div>
          <div class="text-xs text-zinc-500">100% 가까울수록 균등</div>
        </div>
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">멤버 복합 점수</h3>
        <div class="h-48 md:h-64"><canvas ref={canvas}></canvas></div>
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead><tr class="text-left text-zinc-500">
              <th class="py-1">#</th><th>멤버</th>
              <th class="text-right">점수</th><th class="text-right">YT</th>
              <th class="text-right">평균 조회수</th><th class="text-right">커뮤니티</th>
            </tr></thead>
            <tbody>
              {data.members.map((m: any, i: number) => (
                <tr key={m.id} class="border-t border-zinc-800/60">
                  <td class="py-1">{i + 1}</td>
                  <td>{m.name} <span class="text-zinc-500">{m.name_en ?? ""}</span></td>
                  <td class="text-right font-semibold tabular-nums">{m.composite_score?.toFixed(1)}</td>
                  <td class="text-right tabular-nums">{m.yt_videos}편</td>
                  <td class="text-right tabular-nums">
                    {m.yt_sufficient
                      ? fmt(m.yt_avg_views)
                      : (
                        <span class="text-zinc-400">
                          {fmt(m.yt_avg_views)}
                          <span
                            class="ml-1 rounded bg-amber-500/15 px-1 text-xs text-amber-400"
                            title="영상 5편 미만 — 표본 부족"
                          >N/A</span>
                        </span>
                      )}
                  </td>
                  <td class="text-right tabular-nums">{fmt(m.community_mentions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
