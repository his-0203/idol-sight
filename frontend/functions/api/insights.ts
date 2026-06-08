import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

// Row type for the primary path (includes report_kind from migration 0083).
interface InsightRow {
  id: number;
  generated_at: string;
  week_start: string;
  scope: string;
  type: string;
  title: string;
  body: string;
  source_refs_json: string | null;
  ai_comment: string | null;
  report_kind: string | null;
}

// Shared row-mapper — applied to BOTH primary and fallback paths so the
// source_refs parse logic is never duplicated divergently.
const mapRow = (r: InsightRow) => ({
  ...r,
  source_refs: (() => {
    try { return JSON.parse(r.source_refs_json ?? "[]"); }
    catch { return []; }
  })(),
});

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const week = url.searchParams.get("week");

  // Explicit column list — `SELECT *` would also return ai_comment
  // (migration 0039) once D1 is migrated, but listing columns guards
  // against accidental ordering drift if the table is re-created and
  // makes the API contract self-documenting.
  // report_kind (migration 0083): 'final'(일=결산) | 'interim'(수=중간점검).
  const colsPrimary = "id, generated_at, week_start, scope, type, title, body, "
                    + "source_refs_json, ai_comment, report_kind";

  // Primary path: uses report_kind in SELECT and WHERE (requires migration 0083).
  // 기본 피드: final 은 영구 노출, interim 은 최근 3주(week_start >= 오늘-21일)만.
  // ?week= 명시 조회 시엔 그 주의 interim/final 둘 다 노출(필터 미적용).
  const sqlPrimary = week
    ? `SELECT ${colsPrimary} FROM insights WHERE week_start = ? ORDER BY id DESC`
    : `SELECT ${colsPrimary} FROM insights
        WHERE report_kind = 'final'
           OR week_start >= date('now', '-21 days')
        ORDER BY generated_at DESC LIMIT 50`;

  try {
    const rows = await d1Query<InsightRow>(env.DB, sqlPrimary, week ? [week] : []);
    return jsonResponse({ insights: rows.map(mapRow) });
  } catch {
    // Fallback: migration 0083 (report_kind column) not yet applied.
    // Omits report_kind from SELECT and WHERE entirely so the feed keeps
    // working without the column. Rows won't have report_kind; the frontend
    // badge (i.report_kind === "interim") handles undefined gracefully (no badge).
    const colsFallback = "id, generated_at, week_start, scope, type, title, body, "
                       + "source_refs_json, ai_comment";
    const sqlFallback = week
      ? `SELECT ${colsFallback} FROM insights WHERE week_start = ? ORDER BY id DESC`
      : `SELECT ${colsFallback} FROM insights ORDER BY generated_at DESC LIMIT 50`;
    const rows = await d1Query<InsightRow>(env.DB, sqlFallback, week ? [week] : []);
    return jsonResponse({ insights: rows.map(mapRow) });
  }
};
