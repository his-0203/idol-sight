// frontend/src/views/WeeklyUpdate.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { writeState } from "../router";
import { fmt } from "../format";
import { humanizeInsightText } from "../lib/insightFormat";

export function WeeklyUpdate() {
  const [weeklyData, setWeeklyData] = useState<any>(null);
  const [insightsData, setInsightsData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.weekly()
      .then((wd) => {
        setWeeklyData(wd);
        const week = wd.week_start as string | null;
        if (week) {
          api.insights(week).then(setInsightsData).catch((e) => setErr(String(e)));
        } else {
          // No insight rows exist yet — treat as empty.
          setInsightsData({ insights: [] });
        }
      })
      .catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div class="text-rose-400">불러오기 실패: {err}</div>;
  if (!weeklyData) return <div class="text-zinc-500">Loading…</div>;

  // 기준 주간 = 인사이트 리포트 주간(일요일 시작). 한터 행에서 가져오지
  // 않는다 — hanteo_weekly는 주간 수집이 없는 초동 아카이브(시드)라 최신
  // 행이 몇 달 전일 수 있고, 그걸 우선하면 브리프 전체가 낡아 보인다.
  const weekStart = weeklyData.week_start ?? null;
  const weekEnd = (() => {
    if (!weekStart) return null;
    const d = new Date(`${weekStart}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().slice(0, 10);
  })();

  // api.insights rows already have source_refs parsed by the endpoint's mapRow.
  const insights: any[] = insightsData?.insights ?? [];

  // 결정 브리프 lede (R2#2): ai_comment 있거나 ipx_action 인 항목 최대 2개.
  const ledeItems: any[] = insights.filter(
    (i: any) => i.ai_comment || i.type === "ipx_action",
  ).slice(0, 2);

  return (
    <div class="space-y-6">
      <div>
        <h2 class="section-title">주간 업데이트</h2>
        {(weekStart || weekEnd) && (
          <p class="text-hint text-zinc-500 mt-1">기준 주간 (KST) · {weekStart ?? "?"}{weekEnd ? ` ~ ${weekEnd}` : ""}</p>
        )}
      </div>

      {/* 다이제스트: 주목 액션 하이라이트만 + 전체는 인사이트 탭으로(중복 제거). */}
      {insights.length > 0 && (
        <section class="rounded-lg border border-zinc-800 p-3">
          <div class="mb-3 flex items-baseline gap-2 border-b border-zinc-800/40 pb-2">
            <h3 class="section-title">이번 주 주요 신호</h3>
            <button
              type="button"
              class="ml-auto text-hint text-zinc-400 hover:text-zinc-200"
              onClick={() => writeState({ tab: "insights" })}
            >이번 주 {insights.length}건 · 전체 인사이트 보기 →</button>
          </div>

          {ledeItems.length > 0 ? (
            <div class="rounded border border-violet-500/20 bg-violet-500/5 px-3 py-2">
              <p class="text-label text-zinc-400 mb-1.5">이번 주 주목할 액션:</p>
              <ul class="space-y-1">
                {ledeItems.map((i: any) => (
                  <li key={i.id} class="text-body text-zinc-300 leading-snug">
                    <span class="font-medium">{humanizeInsightText(i.title)}</span>
                    {i.ai_comment && (
                      <span class="ml-1 text-hint text-zinc-400 italic">
                        — {humanizeInsightText(i.ai_comment)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p class="text-hint text-zinc-500">
              이번 주 주목할 액션 항목은 없어요. 전체 인사이트에서 확인하세요.
            </p>
          )}
        </section>
      )}

      {/* 초동 기록 — 주간 데이터가 아니라 앨범 첫 주 판매량 아카이브(수동
          검증 시드). 행마다 자체 집계 주간을 표기해 브리프 기준 주간과
          혼동되지 않게 한다. */}
      {weeklyData.hanteo.length > 0 && (
        <section class="rounded-lg border border-zinc-800 p-3">
          <div class="mb-3 flex flex-wrap items-baseline gap-2 border-b border-zinc-800/40 pb-2">
            <h3 class="section-title">초동 기록</h3>
            <span class="text-hint text-zinc-500">앨범 첫 주 판매량 · 수동 검증 수치(주간 자동 갱신 아님)</span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead><tr class="text-left text-zinc-500">
                <th class="py-1">Group</th><th>Album</th><th>집계 주간</th><th class="text-right">Sales</th>
              </tr></thead>
              <tbody>
                {weeklyData.hanteo.map((h: any) => (
                  <tr key={`${h.group_key}-${h.album}`} class="border-t border-zinc-800/60">
                    <td class="py-1">{h.group_name ?? h.group_key}</td>
                    <td>{h.album}</td>
                    <td class="tabular-nums text-zinc-500">{h.week_start} ~ {h.week_end}</td>
                    <td class="text-right tabular-nums">{fmt(h.sales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="section-title mb-1 border-b border-zinc-800/40 pb-2">Weekly Movers (vs 직전 snapshot)</h3>
        <div class="text-xs text-zinc-500 mb-3">최신 snapshot에서 이전 snapshot 대비 증가분(Δ). 누적값이 아님.</div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead><tr class="text-left text-zinc-500">
              <th class="py-1">Group</th><th class="text-right">Δ YouTube 조회수</th><th class="text-right">Δ DC 글</th>
            </tr></thead>
            <tbody>
              {weeklyData.movers.map((m: any) => (
                <tr
                  key={m.group_key}
                  class={`border-t border-zinc-800/60 ${m.group_key === "miiwan" ? "bg-[#75d7d1]/5" : ""}`}
                  style={m.group_key === "miiwan" ? { boxShadow: "inset 3px 0 0 #75d7d1" } : undefined}
                >
                  <td class="py-1">{m.group_name ?? m.group_key}</td>
                  <td class="text-right tabular-nums">
                    {m.d_views == null ? "—" : fmt(m.d_views)}
                  </td>
                  <td class="text-right tabular-nums">
                    {m.d_dc == null ? "—" : fmt(m.d_dc)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
