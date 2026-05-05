import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import Chart from "chart.js/auto";
import { api } from "../api";
import { fmt } from "../format";
import { writeState } from "../router";
import { FreshnessBadge } from "../components/FreshnessBadge";
import { ExportMenu } from "../components/ExportMenu";
import { ShareLink } from "../components/ShareLink";
import { HealthSpec } from "../components/HealthSpec";
import { colorOf, fillOf } from "../design/groups";
import { gradeClasses } from "../design/grades";
import { fmtScale, fmtTooltipCallback } from "../design/chart-defaults";

// Category derived from worker's group_model taxonomy (migration 0007).
//   corporate     → K-POP (album-cycle, 음방, 컴백)
//   segmentary    → 서브컬처 (왁타버스 위성)
//   confederation → 서브컬처 (V-tuber 우산)
// Splitting cards into category sections is what keeps ranks readable.
// Mixing PLAVE (corporate K-pop) and STELLIVE (V-tuber confederation) on
// one ranked grid implies they compete on the same plane, which they
// don't — their KPIs are weighted differently in Health Score itself.
type Category = "kpop" | "subculture";

const CATEGORY_LABEL: Record<Category, string> = {
  kpop:       "K-POP",
  subculture: "서브컬처",
};

const CATEGORY_HINT: Record<Category, string> = {
  kpop:       "Corporate (음반·음방·컴백 사이클)",
  subculture: "Segmentary / Confederation (스트리밍·라이브·V-tuber)",
};

function categoryOf(groupModel: string | null | undefined): Category {
  if (groupModel === "segmentary" || groupModel === "confederation") return "subculture";
  return "kpop";
}

// Grade ordering — used as the primary sort key inside each category
// section so the operator sees ranks at a glance. PRE (pre-debut) is
// last because the grade is a placeholder, not an achievement.
const GRADE_ORDER: Record<string, number> = {
  S: 0, A: 1, B: 2, C: 3, D: 4, PRE: 5,
};

function gradeRank(grade: string | null | undefined): number {
  const fallback = GRADE_ORDER.PRE ?? 99;
  return GRADE_ORDER[grade ?? "PRE"] ?? fallback;
}

// Sort: grade ASC (S first) → total DESC → SOV DESC → name ASC.
// `latestShareByKey` is read from share.rows so groups missing a Health
// Score still get a sensible secondary order from cohort percentile.
function sortByRank(
  entries: Array<[string, any]>,
  latestShareByKey: Record<string, number>,
): Array<[string, any]> {
  return [...entries].sort(([ka, ga], [kb, gb]) => {
    const gradeDiff = gradeRank(ga.health_score?.grade) - gradeRank(gb.health_score?.grade);
    if (gradeDiff !== 0) return gradeDiff;
    const totalDiff = (gb.health_score?.total ?? -1) - (ga.health_score?.total ?? -1);
    if (totalDiff !== 0) return totalDiff;
    const sovDiff = (latestShareByKey[kb] ?? 0) - (latestShareByKey[ka] ?? 0);
    if (sovDiff !== 0) return sovDiff;
    return (ga.name ?? "").localeCompare(gb.name ?? "");
  });
}

function latestShareMap(
  shareRows: Array<{ week_end: string; group_key: string; final: number }> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!shareRows?.length) return out;
  const latestWeek = [...new Set(shareRows.map((r) => r.week_end))].sort().pop();
  for (const r of shareRows) {
    if (r.week_end === latestWeek) out[r.group_key] = r.final ?? 0;
  }
  return out;
}

// Compute (currentWeekShare, previousWeekShare) per group_key from share.rows.
// Used to render the ▲/▼ delta chip on each card.
function shareDeltaByKey(
  shareRows: Array<{ week_end: string; group_key: string; final: number }> | undefined,
): Record<string, { current: number; prev: number | null }> {
  if (!shareRows || !shareRows.length) return {};
  const weeks = [...new Set(shareRows.map((r) => r.week_end))].sort();
  const current = weeks[weeks.length - 1];
  const prev = weeks.length >= 2 ? weeks[weeks.length - 2] : null;
  const out: Record<string, { current: number; prev: number | null }> = {};
  for (const r of shareRows) {
    const slot = out[r.group_key] ?? { current: 0, prev: null };
    if (r.week_end === current) slot.current = r.final ?? 0;
    if (prev && r.week_end === prev) slot.prev = r.final ?? 0;
    out[r.group_key] = slot;
  }
  return out;
}

