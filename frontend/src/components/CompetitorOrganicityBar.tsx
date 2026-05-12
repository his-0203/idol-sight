import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

const BUCKETS = ["D-60", "D-30", "D-Day", "D+30", "D+60"] as const;
type Bucket = typeof BUCKETS[number];

interface SummaryRow {
  group_key: string;
  window_bucket: string;
  organic_score_mean: number | null;
  video_count: number;
}

function colorForScore(score: number | null): string {
  if (score === null) return "#6b7280";
  if (score >= 70) return "#22c55e";
  if (score >= 40) return "#eab308";
  return "#ef4444";
}

export function CompetitorOrganicityBar() {
  const [bucket, setBucket] = useState<Bucket>("D-30");
  const [rows, setRows] = useState<SummaryRow[] | null>(null);

  useEffect(() => {
    setRows(null);
    let cancelled = false;
    api.debutWindowSummary(bucket).then((r: { rows: SummaryRow[] }) => {
      if (!cancelled) setRows(r.rows);
    }).catch(() => {
      if (!cancelled) setRows([]);
    });
    return () => { cancelled = true; };
  }, [bucket]);

  if (!rows) return <div class="cob-section">Loading…</div>;

  // Sort by score desc, N/A last
  const sorted = [...rows].sort((a, b) => {
    if (a.organic_score_mean === null && b.organic_score_mean === null) return 0;
    if (a.organic_score_mean === null) return 1;
    if (b.organic_score_mean === null) return -1;
    return b.organic_score_mean - a.organic_score_mean;
  });

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
      <div class="cob-bars">
        {sorted.map((r) => {
          const score = r.organic_score_mean;
          const width = score === null ? 0 : score;   // 0-100 maps directly
          const isOurs = r.group_key === "miiwan";
          const label = score === null ? "N/A" : Math.round(score).toString();
          return (
            <div class={`cob-row ${isOurs ? "ours" : ""}`} key={r.group_key}>
              <div class="cob-name">{r.group_key.toUpperCase()}</div>
              <div class="cob-bar-track">
                <div class="cob-bar-fill"
                     style={{ width: `${width}%`, background: colorForScore(score) }} />
              </div>
              <div class="cob-score">{label}</div>
              {isOurs && <div class="cob-tag">← ours</div>}
            </div>
          );
        })}
      </div>
      <div class="cob-footer">
        Showing {sorted.length} groups for bucket {bucket}
      </div>
    </section>
  );
}
