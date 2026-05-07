import { useEffect, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { KPI } from "../components/KPI";
import { EmptyState } from "../components/EmptyState";
import { GroupTabs } from "../components/GroupTabs";

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
    // Dynamic y-axis: previously hardcoded to 200 (theoretical YT 100 +
    // Community 100). Real distributions cluster in the 60-100 range,
    // which made the chart fill only 1/3 and crushed inter-member
    // variance. We pick the 95th-percentile-ish max (max combined +
    // 10% headroom) so the bars actually USE the canvas height while
    // still leaving room for outliers.
    const maxCombined = Math.max(
      0,
      ...((data.members ?? []).map(
        (m: any) => Number(m.yt_score ?? 0) + Number(m.community_score ?? 0),
      ) as number[]),
    );
    const yMax = maxCombined > 0 ? Math.ceil(maxCombined * 1.1 / 10) * 10 : 100;
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
        scales: { x: { stacked: true }, y: { stacked: true, max: yMax } },
      },
    });
  }, [data]);

  if (!groupKey) {
    return (
      <div class="space-y-4">
        <GroupTabs />
        <EmptyState
          title="그룹을 선택하세요"
          hint="상단 시장 개요 카드 또는 Cmd+K 검색에서 그룹을 고르면 멤버 분포가 표시됩니다."
          icon="👆"
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div class="space-y-4">
        <GroupTabs />
        <div class="text-zinc-500">Loading…</div>
      </div>
    );
  }
  if (data.status === "insufficient") {
    return (
      <div class="space-y-4">
        <GroupTabs />
        <EmptyState
          title="데이터 부족"
          hint="활동량 부족으로 멤버 인기도 산출 불가 (HHI 미계산)."
          icon="📊"
        />
      </div>
    );
  }

  // Two KPIs cover the full distribution-concentration story.
  // Evenness (= 1 - HHI_norm) and Top1 share are orthogonal and
  // immediately answer "is the group balanced?" + "how dominant is the
  // ace?". Top3 and HHI raw are dropped — Top3 was the same signal
  // re-expressed, and HHI raw is N-dependent (see worker
  // member_popularity.py docstring) so its absolute number means
  // different things across groups.
  return (
    <div class="space-y-4">
      <GroupTabs />
      <section class="grid grid-cols-2 gap-2">
        <KPI
          label="Evenness"
          value={data.evenness != null ? Math.round(data.evenness * 100) + "%" : "—"}
          unit="N-정규화"
          hint="100% = 모든 멤버 동등 / 0% = 한 명에게 100% 쏠림"
        />
        <KPI
          label="Top 1 비중"
          value={data.top1_share != null ? Math.round(data.top1_share * 100) + "%" : "—"}
          hint="최상위 멤버 점유율 (상세는 표 1행 참조)"
        />
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="section-title mb-3 border-b border-zinc-800/40 pb-2">멤버 복합 점수</h3>
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
