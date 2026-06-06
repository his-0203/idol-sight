// Signal Breakdown 패널. 행 클릭 시 grid의 두 번째 컬럼(좁은 뷰포트에서는
// 테이블 아래)에 렌더링되며, 더 이상 fixed-overlay로 행을 덮지 않는다.
// signal_breakdown JSON을 사람이 읽을 수 있는 포맷으로 풀어주고, sub-score
// 바 시각화 + 최종 verdict pill을 보여준다. insufficient_data인 경우
// 점수 breakdown 대신 제외 사유를 안내한다.

import { verdictColor } from "../lib/organicity";

interface Props {
  videoId: string;
  title: string | null;
  signalBreakdown: string;   // JSON string from API
  onClose: () => void;
}

interface ParsedBreakdown {
  // Sub-scores (0~100)
  engagement_score?: number | null;
  balance_score?: number | null;
  velocity_coherence_score?: number | null;
  // Raw inputs
  engagement_rate?: number | null;
  likes_comments_ratio?: number | null;
  velocity_ratio?: number | null;
  // Weights (object: {engagement, balance, velocity})
  weights?: Record<string, number>;
  // Final
  composite_score?: number | null;
  verdict?: string;
  // insufficient_data path
  view_count?: number | null;
  engagement_total?: number | null;
  // catch-all
  [k: string]: unknown;
}

