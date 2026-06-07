import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { verdictColor } from "../lib/organicity";
import { DISPLAY_BUCKETS as BUCKETS } from "../lib/debutWindow";
import { DebutWindowSignalPanel } from "./DebutWindowSignalPanel";

// Display tabs: see src/lib/debutWindow.ts (single source of truth).
type Bucket = typeof BUCKETS[number];
type FilterType = "all" | "long" | "short";
type ViewMode = "debut" | "all";

const PAGE_SIZE = 30;

// VideoRow 는 두 view 가 공유 (전체 기간 view 는 score/verdict null 가능).
interface VideoRow {
  video_id: string;
  title: string | null;
  is_short: number;
  published_at?: string;                         // all view 에서만 사용
  days_relative_to_debut: number | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  engagement_rate: number | null;
  organic_score: number | null;
  verdict: string | null;
  causes: string | null;
  signal_breakdown: string | null;
}

interface Props {
  groupKey: string;
}

// verdict → color: see src/lib/organicity.ts (single source of truth).

function verdictLabelShort(v: string | null): string {
  if (v === "organic_strong") return "Strong";
  if (v === "organic")        return "Organic";
  if (v === "borderline")     return "Border";
  if (v === "suspect")        return "Suspect";
  if (v === "likely_paid")    return "Paid";
  if (v === "insufficient_data") return "Insufficient";
  // null (V3: organicity 없음) 또는 unknown verdict → 안전 fallback.
  return v ?? "Insufficient";
}

const CAUSE_LABEL: Record<string, string> = {
  viral_real:      "viral",
  engagement_weak: "engagement↓",
  comment_farm:    "comment-farm",
  like_farm:       "like-farm",
  paid_burst:      "paid-burst",
};

