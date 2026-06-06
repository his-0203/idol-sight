import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { writeState } from "../router";
import { ExportMenu } from "../components/ExportMenu";
import { EmptyState } from "../components/EmptyState";
import { GroupTabs } from "../components/GroupTabs";
import { formatKST, formatKSTDate } from "../lib/datetime";

// Notices, vote/poll templates, and other sticky moderator posts dominate
// "top by views" lists without reflecting fan activity, so we hide them by
// default and let the user re-enable.
const NOTICE_RE = /공지|가이드|호출벨|투표|원격|마플|notice|sticky/i;

type SortKey = "views" | "engagement" | "latest" | "oldest";

// posted_at fallback to collected_at — instiz hot list doesn't expose a
// per-post timestamp so posted_at is NULL; collected_at is then the only
// reliable ordering signal. Returns null when both are missing so the
// sort can push the row to the end deterministically.
const tsOf = (p: any): number | null => {
  const s = p?.posted_at ?? p?.collected_at;
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
type Sentiment = "positive" | "negative" | "controversy" | "neutral" | null | undefined;

const SENTIMENT_BADGE: Record<Exclude<Sentiment, null | undefined>, { label: string; cls: string }> = {
  positive:    { label: "긍정", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  negative:    { label: "부정", cls: "border-orange-500/40 bg-orange-500/10 text-orange-300" },
  controversy: { label: "논란", cls: "border-red-500/40 bg-red-500/10 text-red-300" },
  neutral:     { label: "중립", cls: "border-zinc-700 bg-zinc-800/40 text-zinc-400" },
};

export function Community({ groupKey, period }: { groupKey: string | null; period: number | null }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [includeNotices, setIncludeNotices] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("views");
  // null = 전체. 플랫폼 필터는 URL state 미사용 — 그룹 전환 시
  // 자동 reset 되어야 자연스러워서(다른 그룹의 platform 분포가 다름)
  // useState 만 사용한다. 같은 이유로 sortKey 도 URL state 가 아님.
  const [platform, setPlatform] = useState<string | null>(null);
  // Tracks rows the operator has flagged in this session so they
  // disappear immediately without a refetch. The server persists the
  // flag, so a reload would also exclude them — this is purely a UX
  // optimization for the round-trip.
  const [flagged, setFlagged] = useState<Record<string, "pending" | "done" | "error">>({});

  useEffect(() => {
    if (!groupKey) return;
    setData(null);
    setErr(null);
    setFlagged({});
    setPlatform(null);
    api.group(groupKey).then(setData).catch((e) => setErr(String(e)));
  }, [groupKey]);

  // 데이터에 실제로 존재하는 플랫폼만 필터 버튼으로 노출 — 그룹마다
  // 분포가 다르고(예: 데뷔 전 MiiWAN 은 dc / naver 위주) 비활성
  // 옵션을 보여줘 봐야 클릭하면 빈 목록.
  const platformOptions = useMemo(() => {
    const list = data?.community_top ?? [];
    const set = new Set<string>();
    for (const p of list) if (p?.platform) set.add(String(p.platform));
    return Array.from(set).sort();
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const cutoff = period ? Date.now() - period * 86400_000 : 0;
    let r = (data.community_top ?? []).filter((p: any) =>
      !period || (p.posted_at && Date.parse(p.posted_at) >= cutoff)
    );
    if (!includeNotices) {
      r = r.filter((p: any) => !NOTICE_RE.test(p.title ?? ""));
    }
    if (platform) {
      r = r.filter((p: any) => p.platform === platform);
    }
    r = r.filter((p: any) => flagged[p.url_hash] !== "done");
    if (sortKey === "engagement") {
      // engagement_rate = likes per 1000 views; views=0 → 0 to keep ordering stable.
      const score = (p: any) => {
        const v = Number(p.views ?? 0);
        const l = Number(p.likes ?? 0);
        return v > 0 ? (l / v) * 1000 : 0;
      };
      r = [...r].sort((a: any, b: any) => score(b) - score(a));
    } else if (sortKey === "latest" || sortKey === "oldest") {
      // NULL 타임스탬프는 항상 마지막으로 — 최신순/오래된순 어느 방향이든
      // 비교 불가능한 row 가 결과 상단을 흐리지 않도록.
      const dir = sortKey === "latest" ? -1 : 1;
      r = [...r].sort((a: any, b: any) => {
        const ta = tsOf(a);
        const tb = tsOf(b);
        if (ta === null && tb === null) return 0;
        if (ta === null) return 1;
        if (tb === null) return -1;
        return dir * (ta - tb);
      });
    } else {
      r = [...r].sort((a: any, b: any) => (Number(b.views ?? 0)) - (Number(a.views ?? 0)));
    }
    return r;
  }, [data, period, includeNotices, sortKey, platform, flagged]);

  if (!groupKey) {
    return (
      <div class="space-y-4">
        <GroupTabs />
        <EmptyState
          title="그룹을 선택하세요"
          hint="상단 시장 개요 카드 또는 Cmd+K 검색에서 그룹을 고르면 커뮤니티 게시글이 표시됩니다."
          icon="👆"
        />
      </div>
    );
  }
  if (err) return (
    <div class="space-y-4">
      <GroupTabs />
      <div class="text-rose-400">불러오기 실패: {err}</div>
    </div>
  );
  if (!data) return (
    <div class="space-y-4">
      <GroupTabs />
      <div class="text-zinc-500">Loading…</div>
    </div>
  );

  async function flagRow(p: any) {
    if (!p.url_hash || flagged[p.url_hash]) return;
    setFlagged((s) => ({ ...s, [p.url_hash]: "pending" }));
    try {
      await api.flagIrrelevant({
        url_hash: p.url_hash,
        group_key: groupKey!,
        reason: "user_irrelevant",
      });
      setFlagged((s) => ({ ...s, [p.url_hash]: "done" }));
    } catch {
      setFlagged((s) => ({ ...s, [p.url_hash]: "error" }));
    }
  }

  return (
    <div class="space-y-4">
      <GroupTabs />
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
          { key: "latest", label: "최신순" },
          { key: "oldest", label: "오래된순" },
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

        {platformOptions.length > 1 && (
          <>
            <span class="ml-2 text-zinc-500">플랫폼</span>
            <button
              type="button"
              class={"rounded-md border px-3 py-1.5 text-xs transition-colors " +
                     (platform === null
                       ? "border-violet-500 bg-violet-500/10 text-violet-300"
                       : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
              onClick={() => setPlatform(null)}
            >전체</button>
            {platformOptions.map((pl) => (
              <button
                key={pl}
                type="button"
                class={"rounded-md border px-3 py-1.5 text-xs transition-colors " +
                       (platform === pl
                         ? "border-violet-500 bg-violet-500/10 text-violet-300"
                         : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
                onClick={() => setPlatform(pl)}
              >{pl}</button>
            ))}
          </>
        )}

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
            <th class="py-1">#</th><th>플랫폼</th><th>감정</th><th>제목</th>
            <th class="text-right">조회수</th><th class="text-right">좋아요</th><th>날짜 (KST)</th><th></th>
          </tr></thead>
          <tbody>
            {rows.map((p: any, i: number) => {
              const sentiment: Sentiment = p.sentiment ?? null;
              const badge = sentiment ? SENTIMENT_BADGE[sentiment as keyof typeof SENTIMENT_BADGE] : null;
              const flagState = flagged[p.url_hash];
              return (
                <tr
                  key={p.url_hash ?? p.url}
                  class={"border-t border-zinc-800/60 " +
                    (sentiment === "controversy" ? "bg-red-500/5 " :
                     sentiment === "negative" ? "bg-orange-500/5 " : "")}
                >
                  <td class="py-1 text-zinc-500 tabular-nums">{i + 1}</td>
                  <td><span class="rounded bg-zinc-800 px-1.5 text-xs">{p.platform}</span></td>
                  <td>
                    {badge ? (
                      <span class={`rounded border px-1.5 text-[11px] ${badge.cls}`}>{badge.label}</span>
                    ) : (
                      <span class="text-zinc-600">—</span>
                    )}
                  </td>
                  <td class="max-w-md truncate">
                    <a class="hover:underline" href={p.url} target="_blank" rel="noopener">{p.title}</a>
                  </td>
                  <td class="text-right tabular-nums">{fmt(p.views)}</td>
                  <td class="text-right tabular-nums">{fmt(p.likes)}</td>
                  <td class="text-zinc-500" title={p.posted_at ? formatKST(p.posted_at) : undefined}>
                    {formatKSTDate(p.posted_at)}
                  </td>
                  <td class="text-right">
                    <button
                      type="button"
                      onClick={() => flagRow(p)}
                      disabled={!p.url_hash || flagState === "pending" || flagState === "done"}
                      title="이 게시글을 무관(noise)으로 신고. 신고된 행은 즉시 숨겨지고 다음 수집부터 학습에 반영됩니다."
                      class={"rounded border px-2 py-0.5 text-[11px] transition-colors " +
                        (flagState === "error"
                          ? "border-red-500/40 text-red-300"
                          : flagState === "pending"
                          ? "border-zinc-700 text-zinc-500"
                          : "border-zinc-700 text-zinc-400 hover:border-amber-500/60 hover:text-amber-300")}
                    >
                      {flagState === "pending" ? "..." : flagState === "error" ? "재시도" : "⚠ 무관"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <div class="text-zinc-500">조건에 맞는 게시물 없음.</div>}
    </div>
  );
}
