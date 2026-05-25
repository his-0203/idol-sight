// frontend/src/views/WeeklyUpdate.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { DataSourceDetails, type RawRef } from "../components/Tooltip";
import { InsightBody } from "../components/InsightBody";
import { GroupBadge } from "../components/GroupBadge";
import { extractGroupKeys, humanizeInsightText } from "../lib/insightFormat";
import { colorOf } from "../design/groups";
import { formatKST } from "../lib/datetime";

// scope/type 칩의 의미 라벨. type 은 한국어 표기로 가독성 ↑.
const TYPE_LABEL: Record<string, string> = {
  weekly: "주간", insight: "인사이트", ipx_action: "IPX 액션",
};

export function WeeklyUpdate() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.weekly().then(setData); }, []);
  if (!data) return <div class="text-zinc-500">Loading…</div>;
  const weekStart = data.hanteo?.[0]?.week_start ?? data.insights?.[0]?.week_start ?? null;
  const weekEnd = data.hanteo?.[0]?.week_end ?? null;
  return (
    <div class="space-y-6">
      {(weekStart || weekEnd) && (
        <header class="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div class="text-xs uppercase tracking-wider text-zinc-500">Reporting Window (KST)</div>
          <div class="text-base font-semibold tabular-nums">
            Week of {weekStart ?? "?"}{weekEnd ? ` ~ ${weekEnd}` : ""}
          </div>
        </header>
      )}

      {data.insights.length > 0 && (
        <section class="rounded-lg border border-zinc-800 p-3">
          <h3 class="section-title mb-3 border-b border-zinc-800/40 pb-2">Weekly Insights ({data.insights.length})</h3>
          <ul class="space-y-2.5 text-sm">
            {data.insights.map((i: any) => {
              const refs: RawRef[] = (() => {
                try { return JSON.parse(i.source_refs_json ?? "[]"); }
                catch { return []; }
              })();
              const aiComment: string | null = i.ai_comment
                ? humanizeInsightText(i.ai_comment)
                : null;
              // 카드 좌측 accent bar 색은 본문에 등장한 첫 그룹의 컬러
              // (없으면 zinc fallback). 그룹별 카드 식별이 한 눈에.
              const bodyGroups = extractGroupKeys(i.body);
              const accentKey = bodyGroups[0] ?? null;
              return (
                <li
                  key={i.id}
                  class="rounded-md border border-zinc-800/60 bg-zinc-900/30 px-3 py-2.5 border-l-4"
                  style={{ borderLeftColor: colorOf(accentKey) }}
                >
                  {/* 1) 상단 라인 — 그룹 뱃지(들) + scope/type 칩 + KST */}
                  <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                    {bodyGroups.slice(0, 3).map((k) => (
                      <GroupBadge key={k} groupKey={k} size="sm" />
                    ))}
                    <span class="rounded bg-zinc-800/60 px-1.5 py-[1px] text-[10px] uppercase tracking-wider text-zinc-400">
                      {TYPE_LABEL[i.type] ?? i.type ?? "weekly"}
                    </span>
                    <span class="text-zinc-600">·</span>
                    <span>{i.scope}</span>
                    {i.week_start && (
                      <>
                        <span class="text-zinc-600">·</span>
                        <span class="tabular-nums">{i.week_start}</span>
                      </>
                    )}
                    {i.generated_at && (
                      <span
                        class="ml-auto text-[10px] text-zinc-600 tabular-nums"
                        title={formatKST(i.generated_at)}
                      >
                        {formatKST(i.generated_at)}
                      </span>
                    )}
                  </div>
                  {/* 2) Title — 강한 weight, tracking-tight 로 위계 */}
                  <div class="mt-1 text-base font-semibold tracking-tight text-zinc-100">
                    {humanizeInsightText(i.title)}
                  </div>
                  {/* 3) Body — 그룹 뱃지/톤 강조 포함 */}
                  <InsightBody
                    body={i.body}
                    class="mt-1 block text-sm leading-relaxed text-zinc-400"
                  />
                  {/* 4) AI 코멘트 — 옅은 배경 / 인용구 */}
                  {aiComment && (
                    <div class="mt-2 rounded border-l-2 border-violet-500/40 bg-violet-500/5 px-2 py-1 text-[12px] italic text-zinc-300">
                      <span class="not-italic mr-1 rounded bg-violet-500/15 px-1 py-[1px] text-[9px] uppercase tracking-wider text-violet-300">AI</span>
                      {aiComment}
                    </div>
                  )}
                  {/* 5) 메타/출처 — details 폴딩 (작은 글씨) */}
                  <DataSourceDetails refs={refs} />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {data.hanteo.length > 0 && (
        <section class="rounded-lg border border-zinc-800 p-3">
          <h3 class="section-title mb-3 border-b border-zinc-800/40 pb-2">Hanteo Weekly</h3>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead><tr class="text-left text-zinc-500">
                <th class="py-1">#</th><th>Group</th><th>Album</th><th class="text-right">Sales</th>
              </tr></thead>
              <tbody>
                {data.hanteo.map((h: any) => (
                  <tr key={`${h.group_key}-${h.album}`} class="border-t border-zinc-800/60">
                    <td class="py-1">{h.rank}</td>
                    <td>{h.group_name ?? h.group_key}</td>
                    <td>{h.album}</td>
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
              {data.movers.map((m: any) => (
                <tr key={m.group_key} class={`border-t border-zinc-800/60 ${m.group_key === "miiwan" ? "bg-amber-500/5" : ""}`}>
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
