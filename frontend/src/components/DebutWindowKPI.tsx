import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

// V2.34 (2026-05-27): 균등 20일 폭 7 bucket. 이전 5탭 (D-60/D-30/D-Day/D+30/D+60)
// 은 worker 의 비대칭 폭 (30/10/3일) 을 union 매핑으로 합쳐 가렸음.
// 균등 폭 통일 후 worker bucket 과 1:1 매핑 → 7 탭 모두 노출하여
// 연속 데뷔 windowing 비교 가능.
const BUCKETS = [
  "D-60", "D-40", "D-20", "D-Day", "D+20", "D+40", "D+60",
] as const;

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

// V2.21 5-tier color scale (matches verdictColor in DebutWindowVideoTable).
function colorForScore(score: number | null): string {
  if (score === null) return "#6b7280";    // gray (no data)
  if (score >= 85) return "#16a34a";        // organic_strong
  if (score >= 70) return "#22c55e";        // organic
  if (score >= 55) return "#eab308";        // borderline
  if (score >= 40) return "#f97316";        // suspect
  return "#ef4444";                          // likely_paid
}

export function DebutWindowKPI({ groupKey }: Props) {
  const [byBucket, setByBucket] = useState<Map<string, SummaryRow> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.debutWindowSummary<SummaryRow>().then((r) => {
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
