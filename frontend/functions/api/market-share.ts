import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface ShareRow {
  week_start: string; week_end: string; group_key: string;
  cum: number; mom: number; final: number; market_total: number;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const weeks = Math.min(Math.max(parseInt(url.searchParams.get("weeks") ?? "13", 10), 1), 26);
  const rows = await d1Query<ShareRow>(env.DB,
    `SELECT * FROM agg_market_share
      WHERE week_end >= date('now', ?)
      ORDER BY week_start ASC, group_key ASC`,
    [`-${weeks * 7} days`]);
  return jsonResponse({ weeks, rows });
};
