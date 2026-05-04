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
          <div class="text-[10px] uppercase text-zinc-500">HHI</div>
          <div class="text-2xl font-bold">{data.hhi?.toFixed(3) ?? "—"}</div>
          <div class="text-[10px] text-zinc-500">0=완전 균등, 1=한 명이 독점</div>
        </div>
        <div class="rounded-lg border border-zinc-800 p-3">
          <div class="text-[10px] uppercase text-zinc-500">Evenness</div>
          <div class="text-2xl font-bold">{data.evenness != null ? (data.evenness * 100).toFixed(0) + "%" : "—"}</div>
          <div class="text-[10px] text-zinc-500">100% 가까울수록 균등</div>
        </div>
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">Member Composite Score</h3>
        <div class="h-64"><canvas ref={canvas}></canvas></div>
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <table class="w-full text-xs">
          <thead><tr class="text-left text-zinc-500">
            <th class="py-1">#</th><th>Member</th>
            <th class="text-right">Score</th><th class="text-right">YT</th>
            <th class="text-right">Avg Views</th><th class="text-right">Comm</th>
          </tr></thead>
          <tbody>
            {data.members.map((m: any, i: number) => (
              <tr key={m.id} class="border-t border-zinc-800/60">
                <td class="py-1">{i + 1}</td>
                <td>{m.name} <span class="text-zinc-500">{m.name_en ?? ""}</span></td>
                <td class="text-right font-semibold">{m.composite_score?.toFixed(1)}</td>
                <td class="text-right">{m.yt_videos}편</td>
                <td class="text-right">{m.yt_sufficient ? fmt(m.yt_avg_views) : <span class="text-zinc-500">{fmt(m.yt_avg_views)} (부족)</span>}</td>
                <td class="text-right">{fmt(m.community_mentions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
