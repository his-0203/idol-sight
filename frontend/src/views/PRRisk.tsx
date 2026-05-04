import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { KPI } from "../components/KPI";

export function PRRisk({ groupKey }: { groupKey: string | null }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    api.group(groupKey).then(setData);
  }, [groupKey]);
  if (!groupKey) return <div class="text-zinc-500">상단에서 그룹을 선택하세요.</div>;
  if (!data) return <div class="text-zinc-500">Loading…</div>;

  const news = data.naver_articles ?? [];
  const tweets = data.twitter_posts ?? [];
  const controversy = tweets.filter((t: any) => t.type === "controversy").length;
  const riskLevel = controversy >= 3 ? "MED" : controversy >= 1 ? "LOW" : "OK";

  return (
    <div class="space-y-4">
      {controversy > 0 && (
        <div class={"rounded border px-3 py-2 text-sm " +
                    (controversy >= 3
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                      : "border-zinc-700 bg-zinc-900/40 text-zinc-300")}>
          ⚠️ Controversy 트윗 {controversy}건 (Risk: {riskLevel})
        </div>
      )}
      <section class="grid grid-cols-3 gap-2">
        <KPI label="News" value={news.length} />
        <KPI label="Twitter" value={tweets.length} />
        <KPI label="Controversy" value={controversy} hint={`Risk: ${riskLevel}`} />
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">최근 뉴스</h3>
        <ul class="space-y-1 text-xs">
          {news.map((n: any, i: number) => (
            <li key={i}>
              <a class="hover:underline" href={n.url} target="_blank">{n.title}</a>
              <span class="ml-2 text-zinc-500">{n.source ?? ""} · {(n.published_at ?? "").slice(0, 10)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="mb-2 text-sm font-semibold">트위터/X</h3>
        <ul class="space-y-1 text-xs">
          {tweets.map((t: any) => (
            <li key={t.tweet_id}>
              <span class={"mr-1 rounded px-1.5 text-[10px] " +
                           (t.type === "controversy" ? "bg-red-500/20 text-red-300"
                            : t.type === "news" ? "bg-blue-500/20 text-blue-300"
                            : t.type === "event" ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-zinc-800 text-zinc-400")}>{t.type}</span>
              <a class="hover:underline" href={t.url} target="_blank">{t.title}</a>
              <span class="ml-2 text-zinc-500">@{t.author_handle}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
