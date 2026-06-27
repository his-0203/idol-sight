import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../format";
import { KPI } from "../components/KPI";
import { ExportMenu } from "../components/ExportMenu";
import { HealthSpec } from "../components/HealthSpec";
import { EmptyState } from "../components/EmptyState";
import { GroupTabs } from "../components/GroupTabs";
import { FanLoyaltyCard } from "../components/FanLoyaltyCard";
import { Sparkline } from "../components/Sparkline";
import { DebutWindowVideoTable } from "../components/DebutWindowVideoTable";
import { MelonChartHistory } from "../components/MelonChartHistory";
import { formatKSTDate, todayKST, daysBetweenKST } from "../lib/datetime";
import { gradeRingClass } from "../design/grades";
import { ALERT_SEVERITY_TONE as GROUP_ALERT_TONE } from "../lib/alerts";
import { writeState } from "../router";

// WoW delta helper — null-safe so a missing prev_summary (group has
// fewer than 7 days of history) renders nothing instead of "▲ NaN".
function wowDelta(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr == null || prev == null) return null;
  return curr - prev;
}

// Pull a single metric's 30d series out of summary_history. Returns
// undefined when no history exists so the KPI sparkline prop drops out.
function seriesOf(history: any[] | undefined, field: string): number[] | undefined {
  if (!history || history.length < 2) return undefined;
  return history.map((r) => Number(r[field] ?? 0));
}

type ContentFilter = "all" | "MV" | "Cover" | "Short" | "Live";
const CONTENT_FILTERS: Array<{ key: ContentFilter; label: string }> = [
  { key: "all", label: "전체" },
  { key: "MV", label: "MV" },
  { key: "Cover", label: "Cover" },
  { key: "Short", label: "Short" },
  { key: "Live", label: "Live" },
];

type CombinedMethod = "group_only" | "sum" | "weighted";