function fmtPct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  return `${(rate * 100).toFixed(2)}%`;
}
function fmtRatio(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toFixed(2);
}
function fmtVelocity(n: number | null | undefined): string {
  if (n === null || n === undefined) return "데이터 없음 (바이럴 없음)";
  return `${n.toFixed(2)}×`;
}
function fmtScore(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${Math.round(n)} / 100`;
}
function clampPct(n: number | null | undefined): number {
  if (n === null || n === undefined || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}
// verdict → color: see src/lib/organicity.ts (single source of truth).
function verdictLabelKo(v: string | undefined): string {
  if (v === "organic_strong") return "Organic (Strong)";
  if (v === "organic")        return "Organic";
  if (v === "borderline")     return "Borderline";
  if (v === "suspect")        return "Suspect";
  if (v === "likely_paid")    return "Likely Paid";
  if (v === "insufficient_data") return "Insufficient Data";
  return v ?? "—";
}
function verdictEmoji(v: string | undefined): string {
  if (v === "organic_strong" || v === "organic") return "🟢";
  if (v === "borderline") return "🟡";
  if (v === "suspect")    return "🟠";
  if (v === "likely_paid") return "🔴";
  return "⚪";
}

// Cause chips distinguish "weak but clean" (engagement_weak) from genuine
// manipulation signatures (farms / paid bursts). The note below makes the
// distinction explicit so a borderline-from-weak-engagement Short isn't misread
// as a paid accusation.
const CAUSE_LABEL: Record<string, string> = {
  viral_real:      "실제 바이럴",
  engagement_weak: "engagement 약함",
  comment_farm:    "댓글농장 의심",
  like_farm:       "좋아요농장 의심",
  paid_burst:      "유료 버스트 의심",
};
const MANIPULATION_CAUSES = new Set(["comment_farm", "like_farm", "paid_burst"]);
function parseCauseList(parsed: ParsedBreakdown): string[] {
  const c = (parsed as { causes?: unknown }).causes;
  return Array.isArray(c) ? (c as string[]) : [];
}
function fmtWeightPct(w: number | undefined): string {
  if (w === null || w === undefined) return "—";
  return `${Math.round(w * 100)}%`;
}

function ScoreBar({ score, verdict }: { score: number | null | undefined; verdict: string | undefined }) {
  const pct = clampPct(score);
  return (
    <div class="dw-signal-bar-track">
      <div class="dw-signal-bar-fill"
           style={{ width: `${pct}%`, background: verdictColor(verdict) }} />
    </div>
  );
}

export function DebutWindowSignalPanel({ videoId, title, signalBreakdown, onClose }: Props) {
  let parsed: ParsedBreakdown = {};
  try { parsed = JSON.parse(signalBreakdown) as ParsedBreakdown; } catch { /* keep empty */ }
  const ytUrl = `https://youtu.be/${videoId}`;
  const verdict = parsed.verdict;
  const isInsufficient = verdict === "insufficient_data";

  const weights = parsed.weights ?? {};

  return (
    <aside class="dw-signal-panel">
      <header>
        <h4>Signal Breakdown</h4>
        <button type="button" class="dw-close-btn"
                onClick={onClose} aria-label="Close">×</button>
      </header>

      <div class="dw-signal-title" title={title ?? videoId}>
        {title ?? videoId}
      </div>
      <a class="dw-signal-yt-link"
         href={ytUrl} target="_blank" rel="noopener">Open on YouTube ↗</a>

      {isInsufficient ? (
        <div class="dw-signal-insufficient">
          <div style={{ fontWeight: 600, color: "#d4d4d8", marginBottom: 6 }}>
            분석에서 제외됨
          </div>
          <div>
            조회수 {parsed.view_count ?? "—"} / 좋아요+댓글 {parsed.engagement_total ?? "—"}
          </div>
          <div style={{ marginTop: 6 }}>
            조회수 &lt; 1000 AND likes+comments &lt; 10 인 영상은 noise가 커서
            organic_score 산정에서 제외됩니다.
          </div>
        </div>
      ) : (
        <>
          <div class="dw-signal-section-label">Score Breakdown</div>

          <div class="dw-signal-metric">
            <span class="dw-metric-label">Engagement Rate</span>
            <span class="dw-metric-value">{fmtPct(parsed.engagement_rate)}</span>
          </div>
          <div class="dw-signal-bar-row">
            <span class="dw-metric-label">Engagement Score</span>
            <span class="dw-metric-score">{fmtScore(parsed.engagement_score)}</span>
            <ScoreBar score={parsed.engagement_score} verdict={verdict} />
          </div>

          <div class="dw-signal-metric">
            <span class="dw-metric-label">Likes : Comments Ratio</span>
            <span class="dw-metric-value">{fmtRatio(parsed.likes_comments_ratio)}</span>
          </div>
          <div class="dw-signal-bar-row">
            <span class="dw-metric-label">Balance Score</span>
            <span class="dw-metric-score">{fmtScore(parsed.balance_score)}</span>
            <ScoreBar score={parsed.balance_score} verdict={verdict} />
          </div>

          <div class="dw-signal-metric">
            <span class="dw-metric-label">Velocity Ratio</span>
            <span class="dw-metric-value">{fmtVelocity(parsed.velocity_ratio)}</span>
          </div>
          <div class="dw-signal-bar-row">
            <span class="dw-metric-label">Velocity Coherence Score</span>
            <span class="dw-metric-score">{fmtScore(parsed.velocity_coherence_score)}</span>
            <ScoreBar score={parsed.velocity_coherence_score} verdict={verdict} />
          </div>

          <div class="dw-signal-weights">
            Weights: engagement {fmtWeightPct(weights.engagement)} ·
            balance {fmtWeightPct(weights.balance)} ·
            velocity {fmtWeightPct(weights.velocity)}
          </div>

          <div class="dw-signal-section-label">Final</div>
          <div class="dw-signal-final">
            <div class="dw-signal-composite-row">
              <span class="dw-metric-label">Composite Score</span>
              <span class="dw-signal-composite-score">
                {parsed.composite_score === null || parsed.composite_score === undefined
                  ? "—"
                  : `${Math.round(parsed.composite_score)}/100`}
              </span>
            </div>
            <div class="dw-signal-composite-row">
              <span class="dw-metric-label">Verdict</span>
              <span class="dw-verdict-pill"
                    style={{ background: verdictColor(verdict) }}>
                {verdictLabelKo(verdict)} {verdictEmoji(verdict)}
              </span>
            </div>
            {(() => {
              const causes = parseCauseList(parsed);
              if (causes.length === 0) return null;
              const hasManip = causes.some((c) => MANIPULATION_CAUSES.has(c));
              return (
                <div class="dw-signal-causes" style={{ marginTop: 8 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {causes.map((c) => (
                      <span key={c} class="dw-cause-chip" title={c}>
                        {CAUSE_LABEL[c] ?? c}
                      </span>
                    ))}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: "#a1a1aa" }}>
                    {hasManip
                      ? "비정상 좋아요·댓글 균형 → 조작/유료 부스팅 의심."
                      : "균형은 정상이나 engagement가 약함 → 콜드·패시브 도달 가능성 (유료 단정 아님)."}
                  </div>
                </div>
              );
            })()}
          </div>
        </>
      )}

      <p class="dw-signal-disclaimer">
        v1 heuristic — verify manually before external use.
      </p>
    </aside>
  );
}
