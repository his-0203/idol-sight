// frontend/src/views/WeeklyUpdate.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { SourceRef } from "../components/SourceRef";

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
          <div class="text-xs uppercase tracking-wider text-zinc-500">Reporting Window</div>
          <div class="text-base font-semibold tabular-nums">
            Week of {weekStart ?? "?"}{weekEnd ? ` ~ ${weekEnd}` : ""}
          </div>
        </header>
      )}

      {data.insights.length > 0 && (
        <section class="rounded-lg border border-zinc-800 p-3">
          <h3 class="section-title mb-3 border-b border-zinc-800/40 pb-2">Weekly Insights ({data.insights.length})</h3>
          <ul class="space-y-2 text-sm">
            {data.insights.map((i: any) => (
              <li key={i.id} class="rounded-md border border-zinc-800/60 p-2">
                <div class="text-xs text-zinc-500">{i.scope} · {i.week_start}</div>
                <div class="font-semibold">{i.title}</div>
                <div class="text-xs text-zinc-400">{i.body}</div>
                <SourceRef refs={(() => { try { return JSON.parse(i.source_refs_json ?? "[]"); }
                                            catch { return []; } })()} />
              </li>
            ))}
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
