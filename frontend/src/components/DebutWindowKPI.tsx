import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { headlineOrganicScore, scoreColor } from "../lib/organicity";
import { DEFAULT_DISPLAY_BUCKETS } from "../lib/debutWindow";

interface SummaryRow {
  group_key: string;
  window_bucket: string;
  video_count: number;
  organic_score_mean: number | null;
  organic_score_mean_simple: number | null;
  organic_strong_ratio: number | null;
  organic_ratio: number | null;
  borderline_ratio: number | null;
  suspect_ratio: number | null;
  likely_paid_ratio: number | null;
}

// Compact "12%" from a 0-1 ratio (null → 0%).
function pct(r: number | null | undefined): string {
  return `${Math.round(100 * (r ?? 0))}%`;
}

interface Props {
  groupKey: string;
}

// score → color: see src/lib/organicity.ts (single source of truth).

export function DebutWindowKPI({ groupKey }: Props) {
  const [byBucket, setByBucket] = useState<Map<string, SummaryRow> | null>(null);
  // V2.49: 표시 버킷은 summary 응답의 window 메타 (롤링 창). 부재 시 fallback.
  const [buckets, setBuckets] = useState<string[]>(DEFAULT_DISPLAY_BUCKETS);

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary<SummaryRow>().then((r) => {
      if (cancelled) return;
      if (r.window?.buckets?.length) setBuckets(r.window.buckets);
      const filtered = r.rows.filter((x) => x.group_key === groupKey);
      const m = new Map<string, SummaryRow>();
      for (const row of filtered) m.set(row.window_bucket, row);
      setByBucket(m);
    }).catch(() => {
      // graceful: leave at null → loading state. Errors are non-fatal here.
    });
    return () => { cancelled = true; };
  }, [groupKey]);

  if (!byBucket) return <div class="kpi-debutwin loading">…</div>;

  return (
    <div class="kpi-debutwin">
      <div class="kpi-debutwin-label">Debut Window Organicity</div>
      <div class="kpi-debutwin-row">
        {buckets.map((b) => {
          const row = byBucket.get(b);
          const score = row ? headlineOrganicScore(row) : null;
          const display = score === null ? "—" : Math.round(score).toString();
          const weighted = row?.organic_score_mean;
          const tooltip = row
            ? `${row.video_count} videos · `
              + `strong ${pct(row.organic_strong_ratio)} · `
              + `organic ${pct(row.organic_ratio)} · `
              + `border ${pct(row.borderline_ratio)} · `
              + `suspect ${pct(row.suspect_ratio)} · `
              + `paid ${pct(row.likely_paid_ratio)} · `
              + `reach-wtd ${weighted === null || weighted === undefined ? "—" : Math.round(weighted)}`
            : "no data";
          return (
            <div class="kpi-debutwin-cell" key={b} title={tooltip}>
              <div class="kpi-debutwin-bucket">{b}</div>
              <div class="kpi-debutwin-score" style={{ color: scoreColor(score) }}>
                {display}
              </div>
            </div>
          );
        })}
      </div>
      {(() => {
        // V2.42: groups with no announced debut_date have no windowed buckets,
        // but their videos are scored into the 'Undated' bucket. Surface that
        // here as a pre-debut posture line (anchor-independent).
        const u = byBucket.get("Undated");
        if (!u) return null;
        const s = headlineOrganicScore(u);
        return (
          <div class="kpi-debutwin-note" title={`${u.video_count} videos · pre-debut (데뷔일 미설정)`}>
            pre-debut · {u.video_count}개 영상 · 평균{" "}
            {s === null
              ? <span>판정 보류</span>
              : <strong style={{ color: scoreColor(s) }}>{Math.round(s)}점</strong>}
          </div>
        );
      })()}
    </div>
  );
}
