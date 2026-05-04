import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { writeState } from "../router";
import { ExportMenu } from "../components/ExportMenu";

export function Community({ groupKey, period }: { groupKey: string | null; period: number | null }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    api.group(groupKey).then(setData);
  }, [groupKey]);
  if (!groupKey) return <div class="text-zinc-500">상단에서 그룹을 선택하세요.</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;

  // Apply period filter client-side.
  const cutoff = period ? Date.now() - period * 86400_000 : 0;
  const rows = (data.community_top ?? []).filter((p: any) =>
    !period || (p.posted_at && Date.parse(p.posted_at) >= cutoff)
  );

  return (
    <div class="space-y-4">
      <div class="flex items-center gap-2 text-sm">
        <label class="text-zinc-500">기간</label>
        {[null, 7, 30, 90].map((p) => (
          <button
            key={String(p)}
            class={"rounded border px-2 py-0.5 text-xs " +
                   (period === p
                     ? "border-violet-500 bg-violet-500/10 text-violet-300"
                     : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
            onClick={() => writeState({ period: p })}
          >{p ? `${p}일` : "전체"}</button>
        ))}
        <ExportMenu rows={rows} filenameBase={`${groupKey}-community`} />
      </div>
      <table class="w-full text-xs">
        <thead><tr class="text-left text-zinc-500">
          <th class="py-1">#</th><th>Platform</th><th>Title</th>
          <th class="text-right">Views</th><th class="text-right">Likes</th><th>Date</th>
        </tr></thead>
        <tbody>
          {rows.map((p: any, i: number) => (
            <tr key={p.url} class="border-t border-zinc-800/60">
              <td class="py-1">{i + 1}</td>
              <td><span class="rounded bg-zinc-800 px-1.5 text-[10px]">{p.platform}</span></td>
              <td class="max-w-md truncate"><a class="hover:underline" href={p.url} target="_blank">{p.title}</a></td>
              <td class="text-right">{fmt(p.views)}</td>
              <td class="text-right">{fmt(p.likes)}</td>
              <td class="text-zinc-500">{(p.posted_at ?? "").slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div class="text-zinc-500">기간 내 게시물 없음.</div>}
    </div>
  );
}
