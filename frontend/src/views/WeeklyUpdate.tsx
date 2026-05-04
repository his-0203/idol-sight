// frontend/src/views/WeeklyUpdate.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { SourceRef } from "../components/SourceRef";

export function WeeklyUpdate() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.weekly().then(setData); }, []);
  if (!data) return <div class="text-zinc-500">Loading…</div>;
  return (
    <div class="space-y-6">
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">Weekly Insights ({data.insights.length})</h3>
        <ul class="space-y-2 text-sm">
          {data.insights.map((i: any) => (
            <li key={i.id} class="rounded border border-zinc-800/60 p-2">
              <div class="text-[10px] text-zinc-500">{i.scope} · {i.week_start}</div>
              <div class="font-semibold">{i.title}</div>
              <div class="text-xs text-zinc-400">{i.body}</div>
              <SourceRef refs={(() => { try { return JSON.parse(i.source_refs_json ?? "[]"); }
                                          catch { return []; } })()} />
            </li>
          ))}
        </ul>
      </section>

      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">Hanteo Weekly</h3>
        {data.hanteo.length === 0 ? (
          <div class="text-xs text-zinc-500">차트 데이터 없음 (selector follow-up).</div>
        ) : (
          <table class="w-full text-xs">
            <thead><tr class="text-left text-zinc-500">
              <th class="py-1">#</th><th>Group</th><th>Album</th><th>Sales</th>
            </tr></thead>
            <tbody>
              {data.hanteo.map((h: any) => (
                <tr key={`${h.group_key}-${h.album}`} class="border-t border-zinc-800/60">
                  <td class="py-1">{h.rank}</td>
                  <td>{h.group_key}</td>
                  <td>{h.album}</td>
                  <td>{fmt(h.sales)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">Big Movers (이번 vs 직전)</h3>
        <table class="w-full text-xs">
          <thead><tr class="text-left text-zinc-500">
            <th class="py-1">Group</th><th>ΔViews</th><th>ΔDC</th>
          </tr></thead>
          <tbody>
            {data.movers.map((m: any) => (
              <tr key={m.group_key} class="border-t border-zinc-800/60">
                <td class="py-1">{m.group_key}</td>
                <td class={(m.d_views ?? 0) > 0 ? "text-emerald-400" : "text-red-400"}>
                  {m.d_views == null ? "—" : (m.d_views > 0 ? "▲" : "▼") + " " + fmt(Math.abs(m.d_views))}
                </td>
                <td class={(m.d_dc ?? 0) > 0 ? "text-emerald-400" : "text-red-400"}>
                  {m.d_dc == null ? "—" : (m.d_dc > 0 ? "▲" : "▼") + " " + fmt(Math.abs(m.d_dc))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
