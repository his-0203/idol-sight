import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { DebutWindowSignalPanel } from "./DebutWindowSignalPanel";

const BUCKETS = ["D-60", "D-30", "D-Day", "D+30", "D+60"] as const;
type Bucket = typeof BUCKETS[number];
type FilterType = "all" | "long" | "short";

interface VideoRow {
  video_id: string;
  title: string | null;
  is_short: number;
  days_relative_to_debut: number;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  engagement_rate: number | null;
  organic_score: number | null;
  verdict: string;
  signal_breakdown: string;
}

interface Props {
  groupKey: string;
}

function verdictColor(v: string): string {
  if (v === "organic")        return "#22c55e";
  if (v === "suspect")        return "#eab308";
  if (v === "likely_paid")    return "#ef4444";
  return "#6b7280";  // insufficient_data
}

function verdictLabelShort(v: string): string {
  if (v === "organic") return "Organic";
  if (v === "suspect") return "Suspect";
  if (v === "likely_paid") return "Likely Paid";
  if (v === "insufficient_data") return "Insufficient";
  return v;
}

function fmtViews(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function DebutWindowVideoTable({ groupKey }: Props) {
  const [bucket, setBucket] = useState<Bucket>("D-30");
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [rows, setRows] = useState<VideoRow[] | null>(null);
  const [selected, setSelected] = useState<VideoRow | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    setRows(null);
    setSelected(null);  // 새 bucket/filter 로드 시 패널도 닫기
    let cancelled = false;
    api.debutWindowVideos(groupKey, bucket, filterType).then((r: { rows: VideoRow[] }) => {
      if (!cancelled) setRows(r.rows);
    }).catch(() => {
      if (!cancelled) setRows([]);
    });
    return () => { cancelled = true; };
  }, [groupKey, bucket, filterType]);

  return (
    <>
      <section class={"dw-video-section" + (selected ? " with-panel" : "")}>
        <div class="dw-video-main">
          <div class="mb-1 flex items-center justify-between gap-2">
            <nav class="dw-bucket-tabs">
              {BUCKETS.map((b) => (
                <button type="button"
                        key={b}
                        class={b === bucket ? "active" : ""}
                        onClick={() => setBucket(b)}>{b}</button>
              ))}
            </nav>
            <button
              type="button"
              class="dw-help-icon"
              onClick={() => setHelpOpen(true)}
              aria-label="Show score formula"
              title="Score 산정 방식 보기"
            >ⓘ</button>
          </div>

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
                  <th class="dw-num">D-day</th>
                  <th>Title</th>
                  <th>Type</th>
                  <th class="dw-num">Views</th>
                  <th class="dw-num">ER</th>
                  <th class="dw-num">Score</th>
                  <th>판정</th>
                </tr>
              </thead>
              <tbody>
                {rows === null && (
                  <tr><td class="dw-empty-cell" colSpan={7}>Loading…</td></tr>
                )}
                {rows !== null && rows.length === 0 && (
                  <tr><td class="dw-empty-cell" colSpan={7}>No videos in this bucket</td></tr>
                )}
                {rows !== null && rows.map((r) => {
                  const dayLabel = r.days_relative_to_debut >= 0
                    ? `+${r.days_relative_to_debut}` : `${r.days_relative_to_debut}`;
                  const isSelected = selected?.video_id === r.video_id;
                  return (
                    <tr key={r.video_id}
                        onClick={() => setSelected(isSelected ? null : r)}
                        class={"dw-row-clickable" + (isSelected ? " selected" : "")}>
                      <td class="dw-num">{dayLabel}</td>
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {selected && (
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
 * Pattern mirrors HealthSpec.tsx (dim backdrop + click-stop card).
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
                  <td class="px-2 py-1.5 text-right">0.5</td>
                  <td class="px-2 py-1.5">≥5.5% (Long) / 3.3% (Shorts)</td>
                  <td class="px-2 py-1.5">≤0.5% / 0.3%</td>
                </tr>
                <tr class="border-t border-zinc-800/60">
                  <td class="px-2 py-1.5">balance_score</td>
                  <td class="px-2 py-1.5">likes/comments 비율</td>
                  <td class="px-2 py-1.5 text-right">0.3</td>
                  <td class="px-2 py-1.5">15 ~ 80 (정상대역)</td>
                  <td class="px-2 py-1.5">&lt;15 댓글농장 / &gt;80 좋아요농장</td>
                </tr>
                <tr class="border-t border-zinc-800/60">
                  <td class="px-2 py-1.5">velocity_coherence</td>
                  <td class="px-2 py-1.5">viral_velocity × ER</td>
                  <td class="px-2 py-1.5 text-right">0.2</td>
                  <td class="px-2 py-1.5">폭발 + 정상 engagement</td>
                  <td class="px-2 py-1.5">폭발인데 engagement 죽음</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2">
            <div class="mb-1 font-semibold text-zinc-200">Verdict 임계값</div>
            <ul class="ml-3 list-disc space-y-0.5 text-zinc-400">
              <li><span style={{ color: "#22c55e" }}>≥70</span> organic 🟢</li>
              <li><span style={{ color: "#eab308" }}>40–69</span> suspect 🟡</li>
              <li><span style={{ color: "#ef4444" }}>&lt;40</span> likely_paid 🔴</li>
              <li><span class="text-zinc-500">insufficient_data</span> ⚪
                (view &lt; 1000 AND likes+comments &lt; 10)
              </li>
            </ul>
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2 text-zinc-400">
            <span class="font-semibold text-zinc-200">ER 열의 의미</span>:{" "}
            Engagement Rate = (좋아요 + 댓글) / 조회수 (좋아요 단독 수치 아님)
          </div>

          <p class="text-zinc-500 italic text-[11px]">
            v1 heuristic — verify manually before external use.
          </p>
        </div>
      </div>
    </div>
  );
}
