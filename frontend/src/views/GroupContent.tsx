import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { writeState } from "../router";
import { KPI } from "../components/KPI";
import { ExportMenu } from "../components/ExportMenu";
import { HealthSpec } from "../components/HealthSpec";

const GRADE_RING: Record<string, string> = {
  S: "ring-emerald-500", A: "ring-blue-500", B: "ring-violet-500",
  C: "ring-amber-500", D: "ring-red-500", PRE: "ring-zinc-500",
};

export function GroupContent({ groupKey }: { groupKey: string | null }) {
  const [groups, setGroups] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);

  useEffect(() => { api.groups().then((r) => setGroups(r.groups)); }, []);
  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    api.group(groupKey).then(setData).catch(() => setData({ error: "not_found" }));
  }, [groupKey]);

  return (
    <div class="space-y-4">
      <div class="flex items-center gap-2 text-sm">
        <label class="text-zinc-500">Group</label>
        <select
          class="rounded border border-zinc-700 bg-zinc-950 px-2 py-1"
          value={groupKey ?? ""}
          onChange={(e: any) => writeState({ group: e.currentTarget.value || null })}
        >
          <option value="">— 선택 —</option>
          {groups.map((g) => (
            <option key={g.key} value={g.key}>{g.name} · {g.name_kr}</option>
          ))}
        </select>
      </div>

      {!groupKey && <div class="text-zinc-500">위에서 그룹을 선택하세요.</div>}
      {groupKey && !data && <div class="text-zinc-500">Loading…</div>}
      {data?.error === "not_found" && <div class="text-red-400">그룹 없음</div>}

      {data && !data.error && (
        <>
          <section class="flex items-center gap-4 rounded-lg border border-zinc-800 p-3">
            <div class={`grid h-20 w-20 place-items-center rounded-full bg-zinc-950 ring-2 ${GRADE_RING[data.health_score?.grade ?? "PRE"]}`}>
              <div class="text-2xl font-bold">{data.health_score?.total ?? "—"}</div>
              <div class="text-[10px] text-zinc-400">{data.health_score?.grade ?? "PRE"}</div>
            </div>
            <div>
              <div class="text-lg font-semibold">{data.name} <span class="text-zinc-500 text-sm">· {data.name_kr}</span></div>
              <div class="text-xs text-zinc-400">{data.health_score?.label ?? "데뷔 전 (활동량 부족)"}</div>
              <HealthSpec />
            </div>
          </section>

          <section class="grid grid-cols-2 gap-2 md:grid-cols-5">
            <KPI label="Videos" value={data.summary?.yt_total_videos ?? 0} />
            <KPI label="Views"  value={data.summary?.yt_total_views ?? 0} />
            <KPI label="Subs"   value={data.summary?.yt_subscribers ?? 0} />
            <KPI label="DC"     value={data.summary?.dc_total_posts ?? 0} />
            <KPI label="News"   value={data.summary?.naver_total_news ?? 0} />
          </section>

          <section class="rounded-lg border border-zinc-800 p-3">
            <div class="mb-2 flex items-center text-sm">
              <h3 class="font-semibold">YouTube Top 15</h3>
              <ExportMenu rows={data.yt_top15} filenameBase={`${groupKey}-yt-top15`} />
            </div>
            <table class="w-full text-xs">
              <thead><tr class="text-left text-zinc-500">
                <th class="py-1">#</th><th>Title</th><th>Type</th><th class="text-right">Views</th><th class="text-right">Likes</th>
              </tr></thead>
              <tbody>
                {data.yt_top15.map((v: any, i: number) => (
                  <tr key={v.video_id} class="border-t border-zinc-800/60">
                    <td class="py-1">{i + 1}</td>
                    <td class="max-w-md truncate">{v.title}</td>
                    <td><span class="rounded bg-zinc-800 px-1.5 text-[10px]">{v.content_type ?? "—"}</span></td>
                    <td class="text-right">{fmt(v.views)}</td>
                    <td class="text-right">{fmt(v.likes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
