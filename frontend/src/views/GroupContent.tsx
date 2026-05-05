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

type CombinedMethod = "group_only" | "sum" | "weighted";

export function GroupContent({ groupKey }: { groupKey: string | null }) {
  const [groups, setGroups] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [contentFilter, setContentFilter] = useState<ContentFilter>("all");
  const [combinedMethod, setCombinedMethod] = useState<CombinedMethod>("sum");

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
          <section class="rounded-lg border border-zinc-800 p-3">
            <div class="flex items-center gap-4">
              <div class={`grid h-20 w-20 place-items-center rounded-full bg-zinc-950 ring-2 ${GRADE_RING[hasHealth ? hs.grade : "PRE"]}`}>
                <div class="text-2xl font-bold tabular-nums">
                  {hasHealth ? hs.total : (fallback != null ? fmt(fallback) : "—")}
                </div>
                <div class="text-xs text-zinc-400">
                  {hasHealth ? hs.grade : "집계 대기"}
                </div>
              </div>
              <div class="flex-1">
                <div class="text-lg font-semibold">{data.name} <span class="text-zinc-500 text-sm">· {data.name_kr}</span></div>
                <div class="text-xs text-zinc-400">
                  {hasHealth ? hs.label : (fallback != null ? "구독자 (점수 미산출)" : "데뷔 전 (활동량 부족)")}
                </div>
                <HealthSpec />
              </div>
            </div>
            {hasHealth && hs.breakdown && hs.breakdown._factors && (
              <FactorBreakdown
                factors={hs.breakdown._factors}
                groupModel={hs.breakdown._group_model ?? "corporate"}
              />
            )}
          </section>

          <CombinedToggle
            views={data.combined_views ?? {}}
            method={combinedMethod}
            onMethodChange={setCombinedMethod}
          />

          <section class="grid grid-cols-2 gap-2 md:grid-cols-5">
            <KPI label="영상"
                 value={data.combined_views?.[combinedMethod]?.videos
                        ?? data.summary?.yt_total_videos ?? 0} />
            <KPI label="조회수"
                 value={data.combined_views?.[combinedMethod]?.views
                        ?? data.summary?.yt_total_views ?? 0}
                 unit="(누적)" />
            <KPI label="구독자"
                 value={data.combined_views?.[combinedMethod]?.subscribers
                        ?? data.summary?.yt_subscribers ?? 0} />
            <KPI label="DC 글" value={data.summary?.dc_total_posts ?? 0} />
            <KPI label="뉴스"   value={data.summary?.naver_total_news ?? 0} />
          </section>

          <PlatformReactivity summary={data.summary} />

          <AlbumLifecycle albums={data.albums ?? []} />


          <section class="rounded-lg border border-zinc-800 p-3">
            <div class="mb-3 flex flex-wrap items-center gap-2 border-b border-zinc-800/40 pb-2 text-sm">
              <h3 class="section-title">YouTube Top 15</h3>
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
        </>
        );
      })()}
    </div>
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

// Group/member dual-entity toggle. Renders only when the API surfaced
// at least one combined_views row (i.e. agg_group_combined has been
// built). For PLAVE-style groups with no member solo channels the
// three methods produce identical numbers, so we still render the
// toggle but with a hint explaining "no solo channels — all three
// views identical".
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
  const total = v.group_subs + v.member_subs;
  const groupPct = total > 0 ? Math.round((v.group_subs / total) * 100) : 0;
  const memberPct = 100 - groupPct;
  const noSolo = v.member_channel_count === 0;
  const toggles: Array<["group_only" | "sum" | "weighted", string, string]> = [
    ["group_only", "그룹 채널만",     "공식 미디어 활동만"],
    ["sum",        "그룹 + 멤버 합산", "총 도달"],
    ["weighted",   "가중합 (멤버×0.7)", "정규화"],
  ];
  return (
    <section class="rounded-lg border border-zinc-800 p-3">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <h3 class="section-title">YouTube 합산 방식</h3>
        {noSolo
          ? <span class="text-hint text-zinc-500">
              멤버 솔로 채널 없음 — 세 view 모두 동일
            </span>
          : <span class="text-hint text-zinc-500">
              그룹 {groupPct}% / 멤버 {memberPct}% (구독자 비중)
            </span>}
      </div>
      <div class="flex flex-wrap gap-1 text-xs">
        {toggles.map(([m, label, hint]) => (
          <button
            key={m}
            class={"rounded-md border px-2 py-1 transition-colors " +
                   (props.method === m
                     ? "border-violet-500 bg-violet-500/10 text-violet-300"
                     : "border-zinc-800 text-zinc-400 hover:bg-zinc-800/60")}
            onClick={() => props.onMethodChange(m)}
            title={hint}
          >
            {label}
            <span class="ml-1 text-hint text-zinc-500">{hint}</span>
          </button>
        ))}
      </div>
    </section>
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
              {score.toFixed(1)}<span class="text-zinc-600">/{weight}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