export function MarketOverview() {
  const [market, setMarket] = useState<any>(null);
  const [share, setShare] = useState<any>(null);
  const [meta, setMeta] = useState<any>(null);
  const [excludePlave, setExcludePlave] = useState(false);
  const [activeCategory, setActiveCategory] = useState<"all" | Category>("all");
  const shareCanvas = useRef<HTMLCanvasElement | null>(null);
  const shareChart = useRef<Chart | null>(null);

  useEffect(() => {
    api.market().then(setMarket);
    api.marketShare(13).then(setShare);
    api.meta().then(setMeta);
  }, []);

  // Market share trend (line, color = group). We dropped the stacked-area
  // + log-scale combo because stacking + log is mathematically meaningless
  // (you cannot add log values), and a line per group reads more cleanly
  // on a small chart.
  useEffect(() => {
    if (!share || !shareCanvas.current) return;
    const ctx = shareCanvas.current;
    const weeks = Array.from(new Set<string>(share.rows.map((r: any) => r.week_end))).sort();
    const groupKeys = Array.from(new Set<string>(share.rows.map((r: any) => r.group_key)));
    const filtered = excludePlave ? groupKeys.filter((k) => k !== "plave") : groupKeys;
    const datasets = filtered.map((k) => ({
      label: k,
      data: weeks.map((w) => {
        const row = share.rows.find((r: any) => r.week_end === w && r.group_key === k);
        return row?.final ?? 0;
      }),
      borderColor: colorOf(k),
      backgroundColor: fillOf(k, 0.15),
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.25,
      fill: false,
    }));
    shareChart.current?.destroy();
    shareChart.current = new Chart(ctx, {
      type: "line",
      data: { labels: weeks, datasets },
      options: {
        scales: {
          y: {
            title: { display: true, text: "점유율 (%)" },
            ticks: { callback: (v) => fmtScale(v as number) },
          },
          x: { title: { display: true, text: "주차" } },
        },
        plugins: {
          legend: { position: "bottom" },
          tooltip: { callbacks: { label: fmtTooltipCallback() } },
        },
      },
    });
  }, [share, excludePlave]);

  const sharesByKey = useMemo(() => latestShareMap(share?.rows), [share]);
  const deltas = useMemo(() => shareDeltaByKey(share?.rows), [share]);

  // Split into category buckets and rank within each. The same sort
  // function is reused so cross-section ordering is internally
  // consistent (e.g. an A-grade subculture group above a B-grade
  // subculture group, never re-shuffled by category mixing).
  const sectioned = useMemo(() => {
    if (!market) return { kpop: [], subculture: [] } as Record<Category, Array<[string, any]>>;
    const all = Object.entries(market.groups);
    const kpop = all.filter(([, g]: any) => categoryOf(g.group_model) === "kpop");
    const sub  = all.filter(([, g]: any) => categoryOf(g.group_model) === "subculture");
    return {
      kpop:       sortByRank(kpop, sharesByKey),
      subculture: sortByRank(sub,  sharesByKey),
    };
  }, [market, sharesByKey]);

  if (!market) return <div class="p-4 text-zinc-500">Loading…</div>;

  const sectionsToRender: Category[] =
    activeCategory === "all" ? ["kpop", "subculture"] : [activeCategory];

  return (
    <div class="space-y-6">
      {/* freshness banner */}
      <div class="flex flex-wrap items-center gap-2">
        {meta && (
          <FreshnessBadge label="전체"
            lastSuccessAt={meta.global_last_success_at}
            intervalH={1} />
        )}
        <div class="ml-auto flex items-center gap-1">
          <ShareLink />
        </div>
      </div>

      {/* Category filter — explicit toggle is helpful when the operator
          wants to focus on a single cohort (e.g. comparing only K-POP
          newcomers to MiiWAN's launch curve). Default 'all' shows both
          sections stacked so ranks within each cohort are visible. */}
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="text-zinc-500">코호트</span>
        {([
          { key: "all" as const,        label: "전체" },
          { key: "kpop" as const,       label: "K-POP" },
          { key: "subculture" as const, label: "서브컬처" },
        ]).map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setActiveCategory(c.key)}
            class={"rounded-md border px-3 py-1 text-xs transition-colors " +
              (activeCategory === c.key
                ? "border-violet-500 bg-violet-500/10 text-violet-300"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800")}
          >{c.label}</button>
        ))}
      </div>

      {/* Per-category card grids — each section ranked grade DESC →
          total DESC → SOV DESC. A numeric rank chip removes any doubt
          about the order even when neighbouring cards share a grade. */}
      {sectionsToRender.map((category) => {
        const entries = sectioned[category];
        if (!entries.length) return null;
        return (
          <section key={category}>
            <div class="mb-2 flex flex-wrap items-baseline gap-2">
              <h3 class="section-title">{CATEGORY_LABEL[category]}</h3>
              <span class="text-hint text-zinc-500">{CATEGORY_HINT[category]}</span>
              <span class="ml-auto text-hint text-zinc-500">{entries.length}그룹</span>
            </div>
            <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
              {entries.map(([key, g]: any, i: number) => {
                const hs = g.health_score;
                const grade = hs?.grade ?? "PRE";
                const total = hs?.total;
                const fallback = g.summary?.yt_subscribers ?? g.summary?.yt_total_views ?? null;
                const d = deltas[key];
                const dpp = d && d.prev != null ? d.current - d.prev : null;
                const tier = i === 0 ? "primary" : i < 2 ? "base" : "muted";
                return (
                  <button
                    key={key}
                    onClick={() => writeState({ tab: "content", group: key })}
                    class={
                      "card border-l-4 p-3 text-left transition-colors hover:border-brand " +
                      (tier === "muted" ? "opacity-80 " : "")
                    }
                    style={{ borderLeftColor: colorOf(key) }}
                    aria-label={`${g.name} 상세 보기`}
                  >
                    <div class="flex items-baseline gap-2">
                      <span class="rounded bg-zinc-800/80 px-1.5 text-[11px] font-bold tabular-nums text-zinc-300">
                        #{i + 1}
                      </span>
                      <div class="font-semibold">{g.name}</div>
                      {dpp != null && (
                        <span
                          class={
                            "ml-auto rounded-chip border px-1.5 text-hint tabular-nums " +
                            (dpp > 0.05
                              ? "border-emerald-500/40 text-emerald-400"
                              : dpp < -0.05
                              ? "border-red-500/40 text-red-400"
                              : "border-zinc-700 text-zinc-500")
                          }
                        >
                          {dpp > 0 ? "▲" : dpp < 0 ? "▼" : "·"} {Math.abs(dpp).toFixed(1)}pp
                        </span>
                      )}
                    </div>
                    <div class="text-hint text-zinc-500">{g.name_kr}</div>
                    <div class={`mt-2 flex items-baseline gap-2 ${tier === "primary" ? "text-3xl" : tier === "base" ? "text-2xl" : "text-xl"}`}>
                      <span class={`rounded-chip border px-2 font-bold ${gradeClasses(grade)}`}>
                        {grade}
                      </span>
                      <span class="text-hint text-zinc-500 tabular-nums">
                        {total != null
                          ? `${total}점`
                          : fallback != null
                          ? `${fmt(fallback)} 구독`
                          : "집계 대기"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      {/* SOV (Share of Voice) — line chart for ≥2 weeks, bar fallback for 1 week.
          Renamed from "Market Share" in V2: the 8-group cohort isn't a real
          market with a defined denominator (Circle Chart, etc.), so the
          honest label is Share of Voice. The SOV mix is now percentile-rank
          weighted across yt_views (30%) / community (25%) / news (20%) /
          subscribers (15%) / twitter (10%) instead of raw-summing different
          unit signals. */}
      {(() => {
        const distinctWeeks = share
          ? Array.from(new Set<string>(share.rows.map((r: any) => r.week_end)))
          : [];
        const hasTrend = distinctWeeks.length >= 2;
        return (
          <section class="card">
            <div class="mb-2 flex flex-wrap items-center gap-2 text-data">
              <h3 class="section-title">
                Share of Voice {hasTrend ? "Trend (13주)" : "(현재 주)"}
              </h3>
              <span class="text-hint text-zinc-500">
                코호트 percentile 가중합 — yt 30% / 커뮤 25% / 뉴스 20% / 구독 15% / 트윗 10%
              </span>
              <HealthSpec />
              {hasTrend && (
                <label class="ml-auto flex items-center gap-1 text-hint text-zinc-400">
                  <input type="checkbox" checked={excludePlave}
                         onChange={(e: any) => setExcludePlave(e.currentTarget.checked)} />
                  PLAVE 제외
                </label>
              )}
              <ExportMenu canvas={shareCanvas.current ?? undefined}
                           rows={share?.rows ?? []}
                           filenameBase="share-of-voice" />
            </div>
            {hasTrend ? (
              <div class="h-48 md:h-72"><canvas ref={shareCanvas}></canvas></div>
            ) : share && share.rows.length > 0 ? (
              <>
                <div class="mb-2 text-hint text-zinc-500">
                  추이 그래프는 데이터 2주 이상 누적 시 활성화됩니다 (현재 1주차).
                  지금은 이번 주 점유율만 표시.
                </div>
                <ul class="space-y-1.5">
                  {[...share.rows].sort((a: any, b: any) => b.final - a.final).map((r: any) => (
                    <li key={r.group_key} class="flex items-center gap-2 text-data">
                      <span class="w-20 shrink-0 truncate"
                            style={{ color: colorOf(r.group_key) }}>
                        {(market.groups[r.group_key]?.name) ?? r.group_key.toUpperCase()}
                      </span>
                      <div class="relative h-2 flex-1 overflow-hidden rounded bg-zinc-800/60">
                        <div class="absolute inset-y-0 left-0"
                             style={{
                               width: `${Math.min(r.final, 100)}%`,
                               background: colorOf(r.group_key),
                             }} />
                      </div>
                      <span class="w-14 shrink-0 text-right tabular-nums">
                        {r.final.toFixed(1)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div class="text-hint text-zinc-500">아직 점유율 데이터가 없습니다.</div>
            )}
          </section>
        );
      })()}
    </div>
  );
}
