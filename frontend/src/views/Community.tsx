import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { writeState } from "../router";
import { ExportMenu } from "../components/ExportMenu";

// Notices, vote/poll templates, and other sticky moderator posts dominate
// "top by views" lists without reflecting fan activity, so we hide them by
// default and let the user re-enable.
const NOTICE_RE = /공지|가이드|호출벨|투표|원격|마플|notice|sticky/i;

type SortKey = "views" | "engagement";

export function Community({ groupKey, period }: { groupKey: string | null; period: number | null }) {
  const [data, setData] = useState<any>(null);
  const [includeNotices, setIncludeNotices] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("views");

  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    api.group(groupKey).then(setData);
  }, [groupKey]);

  const rows = useMemo(() => {
    if (!data) return [];
    const cutoff = period ? Date.now() - period * 86400_000 : 0;
    let r = (data.community_top ?? []).filter((p: any) =>
      !period || (p.posted_at && Date.parse(p.posted_at) >= cutoff)
    );
    if (!includeNotices) {
      r = r.filter((p: any) => !NOTICE_RE.test(p.title ?? ""));
    }
    if (sortKey === "engagement") {
      // engagement_rate = likes per 1000 views; views=0 → 0 to keep ordering stable.
      const score = (p: any) => {
        const v = Number(p.views ?? 0);
        const l = Number(p.likes ?? 0);
        return v > 0 ? (l / v) * 1000 : 0;
      };
      r = [...r].sort((a: any, b: any) => score(b) - score(a));
    } else {
      r = [...r].sort((a: any, b: any) => (Number(b.views ?? 0)) - (Number(a.views ?? 0)));
    }
    return r;
  }, [data, period, includeNotices, sortKey]);

  if (!groupKey) return <div class="text-zinc-500">상단에서 그룹을 선택하세요.</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <label class="text-zinc-500">기간</label>
        {[null, 7, 30, 90].map((p) => (
          <button
            key={String(p)}
            type="button"
            class={"rounded-md border px-3 py-1.5 text-xs transition-colors " +
                   (period === p
                     ? "border-violet-500 bg-violet-500/10 text-violet-300"
                     : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
            onClick={() => writeState({ period: p })}
          >{p ? `${p}일` : "전체"}</button>
        ))}

        <span class="ml-2 text-zinc-500">정렬</span>
        {([
          { key: "views", label: "조회수" },
          { key: "engagement", label: "참여율" },
        ] as Array<{ key: SortKey; label: string }>).map((s) => (
          <button
            key={s.key}
            type="button"
            class={"rounded-md border px-3 py-1.5 text-xs transition-colors " +
                   (sortKey === s.key
                     ? "border-violet-500 bg-violet-500/10 text-violet-300"
                     : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
            onClick={() => setSortKey(s.key)}
          >{s.label}</button>
        ))}

        <label class="ml-2 flex cursor-pointer items-center gap-1 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={includeNotices}
            onChange={(e: any) => setIncludeNotices(e.currentTarget.checked)}
          />
          공지 포함
        </label>

        <ExportMenu rows={rows} filenameBase={`${groupKey}-community`} />
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead><tr class="text-left text-zinc-500">
            <th class="py-1">#</th><th>플랫폼</th><th>제목</th>
            <th class="text-right">조회수</th><th class="text-right">좋아요</th><th>날짜</th>
          </tr></thead>
          <tbody>
            {rows.map((p: any, i: number) => (
              <tr key={p.url} class="border-t border-zinc-800/60">
                <td class="py-1">{i + 1}</td>
                <td><span class="rounded bg-zinc-800 px-1.5 text-xs">{p.platform}</span></td>
                <td class="max-w-md truncate"><a class="hover:underline" href={p.url} target="_blank">{p.title}</a></td>
                <td class="text-right tabular-nums">{fmt(p.views)}</td>
                <td class="text-right tabular-nums">{fmt(p.likes)}</td>
                <td class="text-zinc-500">{(p.posted_at ?? "").slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <div class="text-zinc-500">조건에 맞는 게시물 없음.</div>}
    </div>
  );
}
