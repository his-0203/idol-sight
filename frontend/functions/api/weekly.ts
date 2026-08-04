import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  // Derive the current report week from insights instead of returning the full list.
  const weekRow = await d1Query<{ week_start: string | null }>(env.DB,
    `SELECT MAX(week_start) AS week_start
       FROM insights
      WHERE type IN ('weekly', 'insight', 'ipx_action')`);
  const week_start = weekRow[0]?.week_start ?? null;

  // 초동 아카이브 전체 — hanteo_weekly는 주간 수집이 없는 수동 검증
  // 시드라 "최신 주만" 필터하면 몇 달 전 1행만 남는다(주간 브리프가
  // 낡아 보이던 원인). 최근 앨범부터 전량 반환(행 수 소수).
  const hanteo = await d1Query<any>(env.DB,
    `SELECT h.week_start, h.week_end, h.group_key,
            COALESCE(g.name, h.group_key) AS group_name,
            h.album, h.rank, h.sales, h.note
       FROM hanteo_weekly h
       LEFT JOIN groups g ON g.key = h.group_key
      ORDER BY h.week_end DESC, h.sales DESC`);
  const movers = await d1Query<any>(env.DB,
    `SELECT s.group_key,
            COALESCE(g.name, s.group_key) AS group_name,
            s.yt_total_views - COALESCE(p.yt_total_views, 0) AS d_views,
            s.dc_total_posts  - COALESCE(p.dc_total_posts, 0)  AS d_dc
       FROM agg_summary s
       LEFT JOIN groups g ON g.key = s.group_key
       LEFT JOIN agg_summary p
              ON p.group_key = s.group_key
             AND p.snapshot_at = (
                SELECT MAX(snapshot_at) FROM agg_summary
                  WHERE group_key = s.group_key
                    AND snapshot_at < s.snapshot_at)
      WHERE s.snapshot_at = (SELECT MAX(snapshot_at) FROM agg_summary)
      ORDER BY d_views DESC NULLS LAST`);
  return jsonResponse({ week_start, hanteo, movers });
};