export function GroupContent({ groupKey }: { groupKey: string | null }) {
  const [data, setData] = useState<any>(null);
  const [contentFilter, setContentFilter] = useState<ContentFilter>("all");
  const [combinedMethod, setCombinedMethod] = useState<CombinedMethod>("sum");

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
      <GroupTabs />
      {!groupKey && (
        <EmptyState
          title="그룹을 선택하세요"
          hint="상단 시장 개요 카드 또는 Cmd+K 검색에서 그룹을 고르면 상세 분석이 표시됩니다."
          icon="👆"
        />
      )}
      {groupKey && !data && <div class="text-zinc-500">Loading…</div>}
      {data?.error === "not_found" && (
        <EmptyState title="그룹 없음" hint="해당 그룹이 활성 상태가 아니거나 키가 잘못되었습니다." icon="❓" />
      )}

      {data && !data.error && (() => {
        const hs = data.health_score;
        const hasHealth = hs != null && hs.total != null;
        const fallback = data.summary?.yt_subscribers ?? data.summary?.yt_total_views ?? null;
        // V2.21: 서브컬처(ISEDOL segmentary / STELLIVE confederation)는 데뷔 개념이
        // 모호 (멤버별 데뷔 시점이 흩어져 있고 confederation 우산형은 단일 debut_date
        // 자체가 placeholder). Debut Window 카드/섹션을 K-POP(corporate)에만 노출.
        const groupModel = hs?.breakdown?._group_model ?? "corporate";
        const isSubculture = groupModel === "segmentary" || groupModel === "confederation";
        const healthHistory: Array<{ snapshot_at: string; total: number | null }> =
          data.health_history ?? [];
        const healthSeries = healthHistory.map((r) => Number(r.total ?? 0)).filter((n) => Number.isFinite(n));
        const summaryHistory: any[] = data.summary_history ?? [];
        const prev = data.prev_summary;
        // Health WoW: latest total - first total within 7d window.
        // We pick the oldest history point at-or-before now-7d (or the
        // start of the series if it's shorter) for symmetry with the
        // KPI prev_summary path.
        const healthDelta = (() => {
          if (!hasHealth || healthHistory.length < 2) return null;
          const cutoff = Date.now() - 7 * 86_400_000;
          const prevPt = [...healthHistory]
            .reverse()
            .find((r) => Date.parse(r.snapshot_at) <= cutoff);
          if (!prevPt || prevPt.total == null) return null;
          return (hs.total as number) - prevPt.total;
        })();
        // Pre-compute the combined_views entry for the active method so we
        // can (a) conditionally render the KPI header toggle and (b) pass
        // the subscriber split hint directly to the 구독자 KPI.
        const cvActive = data.combined_views?.[combinedMethod] as
          | { subscribers: number; views: number; videos: number;
              group_subs: number; member_subs: number; member_channel_count: number }
          | undefined;
        const subscriberPctHint: string | undefined = (() => {
          if (!cvActive) return undefined;
          const total = (cvActive.group_subs ?? 0) + (cvActive.member_subs ?? 0);
          if (total === 0) return undefined;
          const gPct = Math.round((cvActive.group_subs / total) * 100);
          return `그룹 ${gPct}% / 멤버 ${100 - gPct}%`;
        })();
        const alertCount = data.alerts?.length ?? 0;
        const insightCount = data.insights?.length ?? 0;
        const alertWorstSev: string = alertCount > 0
          ? (["critical", "warn", "info"].find(
              (s) => data.alerts.some((a: any) => a.severity === s)
            ) ?? "info")
          : "info";
        const latestInsight = insightCount > 0
          ? (data.insights as Array<{ id: number; title: string; body: string;
              scope: string; type: string; generated_at: string }>)
              .reduce((best, i) =>
                i.generated_at > best.generated_at ? i : best, data.insights[0])
          : null;
        return (
        <>
          <section class="rounded-lg border border-zinc-800 p-3">
            <div class="flex items-center gap-4">
              <div class={`grid h-20 w-20 place-items-center rounded-full bg-zinc-950 ring-2 ${gradeRingClass(hasHealth ? hs.grade : "PRE")}`}>
                <div class="text-2xl font-bold tabular-nums">
                  {hasHealth ? hs.total : (fallback != null ? fmt(fallback) : "—")}
                </div>
                <div class="text-xs text-zinc-400">
                  {hasHealth ? hs.grade : "집계 대기"}
                </div>
              </div>
              <div class="flex-1">
                <div class="text-lg font-semibold flex flex-wrap items-baseline gap-2">
                  {data.name}
                  <span class="text-zinc-500 text-sm">· {data.name_kr}</span>
                  {data.debut_date && <DDayBadge debutDate={data.debut_date} />}
                </div>
                <div class="text-xs text-zinc-400">
                  {hasHealth ? hs.label : (fallback != null ? "구독자 (점수 미산출)" : "데뷔 전 (활동량 부족)")}
                </div>
                <HealthSpec />
                {hasHealth && healthSeries.length >= 2 && (
                  <div class="mt-2 flex items-baseline gap-2">
                    <span class={
                      healthDelta == null
                        ? "text-xs text-zinc-500"
                        : healthDelta > 0
                        ? "text-xs font-semibold text-emerald-400"
                        : healthDelta < 0
                        ? "text-xs font-semibold text-red-400"
                        : "text-xs text-zinc-500"
                    }>
                      {healthDelta == null
                        ? ""
                        : healthDelta > 0
                        ? `▲ +${healthDelta.toFixed(1)} (vs 7d)`
                        : healthDelta < 0
                        ? `▼ ${healthDelta.toFixed(1)} (vs 7d)`
                        : "변화 없음 (vs 7d)"}
                    </span>
                    <span
                      class={
                        healthDelta == null
                          ? "text-zinc-500"
                          : healthDelta > 0
                          ? "text-emerald-500/70"
                          : healthDelta < 0
                          ? "text-red-500/70"
                          : "text-zinc-500/70"
                      }
                      title="최근 30일 Health Score 추이"
                    >
                      <Sparkline points={healthSeries} width={140} height={20} />
                    </span>
                  </div>
                )}
              </div>
            </div>
            {hasHealth && hs.breakdown && hs.breakdown._factors && (
              <FactorBreakdown
                factors={hs.breakdown._factors}
                groupModel={hs.breakdown._group_model ?? "corporate"}
              />
            )}
          </section>

          <GroupSignals data={data} />

          {(alertCount > 0 || insightCount > 0) && (
            <div class="flex flex-wrap gap-2">
              {alertCount > 0 && (
                <button
                  type="button"
                  class={`rounded border px-3 py-1.5 text-label cursor-pointer hover:opacity-80 ${GROUP_ALERT_TONE[alertWorstSev]}`}
                  onClick={() => writeState({ tab: "risk", group: groupKey! })}
                >
                  활성 알림 {alertCount}건 → PR/Risk
                </button>
              )}
              {insightCount > 0 && latestInsight && (
                <button
                  type="button"
                  class="rounded border border-violet-500/40 bg-violet-500/5 px-3 py-1.5 text-label text-violet-200 cursor-pointer hover:bg-violet-500/10"
                  onClick={() => writeState({ tab: "insights" })}
                >
                  전략 인사이트 {insightCount}건 (최신 {formatKSTDate(latestInsight.generated_at)}) →
                </button>
              )}
            </div>
          )}

          {/* KPI section — segmented control lives in the header so the
              toggle reads as controlling the values it sits with.
              WoW deltas come from prev_summary (single 7d-ago row);
              sparklines from summary_history (30d series). The
              combined_views toggle only changes the displayed
              aggregate — delta/sparkline still reflect the raw
              summary metric since combined_views has no history.

              NOTE: agg_group_combined is built from
              youtube_channel_stats (live collector) and INSERTs 0
              when the group has no live row yet (e.g. wegosix on
              day-zero — channel exists but the worker hasn't run
              its YT channel-stats pass for it). In that case the
              row exists but every column is 0, so a `??` fallback
              wouldn't trigger. We therefore treat 0 as "missing"
              for the combined_views path and fall back to summary
              (which itself forward-fills from SB backfill rows). */}
          <section class="rounded-lg border border-zinc-800 p-3">
            {cvActive && (
              <div class="mb-3 flex flex-wrap items-center gap-2 border-b border-zinc-800/40 pb-2">
                <h3 class="section-title">YouTube KPI</h3>
                <CombinedToggle
                  views={data.combined_views ?? {}}
                  method={combinedMethod}
                  onMethodChange={setCombinedMethod}
                />
              </div>
            )}
            <div class="grid grid-cols-2 gap-2 md:grid-cols-5">
              <KPI
                label="영상"
                value={(data.combined_views?.[combinedMethod]?.videos || null)
                       ?? data.summary?.yt_total_videos ?? 0}
                delta={wowDelta(data.summary?.yt_total_videos, prev?.yt_total_videos)}
                sparkline={seriesOf(summaryHistory, "yt_total_videos")}
              />
              <KPI
                label="조회수"
                value={(data.combined_views?.[combinedMethod]?.views || null)
                       ?? data.summary?.yt_total_views ?? 0}
                unit="(누적)"
                delta={wowDelta(data.summary?.yt_total_views, prev?.yt_total_views)}
                sparkline={seriesOf(summaryHistory, "yt_total_views")}
              />
              <KPI
                label="구독자"
                value={(data.combined_views?.[combinedMethod]?.subscribers || null)
                       ?? data.summary?.yt_subscribers ?? 0}
                delta={wowDelta(data.summary?.yt_subscribers, prev?.yt_subscribers)}
                sparkline={seriesOf(summaryHistory, "yt_subscribers")}
                hint={subscriberPctHint}
              />
              <KPI
                label="DC 글"
                value={data.summary?.dc_total_posts ?? 0}
                delta={wowDelta(data.summary?.dc_total_posts, prev?.dc_total_posts)}
                sparkline={seriesOf(summaryHistory, "dc_total_posts")}
              />
              <KPI
                label="뉴스"
                value={data.summary?.naver_total_news ?? 0}
                delta={wowDelta(data.summary?.naver_total_news, prev?.naver_total_news)}
                sparkline={seriesOf(summaryHistory, "naver_total_news")}
              />
            </div>
          </section>

          {data.fan_loyalty && <FanLoyaltyCard loyalty={data.fan_loyalty} groupKey={groupKey!} />}

          <PlatformReactivity summary={data.summary} />

          <GroupEventTimeline groupKey={groupKey!} />

          <details class="card p-2">
            <summary class="cursor-pointer text-data text-zinc-300">상세 분석 ▾</summary>
            <div class="mt-3 space-y-3">
              <ContentFormatMatrix videos={data.yt_top15 ?? []} />

              <AlbumLifecycle albums={data.albums ?? []} />

              <section class="rounded-lg border border-zinc-800 p-3">
                <div class="mb-3 flex flex-wrap items-center gap-2 border-b border-zinc-800/40 pb-2">
                  <h3 class="section-title">멜론 차트 진입 추이</h3>
                  <span class="text-hint text-zinc-500">
                    곡 단위 trajectory. 일간(06 KST) / TOP100(22 KST) 탭으로 화력 시점 비교. Y축 역축(위=상위).
                  </span>
                </div>
                <MelonChartHistory groupKey={groupKey!} />
              </section>

              {!isSubculture && (
                <section class="rounded-lg border border-zinc-800 p-3">
                  <div class="mb-2 flex flex-wrap items-center gap-2">
                    <h3 class="section-title">데뷔 구간 영상 진정성</h3>
                    <span class="text-hint text-zinc-500">
                      데뷔 전후 60일 영상별 진정성 점수·판정. 행 클릭 시 신호 상세.
                    </span>
                  </div>
                  <DebutWindowVideoTable groupKey={groupKey!} />
                </section>
              )}

              <section class="rounded-lg border border-zinc-800 p-3">
                <div class="mb-3 flex flex-wrap items-center gap-2 border-b border-zinc-800/40 pb-2 text-sm">
                  <h3 class="section-title">YouTube 상위 15</h3>
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
                      <th class="py-1">#</th>
                      <th>제목</th>
                      <th>유형</th>
                      <th class="text-right">24h</th>
                      <th class="text-right">조회수</th>
                      <th class="text-right">좋아요</th>
                    </tr></thead>
                    <tbody>
                      {filteredYt.map((v: any, i: number) => (
                        <tr key={v.video_id} class="border-t border-zinc-800/60">
                          <td class="py-1">{i + 1}</td>
                          <td class="max-w-md truncate">{v.title}</td>
                          <td><span class="rounded bg-zinc-800 px-1.5 text-xs">{v.content_type ?? "—"}</span></td>
                          <td class="text-right tabular-nums">
                            <VelocityCell
                              v24={v.view_count_24h}
                              ratio={v.viral_velocity_ratio} />
                          </td>
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
            </div>
          </details>
        </>
        );
      })()}
    </div>
  );
}

// GroupEventTimeline — vertical timeline of milestones from the
// curated group_events table (migration 0017). Renders per-group
// debut, MV/album drops, music-show wins, milestones, and tour
// announcements in chronological order. Default view caps at the
// most recent 8 events with a "전체 보기" toggle, because the older
// entries are reference material rather than daily-decision input.
const GROUP_TIMELINE_TYPES = new Set([
  "debut", "first_release", "mv_release", "first_show_win", "show_win",
  "album_release", "single_release", "song_release",
  "first_concert", "tour_start", "tour", "showcase",
  "announcement", "milestone", "merger", "graduation",
  "1st_gen_debut", "2nd_gen_debut", "3rd_gen_debut",
  "company_launch", "1st_gen_transfer_debut",
]);

const GROUP_TIMELINE_ICON: Record<string, string> = {
  debut:           "🎬",
  first_release:   "💿",
  first_show_win:  "🏆",
  show_win:        "🥇",
  album_release:   "💿",
  single_release:  "🎵",
  song_release:    "🎵",
  mv_release:      "📺",
  first_concert:   "🎤",
  tour_start:      "🎤",
  tour:            "🎤",
  showcase:        "🎤",
  announcement:    "📣",
  milestone:       "✨",
  merger:          "🤝",
  graduation:      "🌅",
  "1st_gen_debut": "🎬",
  "2nd_gen_debut": "🎬",
  "3rd_gen_debut": "🎬",
  company_launch:  "🏢",
  "1st_gen_transfer_debut": "🎬",
};

function GroupEventTimeline({ groupKey }: { groupKey: string }) {
  const [events, setEvents] = useState<any[] | null>(null);
  const [showAll, setShowAll] = useState<boolean>(false);

  useEffect(() => {
    setEvents(null);
    setShowAll(false);
    // Wide window — older groups (PLAVE 2023, ISEDOL 2021) need
    // multi-year reach. The API caps response size at 200 rows,
    // which is plenty per group.
    api.groupEvents(groupKey, "2020-01-01", "2030-12-31")
      .then((d) => setEvents(d?.events ?? []))
      .catch(() => setEvents([]));
  }, [groupKey]);

  const filtered = useMemo(() => {
    if (!events) return [];
    return events
      .filter((e) => GROUP_TIMELINE_TYPES.has(e.event_type))
      .sort((a, b) => b.event_date.localeCompare(a.event_date)); // newest first
  }, [events]);

  if (!events) {
    return (
      <section class="rounded-lg border border-zinc-800 p-3">
        <h3 class="section-title mb-2">이벤트 타임라인</h3>
        <div class="text-hint text-zinc-500">Loading…</div>
      </section>
    );
  }

  if (filtered.length === 0) {
    return (
      <section class="rounded-lg border border-zinc-800 p-3">
        <div class="flex items-center justify-between">
          <h3 class="section-title">이벤트 타임라인</h3>
          <span class="text-hint text-zinc-500">
            등록된 이벤트 없음 — 다음 라운드 리서치에서 채워질 예정
          </span>
        </div>
      </section>
    );
  }

  const visible = showAll ? filtered : filtered.slice(0, 8);
  const hiddenCount = filtered.length - visible.length;
  // KST-anchored "today" so events on the boundary day classify
  // identically to the operator's wall clock instead of UTC's.
  const today = todayKST();

  return (
    <section class="rounded-lg border border-zinc-800 p-3">
      <div class="mb-3 flex flex-wrap items-baseline gap-2">
        <h3 class="section-title">이벤트 타임라인</h3>
        <span class="text-hint text-zinc-500">
          최신순 {visible.length}{hiddenCount > 0 ? ` / 전체 ${filtered.length}` : ""}건
        </span>
        {filtered.length > 8 && (
          <button
            type="button"
            class="ml-auto text-xs text-zinc-400 hover:text-zinc-200 hover:underline"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "최근 8건만" : `전체 보기 (+${hiddenCount})`}
          </button>
        )}
      </div>
      <ol class="space-y-1.5">
        {visible.map((e) => {
          const isFuture = e.event_date > today;
          const tone = isFuture
            ? "border-emerald-500/40 bg-emerald-500/5"
            : "border-zinc-800 bg-zinc-900/30";
          return (
            <li key={e.id} class={`rounded border-l-2 px-3 py-1.5 text-sm ${tone}`}>
              <div class="flex flex-wrap items-baseline gap-2">
                <span>{GROUP_TIMELINE_ICON[e.event_type] ?? "•"}</span>
                <span class="tabular-nums text-zinc-500">{e.event_date}</span>
                <span class="font-semibold text-zinc-200">{e.title}</span>
                {isFuture && (
                  <span class="rounded bg-emerald-500/20 px-1.5 text-[11px] text-emerald-300">예정</span>
                )}
                {e.confidence === "medium" && (
                  <span class="rounded bg-zinc-800 px-1.5 text-[11px] text-zinc-400" title="신뢰도 medium">~</span>
                )}
              </div>
              {e.description && (
                <div class="mt-0.5 text-xs text-zinc-400">{e.description}</div>
              )}
              {e.source_url && (
                <a class="mt-0.5 inline-block text-[11px] text-zinc-500 hover:text-zinc-400 hover:underline"
                   href={e.source_url} target="_blank" rel="noopener">출처 ↗</a>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ContentFormatMatrix — "어떤 포맷이 우리 그룹에 효과적인가".
//
// Aggregates the loaded yt_top15 by content_type (MV / Cover / Short /
// Live) and computes per-format mean 24h view count and mean
// viral_velocity_ratio. The metric that actually matters here is
// viral_velocity_ratio, not raw views: a format averaging 3× the
// channel's normal lifetime velocity is signalling "this is what
// resonates with this group's audience". A format with high raw views
// but ratio < 1 just means "old hits got there over years".
//
// Surfaces a one-line verdict — the format with the highest mean
// ratio (≥ 2 samples) is the recommended push direction. Empty state
// (<2 typed videos in the top-15) explicitly says so rather than
// hiding the section, because absence of data is itself information.
const FORMAT_LABEL: Record<string, string> = {
  MV:    "MV",
  Cover: "Cover",
  Short: "Short",
  Live:  "Live",
};

const FORMAT_COLOR: Record<string, string> = {
  MV:    "#a855f7",
  Cover: "#22c55e",
  Short: "#06b6d4",
  Live:  "#f59e0b",
};

type FormatRow = {
  type: string;
  count: number;
  meanViews: number;
  meanRatio: number;
  maxRatio: number;
};

function aggregateFormats(videos: any[]): FormatRow[] {
  const buckets: Record<string, { views: number[]; ratios: number[] }> = {};
  for (const v of videos) {
    const t = v.content_type;
    if (!t || !FORMAT_LABEL[t]) continue;
    const slot = buckets[t] ?? { views: [], ratios: [] };
    if (typeof v.view_count_24h === "number") slot.views.push(v.view_count_24h);
    if (typeof v.viral_velocity_ratio === "number") slot.ratios.push(v.viral_velocity_ratio);
    buckets[t] = slot;
  }
  const rows: FormatRow[] = [];
  for (const [type, slot] of Object.entries(buckets)) {
    const meanViews = slot.views.length
      ? slot.views.reduce((a, b) => a + b, 0) / slot.views.length
      : 0;
    const meanRatio = slot.ratios.length
      ? slot.ratios.reduce((a, b) => a + b, 0) / slot.ratios.length
      : 0;
    const maxRatio = slot.ratios.length ? Math.max(...slot.ratios) : 0;
    rows.push({ type, count: Math.max(slot.views.length, slot.ratios.length), meanViews, meanRatio, maxRatio });
  }
  // Sort by mean ratio desc — strongest-resonating format first.
  rows.sort((a, b) => b.meanRatio - a.meanRatio);
  return rows;
}

function ContentFormatMatrix({ videos }: { videos: any[] }) {
  const rows = useMemo(() => aggregateFormats(videos), [videos]);
  const totalTyped = rows.reduce((acc, r) => acc + r.count, 0);
  const winner = rows.find((r) => r.count >= 2 && r.meanRatio >= 1.5);
  const maxRatioInChart = Math.max(1, ...rows.map((r) => r.maxRatio));

  return (
    <section class="rounded-lg border border-zinc-800 p-3">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <h3 class="section-title">콘텐츠 포맷 성과</h3>
        <span class="text-hint text-zinc-500">
          상위 15개 영상 기준. 24h velocity ratio가 채널 평균을 얼마나 초과했는지로 포맷별 반응성 측정.
        </span>
      </div>
      {totalTyped === 0 ? (
        <div class="text-sm text-zinc-500">
          상위 15개 영상에 분류된 포맷(MV/Cover/Short/Live)이 부족합니다 — 분류 데이터 누적 필요.
        </div>
      ) : (
        <>
          <ul class="space-y-1.5">
            {rows.map((r) => {
              const color = FORMAT_COLOR[r.type] ?? "#71717a";
              const widthPct = Math.min(r.maxRatio / maxRatioInChart, 1) * 100;
              const meanWidthPct = Math.min(r.meanRatio / maxRatioInChart, 1) * 100;
              return (
                <li key={r.type} class="grid grid-cols-[5rem_1fr_auto] items-center gap-2 text-xs">
                  <span class="font-semibold" style={{ color }}>{FORMAT_LABEL[r.type]}</span>
                  <div class="relative h-3 overflow-hidden rounded bg-zinc-800/60">
                    {/* Light bar = max ratio; bold bar = mean ratio. */}
                    <div class="absolute inset-y-0 left-0 opacity-30"
                         style={{ width: `${widthPct}%`, backgroundColor: color }} />
                    <div class="absolute inset-y-0 left-0"
                         style={{ width: `${meanWidthPct}%`, backgroundColor: color }} />
                    <span class="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-zinc-300 tabular-nums">
                      평균 {r.meanRatio.toFixed(1)}× · 최고 {r.maxRatio.toFixed(1)}×
                    </span>
                  </div>
                  <span class="text-right tabular-nums text-zinc-500">
                    n={r.count}
                  </span>
                </li>
              );
            })}
          </ul>
          <div class="mt-3 rounded border border-zinc-800/60 bg-zinc-900/40 p-2 text-xs">
            {winner ? (
              <>
                <span class="font-semibold text-emerald-300">권고:</span>
                {" "}
                <span class="text-zinc-300">
                  <span style={{ color: FORMAT_COLOR[winner.type] }}>{FORMAT_LABEL[winner.type]}</span>{" "}
                  포맷이 평균 {winner.meanRatio.toFixed(1)}×로 가장 강하게 반응
                  (n={winner.count}). 다음 콘텐츠 슬롯 우선순위로 검토.
                </span>
              </>
            ) : (
              <>
                <span class="font-semibold text-zinc-400">관찰:</span>
                {" "}
                <span class="text-zinc-500">
                  유의미한 우세 포맷 없음 (평균 ≥1.5× × 표본 ≥2 만족하는 포맷 부재).
                </span>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

// "이 그룹 신호" — client-derived action queue per group. Surfaces the
// four signals every operator wants when they open a group page:
//   1. viral video (yt_top15 row with viral_velocity_ratio ≥ 5×)
//   2. controversy count (community controversy_count from agg_summary)
//   3. album rebound (albums.pattern === 'rebound')
//   4. factor weakness (FactorBreakdown saturation < 30%)
// Renders all four states even when empty so the operator learns the
// section's location and can rely on "no signal = healthy". The empty
// state ("이상 신호 없음") is itself information, not a missing piece.
type Signal = {
  kind: "viral" | "controversy" | "rebound" | "weakness";
  severity: "warn" | "critical" | "info";
  title: string;
  body: string;
};

function deriveSignals(data: any): Signal[] {
  const out: Signal[] = [];

  // 1) Viral velocity — flag any yt_top15 row at ≥5× lifetime mean.
  const yt = data.yt_top15 ?? [];
  const viral = yt.filter((v: any) => (v.viral_velocity_ratio ?? 0) >= 5);
  if (viral.length) {
    const top = viral[0];
    out.push({
      kind: "viral",
      severity: "info",
      title: `🔥 급상승 영상 ${viral.length}건 (24h ≥5×)`,
      body: `최상위: "${(top.title ?? "").slice(0, 60)}" — ${
        top.viral_velocity_ratio?.toFixed(1) ?? "?"
      }×. 팬채널 reupload + 디시/트위터 시딩 검토 (24h 시간 민감).`,
    });
  }

  // 2) Controversy — community controversy_count (agg_summary).
  const controversyCount: number = data.summary?.controversy_count ?? 0;
  if (controversyCount >= 1) {
    out.push({
      kind: "controversy",
      severity: controversyCount >= 5 ? "critical" : "warn",
      title: `⚠ 논란 신호 ${controversyCount}건`,
      body:
        "PR 리스크 가능성. PR/Risk 탭에서 출처 확인 후 false-positive 여부 판정. "
        + "실제 사안일 경우 PR팀 에스컬레이션 (Streisand 주의).",
    });
  }

  // 3) Album rebound — pattern='rebound'.
  const albums = data.albums ?? [];
  const rebounds = albums.filter((a: any) => a.pattern === "rebound");
  if (rebounds.length) {
    const r = rebounds[0];
    out.push({
      kind: "rebound",
      severity: "info",
      title: `📈 앨범 역주행 — "${r.album}"`,
      body: `발매 후 피크가 W1 이후 발생. W1=${r.first_week_sales?.toLocaleString()} → 피크=${r.peak_sales?.toLocaleString()}. 재조명 콘텐츠 슬롯 검토.`,
    });
  }

  // 4) Factor weakness — saturation <30% on any factor.
  const factors = data.health_score?.breakdown?._factors;
  const groupModel = data.health_score?.breakdown?._group_model ?? "corporate";
  const weights = (MODEL_WEIGHTS[groupModel] ?? MODEL_WEIGHTS.corporate) as Record<string, number>;
  if (factors) {
    let weakest: { name: string; sat: number; weight: number; score: number } | null = null;
    for (const [name, weight] of Object.entries(weights)) {
      const score = factors[name] ?? 0;
      const sat = weight > 0 ? score / weight : 0;
      if (sat < 0.3 && (!weakest || sat < weakest.sat)) {
        weakest = { name, sat, weight, score };
      }
    }
    if (weakest) {
      out.push({
        kind: "weakness",
        severity: "warn",
        title: `⚙️ 약점: ${FACTOR_LABELS_KR[weakest.name] ?? weakest.name}`,
        body: `${weakest.score.toFixed(1)}/${weakest.weight} (${Math.round(weakest.sat * 100)}% 채움). 그룹 모델 가중치 대비 저성과 — 콘텐츠 전략 재검토 권고.`,
      });
    }
  }

  return out;
}

const SIGNAL_TONE: Record<Signal["severity"], string> = {
  critical: "border-red-500/60 bg-red-500/10",
  warn:     "border-amber-500/40 bg-amber-500/5",
  info:     "border-zinc-700 bg-zinc-900/50",
};

function GroupSignals({ data }: { data: any }) {
  const signals = useMemo(() => deriveSignals(data), [data]);
  return (
    <section class={"rounded-lg border-l-4 " +
      (signals.length === 0
        ? "border-emerald-500/40 border border-zinc-800 bg-emerald-500/5 p-3"
        : "border-amber-500 border border-zinc-800 p-3")
    }>
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <h3 class="section-title">
          이 그룹 신호 {signals.length > 0 && <span class="text-hint text-zinc-500">({signals.length}건)</span>}
        </h3>
        <span class="text-hint text-zinc-500">
          급상승 영상 · 논란 · 역주행 · 취약 지표 자동 감지
        </span>
      </div>
      {signals.length === 0 ? (
        <div class="text-sm text-zinc-400">
          ✓ 이상 신호 없음 — 정상 모니터링.
        </div>
      ) : (
        <ul class="space-y-2">
          {signals.map((s) => (
            <li key={s.kind} class={`rounded border-l-2 p-2.5 ${SIGNAL_TONE[s.severity]}`}>
              <div class="text-sm font-semibold">{s.title}</div>
              <div class="text-xs text-zinc-400">{s.body}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// 4-factor Health Score breakdown bar (V2.5). Renders the four factor
// scores as a stacked horizontal bar so the user can see at a glance
// how the group model's weight distribution actually translated into
// the final score. The bar widths are factor-score / max-possible-
// factor-weight (i.e. a fraction of how much room each factor has
// under the current group model), so identical 0.5 saturations across
// factors render as identical bar widths instead of being scaled by
// the model weights — that way the bar shows the *signal* component
// independent of the weight, while the right-side number shows the
// weighted contribution that actually flows into the score.
const FACTOR_LABELS_KR: Record<string, string> = {
  reach:        "Reach 도달",
  ritual:       "Ritual 의례",
  mobilization: "Mobilization 동원",
  intimacy:     "Intimacy 친밀",
};

const FACTOR_COLORS: Record<string, string> = {
  reach:        "#3b82f6",  // blue
  ritual:       "#a855f7",  // purple
  mobilization: "#f59e0b",  // amber
  intimacy:     "#ec4899",  // pink
};

const MODEL_WEIGHTS: Record<string, Record<string, number>> = {
  corporate:     { reach: 25, ritual: 30, mobilization: 30, intimacy: 15 },
  segmentary:    { reach: 20, ritual: 15, mobilization: 25, intimacy: 40 },
  confederation: { reach: 15, ritual: 10, mobilization: 20, intimacy: 55 },
};

const MODEL_LABELS_KR: Record<string, string> = {
  corporate:     "Corporate (K-pop 정통)",
  segmentary:    "Segmentary (왁타버스 위성)",
  confederation: "Confederation (V-tuber 우산)",
};

// Group/member dual-entity toggle. Renders as a compact inline
// segmented control — the section wrapper lives in the caller (KPI
// section header) so the toggle reads as controlling the KPIs it
// sits with. For PLAVE-style groups with no member solo channels the
// three methods produce identical numbers; instead of a section-level
// hint we promote that fact to a title="" tooltip on the two
// member-inclusive buttons so the control stays compact.
function CombinedToggle(props: {
  views: Record<string, {
    subscribers: number; views: number; videos: number;
    group_subs: number; member_subs: number; member_channel_count: number;
  }>;
  method: "group_only" | "sum" | "weighted";
  onMethodChange: (m: "group_only" | "sum" | "weighted") => void;
}) {
  const v = props.views[props.method];
  if (!v) return null;
  const noSolo = v.member_channel_count === 0;
  const noSoloTip = "멤버 솔로 채널 없음 — 세 view 모두 동일";
  const toggles: Array<["group_only" | "sum" | "weighted", string, string]> = [
    ["group_only", "그룹 채널만",      "공식 미디어 활동만"],
    ["sum",        "그룹 + 멤버 합산", noSolo ? noSoloTip : "총 도달"],
    ["weighted",   "가중합 (멤버×0.7)", noSolo ? noSoloTip : "정규화"],
  ];
  return (
    <div class="ml-auto flex overflow-hidden rounded border border-zinc-800 text-xs">
      {toggles.map(([m, label, hint]) => (
        <button
          key={m}
          type="button"
          class={"border-r border-zinc-800 px-2.5 py-1 last:border-r-0 transition-colors " +
                 (props.method === m
                   ? "bg-violet-500/10 text-violet-300"
                   : "text-zinc-400 hover:bg-zinc-800/60")}
          onClick={() => props.onMethodChange(m)}
          title={hint}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Album lifecycle / dive curve. Hanteo collector captures weekly
// sales per (group, album); we render a sparkline per album plus a
// pattern label answering "what shape is this album's life cycle?"
// — millennium-seller (W1 ≥ 1M), longrun (W4 still ≥ 30% of W1),
// natural-decay (W4 < 30%), or rebound (peak after W1 = 역주행).
const PATTERN_LABELS: Record<string, [string, string]> = {
  // [label, color]
  millennium:    ["밀리언",   "#ec4899"],
  longrun:       ["롱런",     "#22c55e"],
  naturaldecay:  ["자연 감소", "#71717a"],
  rebound:       ["역주행",   "#f59e0b"],
  "n/a":         ["측정 보류", "#52525b"],
};

function AlbumLifecycle({ albums }: { albums: any[] }) {
  if (!albums.length) {
    return (
      <section class="rounded-lg border border-zinc-800 p-3">
        <div class="flex items-center justify-between">
          <h3 class="section-title">앨범 라이프사이클</h3>
          <span class="text-hint text-zinc-500">
            한터 데이터 없음 — 발매 후 자동 누적됩니다
          </span>
        </div>
      </section>
    );
  }
  return (
    <section class="rounded-lg border border-zinc-800 p-3">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <h3 class="section-title">앨범 라이프사이클 ({albums.length}개)</h3>
        <span class="text-hint text-zinc-500">
          한터 주간 판매량 시계열. 패턴은 W4/W1 비율 기준으로 분류.
        </span>
      </div>
      <ul class="space-y-3">
        {albums.map((a: any) => (
          <AlbumRow key={a.album} album={a} />
        ))}
      </ul>
    </section>
  );
}

function AlbumRow({ album }: { album: any }) {
  const fallback: [string, string] = ["측정 보류", "#52525b"];
  const [label, color] = PATTERN_LABELS[album.pattern] ?? fallback;
  const w1 = album.first_week_sales ?? 0;
  const peak = album.peak_sales ?? 0;
  const decay = w1 > 0 ? Math.round((album.latest_sales / w1) * 100) : 0;
  return (
    <li class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2.5">
      <div class="flex flex-wrap items-baseline gap-2">
        <span class="font-semibold">{album.album}</span>
        <span class="text-hint text-zinc-500">
          {album.release_week_start ?? ""}
        </span>
        <span class="ml-auto rounded px-1.5 py-0.5 text-xs font-semibold"
              style={{ backgroundColor: `${color}1a`, color }}>
          {label}
        </span>
      </div>
      <DiveSparkline weeks={album.weeks ?? []} color={color} />
      <div class="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-hint
                  text-zinc-500 md:grid-cols-4">
        <span>W1 초동: <span class="text-zinc-300 tabular-nums">{fmt(w1)}</span></span>
        <span>최근 주: <span class="text-zinc-300 tabular-nums">{fmt(album.latest_sales)}</span></span>
        <span>피크: <span class="text-zinc-300 tabular-nums">{fmt(peak)}</span></span>
        <span>유지율: <span class="text-zinc-300 tabular-nums">{decay}%</span></span>
      </div>
    </li>
  );
}

function DiveSparkline({ weeks, color }: {
  weeks: any[]; color: string;
}) {
  if (!weeks.length) return null;
  const max = Math.max(...weeks.map((w) => w.sales ?? 0)) || 1;
  const w = 240;
  const h = 40;
  const dx = weeks.length > 1 ? w / (weeks.length - 1) : 0;
  const points = weeks.map((row, i) => {
    const y = h - ((row.sales ?? 0) / max) * (h - 4) - 2;
    return `${(i * dx).toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} class="mt-1 h-10 w-full max-w-[240px]"
         preserveAspectRatio="none">
      <polyline
        fill="none"
        stroke={color}
        stroke-width="1.5"
        points={points} />
      {weeks.map((row, i) => {
        const cx = i * dx;
        const cy = h - ((row.sales ?? 0) / max) * (h - 4) - 2;
        return (
          <circle key={i} cx={cx} cy={cy} r={2} fill={color} />
        );
      })}
    </svg>
  );
}

// Platform reactivity fingerprint. For each viral video the worker
// counts platform activity in the 24h window before vs after — the
// per-platform mean ratio answers "which platform's fandom wakes up
// when this group releases something?". Renders only when there's a
// meaningful sample (≥1 viral video in the last 30 days).
const REACTIVITY_PLATFORMS: Array<[string, string, string]> = [
  // [field, label, color]
  ["reactivity_dc",     "DC",     "#22c55e"],
  ["reactivity_theqoo", "TheQoo", "#a855f7"],
  ["reactivity_instiz", "Instiz", "#06b6d4"],
  ["reactivity_naver",  "Naver",  "#f59e0b"],
];

function PlatformReactivity({ summary }: { summary: any }) {
  const sample = summary?.reactivity_sample ?? 0;
  if (!summary || sample === 0) {
    return (
      <section class="rounded-lg border border-zinc-800 p-3">
        <div class="flex items-center justify-between">
          <h3 class="section-title">플랫폼 반응성</h3>
          <span class="text-hint text-zinc-500">
            최근 30일 viral 영상 없음 — 데이터 부족
          </span>
        </div>
      </section>
    );
  }
  const max = 5; // formula caps at 5.0
  return (
    <section class="rounded-lg border border-zinc-800 p-3">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <h3 class="section-title">플랫폼 반응성</h3>
        <span class="text-hint text-zinc-500">
          viral 영상 발생 후 24h vs 이전 24h 게시물 비율
          (sample={sample}건)
        </span>
      </div>
      <ul class="space-y-1.5">
        {REACTIVITY_PLATFORMS.map(([field, label, color]) => {
          const ratio = summary[field] ?? 1.0;
          const tone =
            ratio >= 2.0 ? "text-emerald-400 font-semibold"
            : ratio >= 1.5 ? "text-blue-400"
            : ratio >= 0.8 ? "text-zinc-400"
            : "text-amber-400";
          const verdict =
            ratio >= 2.0 ? "강한 반응형"
            : ratio >= 1.5 ? "반응형"
            : ratio >= 0.8 ? "독립형"
            : "비반응 (감소)";
          return (
            <li key={field} class="flex items-center gap-2 text-xs">
              <span class="w-16 shrink-0 text-zinc-400">{label}</span>
              <div class="relative h-2 flex-1 overflow-hidden rounded bg-zinc-800/60">
                <div class="absolute inset-y-0 left-0"
                     style={{
                       width: `${Math.min(ratio / max, 1) * 100}%`,
                       backgroundColor: color,
                     }} />
              </div>
              <span class={`w-14 shrink-0 text-right tabular-nums ${tone}`}>
                {ratio.toFixed(2)}×
              </span>
              <span class={`w-20 shrink-0 text-hint ${tone}`}>
                {verdict}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// 24h Velocity cell for the YouTube top-15 table. We show the
// interpolated +24h view count (the K-pop industry's standard
// comeback signal) plus a multiplier badge against the channel's
// leave-one-out mean. >5x is viral, 2-5 strong, <1 underperforming.
function VelocityCell({ v24, ratio }: {
  v24: number | null | undefined;
  ratio: number | null | undefined;
}) {
  if (v24 == null) {
    return <span class="text-zinc-600">—</span>;
  }
  const r = ratio ?? null;
  const tone = r == null ? "text-zinc-400"
             : r >= 5 ? "text-emerald-400"
             : r >= 2 ? "text-blue-400"
             : r >= 1 ? "text-zinc-300"
             : "text-amber-400";
  return (
    <span class="flex items-center justify-end gap-1.5">
      <span class="text-zinc-300">{fmt(v24)}</span>
      {r != null && (
        <span class={`text-hint ${tone}`}>
          {r.toFixed(1)}×
        </span>
      )}
    </span>
  );
}


function FactorBreakdown(props: {
  factors: Record<string, number>;
  groupModel: string;
}) {
  const weights = (MODEL_WEIGHTS[props.groupModel]
                   ?? MODEL_WEIGHTS.corporate) as Record<string, number>;
  const order: Array<keyof typeof FACTOR_LABELS_KR> =
    ["reach", "ritual", "mobilization", "intimacy"];
  return (
    <div class="mt-3 space-y-1.5 border-t border-zinc-800/60 pt-3">
      <div class="mb-1 flex items-center justify-between text-hint">
        <span class="text-zinc-500">4-Factor 분해</span>
        <span class="text-zinc-500">
          {MODEL_LABELS_KR[props.groupModel] ?? props.groupModel}
        </span>
      </div>
      {order.map((f) => {
        const score = props.factors[f] ?? 0;
        const weight = weights[f] ?? 0;
        const saturation = weight > 0 ? Math.min(score / weight, 1) : 0;
        return (
          <div key={f} class="flex items-center gap-2 text-xs">
            <span class="w-24 shrink-0 text-zinc-400">
              {FACTOR_LABELS_KR[f]}
            </span>
            <div class="relative h-2 flex-1 overflow-hidden rounded bg-zinc-800/60">
              <div class="absolute inset-y-0 left-0"
                   style={{
                     width: `${Math.round(saturation * 100)}%`,
                     backgroundColor: FACTOR_COLORS[f],
                   }} />
            </div>
            <span class="w-20 shrink-0 text-right tabular-nums text-zinc-400">
              {score.toFixed(1)}<span class="text-zinc-500">/{weight}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}


function DDayBadge({ debutDate }: { debutDate: string }) {
  // KST-anchored day delta — `Date.parse` on a bare date interprets it
  // as UTC midnight, which would flip "D-1" to "D-DAY" 9 hours early in
  // KST. `daysBetweenKST` does the calendar math in Asia/Seoul so the
  // chip switches at KST midnight, matching the operator's wall clock.
  const days = daysBetweenKST(debutDate);
  if (days == null) return null;
  if (days > 0) {
    return (
      <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-200 tabular-nums"
            title={`데뷔 ${debutDate} (KST) 까지 ${days}일`}>
        D-{days}
      </span>
    );
  }
  if (days === 0) {
    return (
      <span class="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-semibold text-emerald-200">
        D-DAY
      </span>
    );
  }
  return (
    <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300 tabular-nums"
          title={`데뷔 ${debutDate} (KST) 후 ${Math.abs(days)}일`}>
      D+{Math.abs(days)}
    </span>
  );
}


