import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";
import { DEFAULT_ORGANICITY_MODE, isThinSample, scoreColor } from "../lib/organicity";
import { DEFAULT_CURRENT_BUCKET, DEFAULT_DISPLAY_BUCKETS } from "../lib/debutWindow";

// V2.49: 표시 탭은 summary 응답의 window 메타 (롤링 창) — 정적 타입 대신
// string. 모든 탭이 같은 20일 창 단위라 그룹 간 표본 왜곡 없음 (기존 동일).
type Bucket = string;

// V2.22.3 (2026-05-15): user-requested exclusion from the cohort
// posture bar. ISEDOL/STELLIVE are 서브컬처 (segmentary / confederation)
// group_models — the Debut Window organicity metric still computes for
// them under the V2.18 same-formula policy, but on this comparison bar
// the operator wants a corporate K-POP only view, mirroring the
// MarketOverview / GroupContent / DebutCurve subculture gating
// established in V2.15 / V2.21 (the bar was previously the only place
// they showed up).
// V2.41.1 (2026-06-08): uryael (UR:L / 유아렐) added — it is the same
// subculture case (group_model='segmentary', V2.33 subculture cohort)
// and was simply never gated here when introduced.
const EXCLUDED_GROUPS = new Set<string>(["isedol", "stellive", "uryael"]);

// Score mode = which mean column to render. V2 (migration 0054) adds
// type-split and simple variants so users can defuse Shorts-vs-Long mix
// and view-weighted-single-video dominance.
type Mode = "all_weighted" | "all_simple" | "long" | "short";

const MODE_LABEL: Record<Mode, string> = {
  all_weighted: "전체·조회수 가중",
  all_simple:   "전체·단순평균",
  long:         "롱폼만",
  short:        "숏폼만",
};

interface SummaryRow {
  group_key: string;
  window_bucket: string;
  organic_score_mean: number | null;
  organic_score_mean_long: number | null;
  organic_score_mean_short: number | null;
  organic_score_mean_simple: number | null;
  organic_score_mean_shrunk: number | null;
  video_count: number;
  scored_video_count: number;
  long_form_count: number;
  short_form_count: number;
}

type DisplayMode = "exact" | "current" | "none";

interface DisplayRow {
  group_key: string;
  score: number | null;
  sample_count: number;
  scored_count: number;
  thin: boolean;
  display_mode: DisplayMode;
  shown_bucket: string;
}

function scoreFor(row: SummaryRow, mode: Mode): number | null {
  if (mode === "all_weighted") return row.organic_score_mean;
  // V2.50: the default "All · simple mean" is the thin-sample-shrunk headline
  // (falls back to the raw simple mean on pre-0092 rows). The type-split and
  // view-weighted lenses stay raw — shrinkage is defined for the headline only.
  if (mode === "all_simple")   return row.organic_score_mean_shrunk ?? row.organic_score_mean_simple;
  if (mode === "long")         return row.organic_score_mean_long;
  return row.organic_score_mean_short;
}

function sampleCountFor(row: SummaryRow, mode: Mode): number {
  if (mode === "long")  return row.long_form_count;
  if (mode === "short") return row.short_form_count;
  return row.video_count;
}

// score → color: see src/lib/organicity.ts (single source of truth).

// Pick what to display for a single group under selected (bucket, mode).
// - exact: the selected bucket has a non-null score for this mode.
// - current: selected bucket empty for this mode → fall back to the group's
//   chronologically latest bucket whose mode column is non-null (bucketsOrdered
//   reverse iteration: newest → oldest). 모든 bucket 이 균등 20일 폭이라
//   별도 extended tier 불필요 (V2.34).
// - none: the group has no scoreable data in any bucket for this mode.
function pickDisplayRow(
  byBucket: Map<string, SummaryRow>,
  selected: Bucket,
  mode: Mode,
  groupKey: string,
  bucketsOrdered: readonly string[],
): DisplayRow {
  const exact = byBucket.get(selected);
  if (exact && scoreFor(exact, mode) !== null) {
    const sample = sampleCountFor(exact, mode);
    return {
      group_key: groupKey,
      score: scoreFor(exact, mode),
      sample_count: sample,
      scored_count: exact.scored_video_count,
      thin: isThinSample(sample),
      display_mode: "exact",
      shown_bucket: selected,
    };
  }
  // 균등 폭 bucketsOrdered 를 chronologically newest → oldest 로 순회.
  for (let i = bucketsOrdered.length - 1; i >= 0; i--) {
    const b = bucketsOrdered[i]!;
    const row = byBucket.get(b);
    if (row && scoreFor(row, mode) !== null) {
      const sample = sampleCountFor(row, mode);
      return {
        group_key: groupKey,
        score: scoreFor(row, mode),
        sample_count: sample,
        scored_count: row.scored_video_count,
        thin: isThinSample(sample),
        display_mode: "current",
        shown_bucket: b,
      };
    }
  }
  return {
    group_key: groupKey,
    score: null,
    sample_count: 0,
    scored_count: 0,
    thin: false,
    display_mode: "none",
    shown_bucket: selected,
  };
}

