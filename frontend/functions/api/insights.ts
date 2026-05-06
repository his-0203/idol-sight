import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const week = url.searchParams.get("week");
  // Explicit column list — `SELECT *` would also return ai_comment
  // (migration 0039) once D1 is migrated, but listing columns guards
  // against accidental ordering drift if the table is re-created and
  // makes the API contract self-documenting.
  const cols = "id, generated_at, week_start, scope, type, title, body, "
             + "source_refs_json, ai_comment";
  const sql = week
    ? `SELECT ${cols} FROM insights WHERE week_start = ? ORDER BY id DESC`
    : `SELECT ${cols} FROM insights ORDER BY generated_at DESC LIMIT 50`;
  const rows = await d1Query<any>(env.DB, sql, week ? [week] : []);
  return jsonResponse({
    insights: rows.map((r) => ({
      ...r,
      source_refs: (() => { try { return JSON.parse(r.source_refs_json ?? "[]"); }
                            catch { return []; } })(),
    })),
  });
};
