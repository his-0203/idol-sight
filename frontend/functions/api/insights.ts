import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const week = url.searchParams.get("week");
  const sql = week
    ? "SELECT * FROM insights WHERE week_start = ? ORDER BY id DESC"
    : "SELECT * FROM insights ORDER BY generated_at DESC LIMIT 50";
  const rows = await d1Query<any>(env.DB, sql, week ? [week] : []);
  return jsonResponse({
    insights: rows.map((r) => ({
      ...r,
      source_refs: (() => { try { return JSON.parse(r.source_refs_json ?? "[]"); }
                            catch { return []; } })(),
    })),
  });
};
