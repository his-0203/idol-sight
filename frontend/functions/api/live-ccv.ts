// /api/live-ccv — per ccv_tracked group: the most-recent broadcast's peak/avg +
// a recent-sample sparkline. Behind site auth (middleware 401s /api/*).
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface AggRow {
  group_key: string; video_id: string; title: string | null;
  peak: number; avg: number; n: number; last_at: string;
}
interface SampleRow {
  video_id: string; sampled_at: string; concurrent_viewers: number;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const aggs = await d1Query<AggRow>(env.DB,
    "SELECT group_key, video_id, MAX(title) AS title, "
    + "       MAX(concurrent_viewers) AS peak, AVG(concurrent_viewers) AS avg, "
    + "       COUNT(*) AS n, MAX(sampled_at) AS last_at "
    + "FROM live_ccv_samples GROUP BY group_key, video_id "
    + "ORDER BY group_key, last_at DESC");

  const latestByGroup = new Map<string, AggRow>();
  for (const r of aggs) {
    if (!latestByGroup.has(r.group_key)) latestByGroup.set(r.group_key, r);
  }
  const latest = [...latestByGroup.values()];

  let samplesByVideo = new Map<string, { t: string; ccv: number }[]>();
  if (latest.length) {
    const ids = latest.map((r) => r.video_id);
    const ph = ids.map(() => "?").join(",");
    const samples = await d1Query<SampleRow>(env.DB,
      `SELECT video_id, sampled_at, concurrent_viewers FROM live_ccv_samples `
      + `WHERE video_id IN (${ph}) ORDER BY sampled_at`, ids);
    samplesByVideo = samples.reduce((m, s) => {
      const arr = m.get(s.video_id) ?? [];
      arr.push({ t: s.sampled_at, ccv: s.concurrent_viewers });
      m.set(s.video_id, arr);
      return m;
    }, new Map<string, { t: string; ccv: number }[]>());
  }

  const groups = latest.map((r) => ({
    group_key: r.group_key,
    video_id: r.video_id,
    title: r.title,
    peak: r.peak,
    avg: Math.round(r.avg),
    sample_count: r.n,
    last_at: r.last_at,
    samples: samplesByVideo.get(r.video_id) ?? [],
  }));

  return jsonResponse({ groups });
};
