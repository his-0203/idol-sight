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

function colorForVerdict(v: string): string {
  if (v === "organic")        return "#22c55e";
  if (v === "suspect")        return "#eab308";
  if (v === "likely_paid")    return "#ef4444";
  return "#6b7280";  // insufficient_data
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

  useEffect(() => {
    setRows(null);
    let cancelled = false;
    api.debutWindowVideos(groupKey, bucket, filterType).then((r: { rows: VideoRow[] }) => {
      if (!cancelled) setRows(r.rows);
    }).catch(() => {
      if (!cancelled) setRows([]);
    });
    return () => { cancelled = true; };
  }, [groupKey, bucket, filterType]);

  return (
    <section class="dw-video-section">
      <nav class="dw-bucket-tabs">
        {BUCKETS.map((b) => (
          <button type="button"
                  key={b}
                  class={b === bucket ? "active" : ""}
                  onClick={() => setBucket(b)}>{b}</button>
        ))}
      </nav>

      <div class="dw-type-filter">
        Filter:
        {(["all", "long", "short"] as const).map((t) => (
          <label key={t}>
            <input type="radio" name="dw-type" checked={filterType === t}
                   onChange={() => setFilterType(t)} />
            {t === "all" ? "All" : t === "long" ? "Long-form" : "Shorts"}
          </label>
        ))}
      </div>

      <div class="dw-table-wrap">
        <table class="dw-video-table">
          <thead>
            <tr>
              <th>D-day</th><th>Title</th><th>Type</th>
              <th>Views</th><th>ER</th><th>Score</th><th>판정</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr><td colSpan={7}>Loading…</td></tr>
            )}
            {rows !== null && rows.length === 0 && (
              <tr><td colSpan={7}>No videos in this bucket</td></tr>
            )}
            {rows !== null && rows.map((r) => {
              const dayLabel = r.days_relative_to_debut >= 0
                ? `+${r.days_relative_to_debut}` : `${r.days_relative_to_debut}`;
              return (
                <tr key={r.video_id} onClick={() => setSelected(r)} class="dw-row-clickable">
                  <td>{dayLabel}</td>
                  <td title={r.title ?? ""}>{r.title ?? r.video_id}</td>
                  <td>{r.is_short ? "Shorts" : "Long"}</td>
                  <td>{fmtViews(r.view_count)}</td>
                  <td>{r.engagement_rate === null ? "—" : `${(r.engagement_rate * 100).toFixed(1)}%`}</td>
                  <td>{r.organic_score ?? "—"}</td>
                  <td style={{ color: colorForVerdict(r.verdict) }}>{r.verdict}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && (
        <DebutWindowSignalPanel
          videoId={selected.video_id}
          signalBreakdown={selected.signal_breakdown}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
