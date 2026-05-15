import { useEffect, useMemo, useState } from "preact/hooks";
import { api } from "../api";

// V2.22 (2026-05-14): split prior 5-bucket layout (D-60/D-30/D-Day/D+30/D+60,
// each ~30d) into 7 ~10d buckets so the picker resolves to D-30/D-20/D-10/
// D-Day/D+10/D+20/D+30.
const BUCKETS = ["D-30", "D-20", "D-10", "D-Day", "D+10", "D+20", "D+30"] as const;
type Bucket = typeof BUCKETS[number];

// V2.22.3 (2026-05-15): legacy V2.21 buckets are still present in
// `debut_window_organicity_summary` for groups whose videos all fall
// outside the new ±30d window (e.g. MiiWAN today: D-32, all videos
// landed in legacy D-60). Keep them out of the picker but allow them
// as last-resort fallback rows so those groups still show up on the
// bar with an explicit "@legacy bucket" stripe.
const LEGACY_BUCKETS = ["D-60", "D+60"] as const;
type LegacyBucket = typeof LEGACY_BUCKETS[number];
type AnyBucket = Bucket | LegacyBucket;
const ALL_BUCKETS = [...BUCKETS, ...LEGACY_BUCKETS] as readonly AnyBucket[];

// V2.22.3 (2026-05-15): user-requested exclusion from the cohort
// posture bar. ISEDOL/STELLIVE are 서브컬처 (segmentary / confederation)
// group_models — the Debut Window organicity metric still computes for
// them under the V2.18 same-formula policy, but on this comparison bar
// the operator wants a corporate K-POP only view, mirroring the
// MarketOverview / GroupContent / DebutCurve subculture gating
// established in V2.15 / V2.21 (the bar was previously the only place
// they showed up).
const EXCLUDED_GROUPS = new Set<string>(["isedol", "stellive"]);

// Score mode = which mean column to render. V2 (migration 0054) adds
// type-split and simple variants so users can defuse Shorts-vs-Long mix
// and view-weighted-single-video dominance.
type Mode = "all_weighted" | "all_simple" | "long" | "short";

const MODE_LABEL: Record<Mode, string> = {
  all_weighted: "All · view-weighted",
  all_simple:   "All · simple mean",
  long:         "Long only",
  short:        "Shorts only",
};

interface SummaryRow {
  group_key: string;
  window_bucket: string;
  organic_score_mean: number | null;
  organic_score_mean_long: number | null;
  organic_score_mean_short: number | null;
  organic_score_mean_simple: number | null;
  video_count: number;
  long_form_count: number;
  short_form_count: number;
}

type DisplayMode = "exact" | "current" | "none";

interface DisplayRow {
  group_key: string;
  score: number | null;
  sample_count: number;
  display_mode: DisplayMode;
  shown_bucket: AnyBucket;
  /** True when shown_bucket is a legacy V2.21 label (D-60 / D+60).
   *  UI renders these with an extra "legacy" indicator so the operator
   *  knows the score was computed under the older calibration window. */
  legacy: boolean;
}

function scoreFor(row: SummaryRow, mode: Mode): number | null {
  if (mode === "all_weighted") return row.organic_score_mean;
  if (mode === "all_simple")   return row.organic_score_mean_simple;
  if (mode === "long")         return row.organic_score_mean_long;
  return row.organic_score_mean_short;
}

function sampleCountFor(row: SummaryRow, mode: Mode): number {
  if (mode === "long")  return row.long_form_count;
  if (mode === "short") return row.short_form_count;
  return row.video_count;
}

// V2.21 5-tier color scale (matches verdictColor in DebutWindowVideoTable).
function colorForScore(score: number | null): string {
  if (score === null) return "#6b7280";
  if (score >= 85) return "#16a34a";
  if (score >= 70) return "#22c55e";
  if (score >= 55) return "#eab308";
  if (score >= 40) return "#f97316";
  return "#ef4444";
}

// Pick what to display for a single group under selected (bucket, mode).
// - exact: the selected bucket has a non-null score for this mode.
// - current: selected bucket empty for this mode → fall back to the group's
//   chronologically latest bucket whose mode column is non-null. First the
//   live V2.22 BUCKETS (chronological reverse), then the V2.21 LEGACY_BUCKETS
//   (D-60 → D+60) as a last resort so pre-window groups like MiiWAN still
//   show up with an explicit @bucket marker. legacy=true on the row triggers
//   a distinct UI stripe.
// - none: the group has no scoreable data in any bucket for this mode.
function pickDisplayRow(
  byBucket: Map<AnyBucket, SummaryRow>,
  selected: Bucket,
  mode: Mode,
  groupKey: string,
): DisplayRow {
  const exact = byBucket.get(selected);
  if (exact && scoreFor(exact, mode) !== null) {
    return {
      group_key: groupKey,
      score: scoreFor(exact, mode),
      sample_count: sampleCountFor(exact, mode),
      display_mode: "exact",
      shown_bucket: selected,
      legacy: false,
    };
  }
  // V2.22 buckets first (chronologically newest → oldest).
  for (let i = BUCKETS.length - 1; i >= 0; i--) {
    const b = BUCKETS[i]!;
    const row = byBucket.get(b);
    if (row && scoreFor(row, mode) !== null) {
      return {
        group_key: groupKey,
        score: scoreFor(row, mode),
        sample_count: sampleCountFor(row, mode),
        display_mode: "current",
        shown_bucket: b,
        legacy: false,
      };
    }
  }
  // Legacy V2.21 buckets as final fallback (D-60 / D+60).
  for (const b of LEGACY_BUCKETS) {
    const row = byBucket.get(b);
    if (row && scoreFor(row, mode) !== null) {
      return {
        group_key: groupKey,
        score: scoreFor(row, mode),
        sample_count: sampleCountFor(row, mode),
        display_mode: "current",
        shown_bucket: b,
        legacy: true,
      };
    }
  }
  return {
    group_key: groupKey,
    score: null,
    sample_count: 0,
    display_mode: "none",
    shown_bucket: selected,
    legacy: false,
  };
}

