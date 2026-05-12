import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

const BUCKETS = ["D-60", "D-30", "D-Day", "D+30", "D+60"] as const;

interface SummaryRow {
  group_key: string;
  window_bucket: string;
  video_count: number;
  organic_score_mean: number | null;
  organic_ratio: number | null;
  suspect_ratio: number | null;
  likely_paid_ratio: number | null;
}

interface Props {
  groupKey: string;
}

function colorForScore(score: number | null): string {
  if (score === null) return "#6b7280";   // gray
  if (score >= 70) return "#22c55e";       // organic green
  if (score >= 40) return "#eab308";       // suspect yellow
  return "#ef4444";                        // likely_paid red
}

export function DebutWindowKPI({ groupKey }: Props) {
  const [byBucket, setByBucket] = useState<Map<string, SummaryRow> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary().then((r: { rows: SummaryRow[] }) => {
      if (cancelled) return;
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
        {BUCKETS.map((b) => {
          const row = byBucket.get(b);
          const score = row?.organic_score_mean ?? null;
          const display = score === null ? "—" : Math.round(score).toString();
          const tooltip = row
            ? `${row.video_count} videos · organic ${(100 * (row.organic_ratio ?? 0)).toFixed(0)}% · likely_paid ${(100 * (row.likely_paid_ratio ?? 0)).toFixed(0)}%`
            : "no data";
          return (
            <div class="kpi-debutwin-cell" key={b} title={tooltip}>
              <div class="kpi-debutwin-bucket">{b}</div>
              <div class="kpi-debutwin-score" style={{ color: colorForScore(score) }}>
                {display}
              </div>
            </div>
          );
        })}
      </div>
      <div class="kpi-debutwin-note">view-weighted mean per bucket</div>
    </div>
  );
}