function parseCauses(causes: string | null): string[] {
  if (!causes) return [];
  try {
    const parsed = JSON.parse(causes);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function fmtViews(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtPublishedDate(iso: string | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 10);   // 'YYYY-MM-DD'
}

export function DebutWindowVideoTable({ groupKey }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("debut");
  // V2.34: 기본 D-Day. 7탭 grid 의 중앙 + 데뷔 모먼트 영상 우선 노출.
  const [bucket, setBucket] = useState<Bucket>("D-Day");
  const [filterType, setFilterType] = useState<FilterType>("all");
  // Debut Window view rows
  const [rows, setRows] = useState<VideoRow[] | null>(null);
  // 전체 기간 view state
  const [allRows, setAllRows] = useState<VideoRow[] | null>(null);
  const [allTotal, setAllTotal] = useState(0);
  const [page, setPage] = useState(0);

  const [selected, setSelected] = useState<VideoRow | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // Debut Window view 데이터 fetch
  useEffect(() => {
    if (viewMode !== "debut") return;
    setRows(null);
    setSelected(null);
    let cancelled = false;
    api.debutWindowVideos<VideoRow>(groupKey, bucket, filterType).then((r) => {
      if (!cancelled) setRows(r.rows);
    }).catch(() => {
      if (!cancelled) setRows([]);
    });
    return () => { cancelled = true; };
  }, [viewMode, groupKey, bucket, filterType]);

  // 전체 기간 view 데이터 fetch
  useEffect(() => {
    if (viewMode !== "all") return;
    setAllRows(null);
    setSelected(null);
    let cancelled = false;
    api.debutWindowVideosAll<VideoRow>(groupKey, page * PAGE_SIZE, PAGE_SIZE, filterType).then(
      (r) => {
        if (cancelled) return;
        setAllRows(r.rows);
        // total 은 첫 페이지 (offset===0) 에서만 backend 가 동봉 → 그 이후
        // 페이지는 캐시된 값 유지. groupKey/filterType 바뀌면 page=0 으로
        // reset 되어 다시 fetch 됨.
        if (r.total !== undefined) setAllTotal(r.total);
      },
    ).catch(() => {
      if (!cancelled) { setAllRows([]); setAllTotal(0); }
    });
    return () => { cancelled = true; };
  }, [viewMode, groupKey, page, filterType]);

  // viewMode / filterType 변경 시 페이지 0 으로 reset
  useEffect(() => { setPage(0); }, [viewMode, filterType, groupKey]);

  const currentRows = viewMode === "debut" ? rows : allRows;
  const totalPages = Math.max(1, Math.ceil(allTotal / PAGE_SIZE));

  return (
    <>
      <section class={"dw-video-section" + (selected ? " with-panel" : "")}>
        <div class="dw-video-main">
          {/* 상단 view tab — Debut Window / 전체 기간 */}
          <div class="mb-3 flex items-center justify-between gap-2">
            <nav class="dw-view-tabs">
              <button type="button"
                      class={viewMode === "debut" ? "active" : ""}
                      onClick={() => {
                        setSelected(null);   // sub-frame stale-selected 회피
                        setViewMode("debut");
                      }}>Debut Window</button>
              <button type="button"
                      class={viewMode === "all" ? "active" : ""}
                      onClick={() => {
                        setSelected(null);
                        setViewMode("all");
                      }}>전체 기간</button>
            </nav>
            <button
              type="button"
              class="dw-help-icon"
              onClick={() => setHelpOpen(true)}
              aria-label="Show score formula"
              title="Score 산정 방식 보기"
            >ⓘ</button>
          </div>

          {/* Debut Window view 의 5 bucket 탭 */}
          {viewMode === "debut" && (
            <nav class="dw-bucket-tabs">
              {BUCKETS.map((b) => (
                <button type="button"
                        key={b}
                        class={b === bucket ? "active" : ""}
                        onClick={() => setBucket(b)}>{b}</button>
              ))}
            </nav>
          )}

          {/* Long/Shorts 필터 — 두 view 공통 */}
          <div class="dw-type-filter">
            <span class="dw-type-filter-label">Filter:</span>
            {(["all", "long", "short"] as const).map((t) => (
              <button type="button"
                      key={t}
                      class={filterType === t ? "active" : ""}
                      onClick={() => setFilterType(t)}>
                {t === "all" ? "All" : t === "long" ? "Long-form" : "Shorts"}
              </button>
            ))}
          </div>

          <div class="dw-table-wrap">
            <table class="dw-video-table">
              <thead>
                <tr>
                  {viewMode === "debut"
                    ? <th class="dw-num">D-day</th>
                    : <th>Published</th>}
                  <th>Title</th>
                  <th>Type</th>
                  <th class="dw-num">Views</th>
                  <th class="dw-num">ER</th>
                  <th class="dw-num">Score</th>
                  <th>판정</th>
                </tr>
              </thead>
              <tbody>
                {currentRows === null && (
                  <tr><td class="dw-empty-cell" colSpan={7}>Loading…</td></tr>
                )}
                {currentRows !== null && currentRows.length === 0 && (
                  <tr><td class="dw-empty-cell" colSpan={7}>
                    {viewMode === "debut" ? "No videos in this bucket" : "No videos"}
                  </td></tr>
                )}
                {currentRows !== null && currentRows.map((r) => {
                  const dayLabel = r.days_relative_to_debut === null
                    ? "—"
                    : r.days_relative_to_debut >= 0
                      ? `+${r.days_relative_to_debut}`
                      : `${r.days_relative_to_debut}`;
                  const firstColumn = viewMode === "debut"
                    ? dayLabel
                    : fmtPublishedDate(r.published_at);
                  const isSelected = selected?.video_id === r.video_id;
                  const canSelect = r.signal_breakdown !== null && r.signal_breakdown !== undefined;
                  return (
                    <tr key={r.video_id}
                        onClick={() => {
                          if (!canSelect) return;
                          setSelected(isSelected ? null : r);
                        }}
                        class={(canSelect ? "dw-row-clickable" : "")
                              + (isSelected ? " selected" : "")}>
                      <td class={viewMode === "debut" ? "dw-num" : ""}>{firstColumn}</td>
                      <td class="dw-title-cell" title={r.title ?? ""}>
                        {r.title ?? r.video_id}
                      </td>
                      <td>{r.is_short ? "Shorts" : "Long"}</td>
                      <td class="dw-num">{fmtViews(r.view_count)}</td>
                      <td class="dw-num">
                        {r.engagement_rate === null
                          ? "—"
                          : `${(r.engagement_rate * 100).toFixed(2)}%`}
                      </td>
                      <td class="dw-num">{r.organic_score ?? "—"}</td>
                      <td>
                        <span class="dw-verdict-pill"
                              style={{ background: verdictColor(r.verdict) }}>
                          {verdictLabelShort(r.verdict)}
                        </span>
                        {parseCauses(r.causes).map((c) => (
                          <span class={"dw-cause-chip dw-cause-" + c} key={c} title={c}>
                            {CAUSE_LABEL[c] ?? c}
                          </span>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 전체 기간 view 의 페이지네이션 컨트롤 */}
          {viewMode === "all" && allRows !== null && allTotal > 0 && (
            <div class="dw-pagination">
              <button type="button"
                      disabled={page === 0}
                      onClick={() => setPage(page - 1)}>← 이전</button>
              <span class="dw-pagination-info">
                {page + 1} / {totalPages}
                <span class="dw-pagination-total"> (총 {allTotal}개)</span>
              </span>
              <button type="button"
                      disabled={(page + 1) >= totalPages}
                      onClick={() => setPage(page + 1)}>다음 →</button>
            </div>
          )}
        </div>

        {selected && selected.signal_breakdown && (
          <DebutWindowSignalPanel
            videoId={selected.video_id}
            title={selected.title}
            signalBreakdown={selected.signal_breakdown}
            onClose={() => setSelected(null)}
          />
        )}
      </section>

      {helpOpen && <DebutWindowHelpModal onClose={() => setHelpOpen(false)} />}
    </>
  );
}

/* ------------------------------------------------------------------ *\
 * Help modal: Score 산정 방식 + verdict thresholds + ER 의미.
 * (변경 없음 — 기존 코드 그대로)
\* ------------------------------------------------------------------ */
function DebutWindowHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
         onClick={onClose}>
      <div class="max-h-[90vh] w-full max-w-2xl overflow-y-auto
                  rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm"
           onClick={(e) => e.stopPropagation()}>
        <div class="mb-3 flex items-center justify-between">
          <h3 class="font-semibold text-zinc-100">
            Debut Window Organicity 점수 산정 방식
          </h3>
          <button class="text-zinc-500 hover:text-zinc-300"
                  onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div class="space-y-3 text-zinc-300 text-xs leading-relaxed">
          <p>
            영상 1개당 <strong class="text-zinc-100">0–100점</strong> +
            verdict (organic / suspect / likely_paid / insufficient_data).
            <br />
            3개 신호의 가중 평균.
          </p>

          <div class="overflow-x-auto rounded border border-zinc-800">
            <table class="w-full min-w-[560px] tabular-nums text-[11px]">
              <thead class="bg-zinc-900/60 text-zinc-500">
                <tr>
                  <th class="px-2 py-1.5 text-left">신호</th>
                  <th class="px-2 py-1.5 text-left">입력</th>
                  <th class="px-2 py-1.5 text-right">가중치</th>
                  <th class="px-2 py-1.5 text-left">100점 기준</th>
                  <th class="px-2 py-1.5 text-left">0점 기준</th>
                </tr>
              </thead>
              <tbody class="text-zinc-300">
                <tr class="border-t border-zinc-800/60">
                  <td class="px-2 py-1.5">engagement_score</td>
                  <td class="px-2 py-1.5">(likes+comments)/views</td>
                  <td class="px-2 py-1.5 text-right">L 0.5 / S 0.4</td>
                  <td class="px-2 py-1.5">≥6.0% (Long) / 9.0% (Shorts)</td>
                  <td class="px-2 py-1.5">≤1.0% (Long) / 0.5% (Shorts)</td>
                </tr>
                <tr class="border-t border-zinc-800/60">
                  <td class="px-2 py-1.5">balance_score</td>
                  <td class="px-2 py-1.5">likes/comments 비율</td>
                  <td class="px-2 py-1.5 text-right">L 0.3 / S 0.6</td>
                  <td class="px-2 py-1.5">Long 10~50 / Shorts 15~78</td>
                  <td class="px-2 py-1.5">미만 댓글농장 / 초과 좋아요농장</td>
                </tr>
                <tr class="border-t border-zinc-800/60">
                  <td class="px-2 py-1.5">velocity_coherence{" "}
                    <span class="text-zinc-500">(Long only)</span></td>
                  <td class="px-2 py-1.5">viral_velocity × ER</td>
                  <td class="px-2 py-1.5 text-right">0.2 *</td>
                  <td class="px-2 py-1.5">폭발 + 정상 engagement</td>
                  <td class="px-2 py-1.5">폭발인데 engagement 죽음</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2">
            <div class="mb-1 font-semibold text-zinc-200">Verdict 임계값 (V2.21 5-tier)</div>
            <ul class="ml-3 list-disc space-y-0.5 text-zinc-400">
              <li><span style={{ color: "#16a34a" }}>≥85</span> organic_strong (확신, viral 케이스 자주 동반)</li>
              <li><span style={{ color: "#22c55e" }}>70–84</span> organic (자연 호응)</li>
              <li><span style={{ color: "#eab308" }}>55–69</span> borderline (검토 필요)</li>
              <li><span style={{ color: "#f97316" }}>40–54</span> suspect (의심)</li>
              <li><span style={{ color: "#ef4444" }}>&lt;40</span> likely_paid (강한 의심)</li>
              <li><span class="text-zinc-500">insufficient_data</span>
                (view &lt; 1000 AND likes+comments &lt; 10)
              </li>
            </ul>
            <p class="mt-1.5 text-[10px] leading-relaxed text-zinc-500">
              초록(Strong/Organic) = 조작 신호 없음(<strong class="text-zinc-300">진짜</strong>)일 뿐
              인기·규모·건강을 보장하지 않음. 빨강(Suspect/Paid) = 좋아요·댓글 균형 이상(조작/유료 의심).
              점수는 비율 기반이라 <strong class="text-zinc-300">작은 채널도 비율이 깨끗하면 Strong</strong>이 나옴.
            </p>
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2">
            <div class="mb-1 font-semibold text-zinc-200">Cause tags (자동 부착)</div>
            <ul class="ml-3 list-disc space-y-0.5 text-zinc-400">
              <li><strong>viral</strong> — velocity ≥1.5 + ER ≥3% (진짜 viral, organic에도 부착)</li>
              <li><strong>engagement↓</strong> — engagement_score &lt; 40 (ER 자체 낮음)</li>
              <li><strong>comment-farm</strong> — balance &lt; 60 + ratio &lt; normal_lo</li>
              <li><strong>like-farm</strong> — balance &lt; 60 + ratio &gt; normal_hi</li>
              <li><strong>paid-burst</strong> — velocity coherence ≤ 20 (view 폭발 vs engagement 빈약)</li>
            </ul>
            <p class="mt-1 text-[10px] text-zinc-500">
              의심 cause는 borderline 이하 verdict 에만 부착. viral 은 verdict 무관.
            </p>
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2 text-zinc-400">
            <span class="font-semibold text-zinc-200">ER 열의 의미</span>:{" "}
            Engagement Rate = (좋아요 + 댓글) / 조회수 (좋아요 단독 수치 아님)
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2 text-zinc-400 text-[11px]">
            <span class="font-semibold text-zinc-200">Shorts (V2.37)</span>{" "}
            는 velocity 를 쓰지 않는다 (조회/baseline 비율이 소형 채널에서 폭발하는
            아티팩트 때문). engagement 0.4 / balance 0.6 의 비중(ratio)만으로 채점 —
            ER 은 "세기", like:comment 균형은 "진정성(organic vs 조작)" 신호. 그래서
            engagement 가 약해도 균형이 정상이면 borderline(약함)에 머물고 paid 로
            단정하지 않는다. SignalPanel 에서 velocity 가 "데이터 없음"으로 보이는 건
            정상.
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2 text-zinc-400 text-[11px]">
            <span class="font-semibold text-zinc-200">* velocity_coherence (Long only)</span>{" "}
            long-form 의 viral_velocity_ratio 는 상당수 NULL. NULL 인 경우 weight 0.2
            가 engagement(0.625)/balance(0.375)로 재분배됨.
          </div>

          <p class="text-zinc-500 italic text-[11px]">
            Long: v2 calibration (2026-05-13). Shorts: V2.37 recalibration
            (2026-06-05, 라이브 6,258 Short 분포). verify manually before external use.
          </p>
        </div>
      </div>
    </div>
  );
}
