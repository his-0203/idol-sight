import { useEffect, useMemo, useState } from "preact/hooks";
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

type ContentFilter = "all" | "MV" | "Cover" | "Short" | "Live";
const CONTENT_FILTERS: Array<{ key: ContentFilter; label: string }> = [
  { key: "all", label: "전체" },
  { key: "MV", label: "MV" },
  { key: "Cover", label: "Cover" },
  { key: "Short", label: "Short" },
  { key: "Live", label: "Live" },
];

export function GroupContent({ groupKey }: { groupKey: string | null }) {
  const [groups, setGroups] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [contentFilter, setContentFilter] = useState<ContentFilter>("all");

  useEffect(() => { api.groups().then((r) => setGroups(r.groups)); }, []);
  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    setContentFilter("all");
    api.group(groupKey).then(setData).catch(() => setData({ error: "not_found" }));
  }, [groupKey]);

  const yt15 = data?.yt_top15 ?? [];
  const filteredYt = useMemo(() => {
    if (contentFilter === "all") return yt15;
    return yt15.filter((v: any) => v.content_type === contentFilter);
  }, [yt15, contentFilter]);

  return (
    <div class="space-y-4">
      <div class="flex items-center gap-2 text-sm">
        <label class="text-zinc-500">Group</label>
        <select
          class="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1"
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

      {data && !data.error && (() => {
        const hs = data.health_score;
        const hasHealth = hs != null && hs.total != null;
        const fallback = data.summary?.yt_subscribers ?? data.summary?.yt_total_views ?? null;
        return (
        <>
          <section class="flex items-center gap-4 rounded-lg border border-zinc-800 p-3">
            <div class={`grid h-20 w-20 place-items-center rounded-full bg-zinc-950 ring-2 ${GRADE_RING[hasHealth ? hs.grade : "PRE"]}`}>
              <div class="text-2xl font-bold tabular-nums">
                {hasHealth ? hs.total : (fallback != null ? fmt(fallback) : "—")}
              </div>
              <div class="text-xs text-zinc-400">
                {hasHealth ? hs.grade : "집계 대기"}
              </div>
            </div>
            <div>
              <div class="text-lg font-semibold">{data.name} <span class="text-zinc-500 text-sm">· {data.name_kr}</span></div>
              <div class="text-xs text-zinc-400">
                {hasHealth ? hs.label : (fallback != null ? "구독자 (점수 미산출)" : "데뷔 전 (활동량 부족)")}
              </div>
              <HealthSpec />
            </div>
          </section>

          <section class="grid grid-cols-2 gap-2 md:grid-cols-5">
            <KPI label="영상"   value={data.summary?.yt_total_videos ?? 0} />
            <KPI label="조회수" value={data.summary?.yt_total_views ?? 0} unit="(누적)" />
            <KPI label="구독자" value={data.summary?.yt_subscribers ?? 0} />
            <KPI label="DC 글" value={data.summary?.dc_total_posts ?? 0} />
            <KPI label="뉴스"   value={data.summary?.naver_total_news ?? 0} />
          </section>

          <section class="rounded-lg border border-zinc-800 p-3">
            <div class="mb-2 flex flex-wrap items-center gap-2 text-sm">
              <h3 class="font-semibold">YouTube Top 15</h3>
              <div class="flex flex-wrap items-center gap-1">
                {CONTENT_FILTERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    class={"rounded-md border px-2 py-0.5 text-xs transition-colors " +
                           (contentFilter === f.key
                             ? "border-violet-500 bg-violet-500/10 text-violet-300"
                             : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
                    onClick={() => setContentFilter(f.key)}
                  >{f.label}</button>
                ))}
              </div>
              <ExportMenu rows={filteredYt} filenameBase={`${groupKey}-yt-top15`} />
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead><tr class="text-left text-zinc-500">
                  <th class="py-1">#</th><th>제목</th><th>유형</th><th class="text-right">조회수</th><th class="text-right">좋아요</th>
                </tr></thead>
                <tbody>
                  {filteredYt.map((v: any, i: number) => (
                    <tr key={v.video_id} class="border-t border-zinc-800/60">
                      <td class="py-1">{i + 1}</td>
                      <td class="max-w-md truncate">{v.title}</td>
                      <td><span class="rounded bg-zinc-800 px-1.5 text-xs">{v.content_type ?? "—"}</span></td>
                      <td class="text-right tabular-nums">{fmt(v.views)}</td>
                      <td class="text-right tabular-nums">{fmt(v.likes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filteredYt.length === 0 && (
                <div class="py-4 text-center text-xs text-zinc-500">필터 결과 없음</div>
              )}
            </div>
          </section>
        </>
        );
      })()}
    </div>
  );
}
