import { useMemo, useState } from "preact/hooks";
import { fmt, pct } from "../format";
import {
  sortShorts, isFresh, daysSince,
  type TrendShort, type TrendSort,
} from "../lib/shortsTrend";

const SORT_LABEL: Record<TrendSort, string> = {
  fresh: "신선 우선", velocity: "velocity", views: "조회수", recent: "최신순",
};

function erOf(s: TrendShort): number | null {
  if (!s.views) return null;
  return ((s.likes ?? 0) + (s.comments ?? 0)) / s.views * 100;
}

function velocityDisplay(s: TrendShort, now: number): string {
  if (s.viral_velocity_ratio != null) return `${s.viral_velocity_ratio.toFixed(1)}×`;
  const d = daysSince(s.published_at, now);
  return d != null && d < 2 ? "측정중" : "—";
}

export function ShortsTrendTable(
  { rows, groups, windowDays, limit }:
  { rows: TrendShort[]; groups: Array<{ key: string; name_kr: string }>;
    windowDays: number; limit: number },
) {
  const now = Date.now();
  const [sort, setSort] = useState<TrendSort>("fresh");
  const [group, setGroup] = useState<string>("all");
  const [type, setType] = useState<string>("all");
  const [freshOnly, setFreshOnly] = useState(false);

  const contentTypes = useMemo(
    () => Array.from(new Set(rows.map((r) => r.content_type).filter((x): x is string => !!x))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    let r = rows;
    if (group !== "all") r = r.filter((x) => x.group_key === group);
    if (type !== "all") r = r.filter((x) => x.content_type === type);
    if (freshOnly) r = r.filter((x) => isFresh(x, now));
    return sortShorts(r, sort, now);
  }, [rows, group, type, freshOnly, sort, now]);

  return (
    <section>
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <h2 class="text-lg font-bold">경쟁사 숏폼 트렌드</h2>
        <span class="text-hint text-zinc-500">최근 {windowDays}일 · 최대 {limit}편</span>
      </div>

      <div class="mb-3 flex flex-wrap gap-2 text-data">
        <select class="rounded-ctrl border border-zinc-800 bg-zinc-900 px-2 py-1"
          value={group} onChange={(e) => setGroup((e.target as HTMLSelectElement).value)}>
          <option value="all">전체 그룹</option>
          {groups.map((g) => <option key={g.key} value={g.key}>{g.name_kr}</option>)}
        </select>
        <select class="rounded-ctrl border border-zinc-800 bg-zinc-900 px-2 py-1"
          value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)}>
          <option value="all">전체 타입</option>
          {contentTypes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select class="rounded-ctrl border border-zinc-800 bg-zinc-900 px-2 py-1"
          value={sort} onChange={(e) => setSort((e.target as HTMLSelectElement).value as TrendSort)}>
          {(Object.keys(SORT_LABEL) as TrendSort[]).map((k) => (
            <option key={k} value={k}>{SORT_LABEL[k]}</option>
          ))}
        </select>
        <label class="flex items-center gap-1.5 text-zinc-400">
          <input type="checkbox" checked={freshOnly}
            onChange={(e) => setFreshOnly((e.target as HTMLInputElement).checked)} />
          🔥 신선만
        </label>
      </div>

      {filtered.length === 0 ? (
        <p class="text-zinc-400">최근 {windowDays}일 내 경쟁사 숏폼이 없습니다.</p>
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full text-data">
            <thead class="text-hint uppercase text-zinc-500">
              <tr>
                <th class="px-2 py-1.5 text-left"></th>
                <th class="px-2 py-1.5 text-left">그룹</th>
                <th class="px-2 py-1.5 text-left">제목</th>
                <th class="px-2 py-1.5 text-left">타입</th>
                <th class="px-2 py-1.5 text-right">게시</th>
                <th class="px-2 py-1.5 text-right">조회수</th>
                <th class="px-2 py-1.5 text-right">24h</th>
                <th class="px-2 py-1.5 text-right">velocity</th>
                <th class="px-2 py-1.5 text-right">ER</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => {
                const d = daysSince(s.published_at, now);
                return (
                  <tr key={s.video_id} class="border-t border-zinc-800/60">
                    <td class="px-2 py-1.5">{isFresh(s, now) ? "🔥" : ""}</td>
                    <td class="px-2 py-1.5 text-zinc-400">{s.group_name_kr}</td>
                    <td class="px-2 py-1.5">
                      <a class="hover:underline" target="_blank" rel="noreferrer"
                        href={`https://www.youtube.com/shorts/${s.video_id}`}>
                        {s.title ?? "(제목 없음)"}
                      </a>
                    </td>
                    <td class="px-2 py-1.5 text-zinc-500">{s.content_type ?? "—"}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums text-zinc-400">
                      {d == null ? "—" : `${d}일 전`}
                    </td>
                    <td class="px-2 py-1.5 text-right tabular-nums">{fmt(s.views)}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums text-zinc-400">{fmt(s.view_count_24h)}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums font-semibold">{velocityDisplay(s, now)}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums text-zinc-400">{pct(erOf(s))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