export function CompetitorOrganicityBar() {
  const [bucket, setBucket] = useState<Bucket>("D-30");
  const [mode, setMode] = useState<Mode>("all_weighted");
  const [allRows, setAllRows] = useState<SummaryRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary().then((r: { rows: SummaryRow[] }) => {
      if (!cancelled) setAllRows(r.rows);
    }).catch(() => {
      if (!cancelled) setAllRows([]);
    });
    return () => { cancelled = true; };
  }, []);

  const display = useMemo<DisplayRow[]>(() => {
    if (!allRows) return [];
    const byGroup = new Map<string, Map<AnyBucket, SummaryRow>>();
    for (const r of allRows) {
      if (EXCLUDED_GROUPS.has(r.group_key)) continue;
      if (!(ALL_BUCKETS as readonly string[]).includes(r.window_bucket)) continue;
      const b = r.window_bucket as AnyBucket;
      let m = byGroup.get(r.group_key);
      if (!m) { m = new Map(); byGroup.set(r.group_key, m); }
      m.set(b, r);
    }
    return Array.from(byGroup.keys()).map((k) =>
      pickDisplayRow(byGroup.get(k)!, bucket, mode, k),
    );
  }, [allRows, bucket, mode]);

  if (!allRows) return <div class="cob-section">Loading…</div>;

  const sorted = [...display].sort((a, b) => {
    if (a.score === null && b.score === null) return 0;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });

  const fallbackCount = sorted.filter(
    (r) => r.display_mode === "current" && !r.legacy,
  ).length;
  const legacyCount = sorted.filter((r) => r.legacy).length;

  return (
    <section class="cob-section">
      <h3>Competitive Debut Window Posture</h3>
      <div class="cob-bucket-picker">
        View bucket:
        {BUCKETS.map((b) => (
          <button type="button"
                  key={b}
                  class={b === bucket ? "active" : ""}
                  onClick={() => setBucket(b)}>{b}</button>
        ))}
      </div>
      <div class="cob-mode-picker">
        Score:
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
          const fillClass = "cob-bar-fill"
            + (isFallback ? " fallback" : "")
            + (r.legacy ? " legacy" : "");
          const tooltip = r.display_mode === "none"
            ? `${MODE_LABEL[mode]}: 데이터 없음`
            : r.legacy
              ? `V2.22 윈도우(±30d) 안에 영상 없음 — V2.21 legacy bucket(${r.shown_bucket}, ±60d) 점수 표시 · ${r.sample_count} videos`
              : isFallback
                ? `선택 버킷 데이터 없음 — 현재 시점(${r.shown_bucket}) 점수 표시 · ${r.sample_count} videos`
                : `${r.sample_count} videos`;
          return (
            <div class={`cob-row ${isOurs ? "ours" : ""}`} key={r.group_key} title={tooltip}>
              <div class="cob-name">{r.group_key.toUpperCase()}</div>
              <div class="cob-bar-track">
                <div class={fillClass}
                     style={{ width: `${width}%`, background: colorForScore(r.score) }} />
              </div>
              <div class="cob-score">
                <span class="cob-score-value">{label}</span>
                {isFallback && (
                  <span class={"cob-current-tag" + (r.legacy ? " legacy" : "")}>
                    @{r.shown_bucket}{r.legacy ? " legacy" : ""}
                  </span>
                )}
              </div>
              {isOurs && <div class="cob-tag">← ours</div>}
            </div>
          );
        })}
      </div>
      <div class="cob-footer">
        Showing {sorted.length} groups · bucket {bucket} · {MODE_LABEL[mode]}
        {fallbackCount > 0 && (
          <> · <span class="cob-fallback-note">
            {fallbackCount}개 그룹은 해당 버킷 데이터 없어 현재 시점 점수로 표시 (@버킷)
          </span></>
        )}
        {legacyCount > 0 && (
          <> · <span class="cob-fallback-note legacy">
            {legacyCount}개 그룹은 V2.22 윈도우에 영상 없어 V2.21 legacy bucket 점수 표시 (@bucket legacy)
          </span></>
        )}
      </div>
    </section>
  );
}