export function CompetitorOrganicityBar() {
  // V2.49: 기본 탭 = 서버가 내려준 "오늘(anchor 기준) 버킷" — 데뷔 전엔
  // D-Day, 슬라이드 후엔 최신 버킷. 사용자가 클릭하면 그 선택 우선.
  const [picked, setPicked] = useState<Bucket | null>(null);
  // V2.40 Finding 3: default to the count-based simple mean so one high-view
  // paid outlier (the PLUMA teaser) can't dominate a bucket. view-weighted
  // stays one click away. See src/lib/organicity.DEFAULT_ORGANICITY_MODE.
  const [mode, setMode] = useState<Mode>(DEFAULT_ORGANICITY_MODE);
  const [allRows, setAllRows] = useState<SummaryRow[] | null>(null);
  const [buckets, setBuckets] = useState<string[]>(DEFAULT_DISPLAY_BUCKETS);
  const [defaultBucket, setDefaultBucket] = useState<string>(DEFAULT_CURRENT_BUCKET);
  const bucket = picked ?? defaultBucket;

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary<SummaryRow>().then((r) => {
      if (cancelled) return;
      if (r.window?.buckets?.length) {
        setBuckets(r.window.buckets);
        setDefaultBucket(r.window.current_bucket);
      }
      setAllRows(r.rows);
    }).catch(() => {
      if (!cancelled) setAllRows([]);
    });
    return () => { cancelled = true; };
  }, []);

  const display = useMemo<DisplayRow[]>(() => {
    if (!allRows) return [];
    const byGroup = new Map<string, Map<string, SummaryRow>>();
    for (const r of allRows) {
      if (EXCLUDED_GROUPS.has(r.group_key)) continue;
      if (!buckets.includes(r.window_bucket)) continue;
      const b = r.window_bucket;
      let m = byGroup.get(r.group_key);
      if (!m) { m = new Map(); byGroup.set(r.group_key, m); }
      m.set(b, r);
    }
    return Array.from(byGroup.keys()).map((k) =>
      pickDisplayRow(byGroup.get(k)!, bucket, mode, k, buckets),
    );
  }, [allRows, bucket, mode, buckets]);

  if (!allRows) return <div class="cob-section">불러오는 중…</div>;

  const sorted = [...display].sort((a, b) => {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });

  const fallbackCount = sorted.filter(
    (r) => r.display_mode === "current",
  ).length;

  return (
    <section class="cob-section">
      <h3>데뷔 구간 경쟁 포지션</h3>
      <div class="cob-bucket-picker">
        표시 구간:
        {buckets.map((b) => (
          <button type="button"
                  key={b}
                  class={b === bucket ? "active" : ""}
                  onClick={() => setPicked(b)}>{b}</button>
        ))}
      </div>
      <div class="cob-mode-picker">
        점수 기준:
        {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
          <button type="button"
                  key={m}
                  class={m === mode ? "active" : ""}
                  onClick={() => setMode(m)}>{MODE_LABEL[m]}</button>
        ))}
      </div>
      <div class="cob-bars">
        {sorted.map((r) => {
          const width = r.score === null ? 0 : r.score;
          const isOurs = r.group_key === "miiwan";
          const label = r.score === null ? "N/A" : Math.round(r.score).toString();
          const isFallback = r.display_mode === "current";
          const fillClass = "cob-bar-fill" + (isFallback ? " fallback" : "");
          const thinNote = r.thin && r.display_mode !== "none"
            ? " · 표본 적음 — 중립 보정된 점수"
            : "";
          const tooltip = r.display_mode === "none"
            ? `${MODE_LABEL[mode]}: 데이터 없음`
            : isFallback
              ? `선택 버킷 데이터 없음 — 현재 시점(${r.shown_bucket}) 점수 표시 · ${r.sample_count} videos${thinNote}`
              : `${r.sample_count} videos${thinNote}`;
          return (
            <div class={`cob-row ${isOurs ? "ours" : ""}`} key={r.group_key} title={tooltip}>
              <div class="cob-name">{r.group_key.toUpperCase()}</div>
              <div class="cob-bar-track">
                <div class={fillClass}
                     style={{ width: `${width}%`, background: scoreColor(r.score) }} />
              </div>
              <div class="cob-score">
                <span class="cob-score-value">{label}</span>
                {r.thin && r.score !== null && (
                  <span class="cob-thin-tag" aria-label="표본 적음">*</span>
                )}
                {isFallback && (
                  <span class="cob-current-tag">@{r.shown_bucket}</span>
                )}
              </div>
              {isOurs && <div class="cob-tag">← ours</div>}
            </div>
          );
        })}
      </div>
      <div class="cob-footer">
        {sorted.length}개 그룹 표시 · 구간 {bucket} · {MODE_LABEL[mode]}
        {fallbackCount > 0 && (
          <> · <span class="cob-fallback-note">
            {fallbackCount}개 그룹은 해당 버킷 데이터 없어 현재 시점 점수로 표시 (@버킷)
          </span></>
        )}
        <br />
        진정성(오가닉) 점수 = 진정성(비율) 신호 · 조회수 규모와 무관 — 막대 길이는 "진짜인가"지 "큰가"가 아님.
        {" "}<span class="cob-thin-legend">* 표본 적음(scored &lt; 3) — 중립으로 보정된 점수, 성장·볼륨은 성장 탭 참고.</span>
      </div>
    </section>
  );
}
