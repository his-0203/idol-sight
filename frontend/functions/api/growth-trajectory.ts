// frontend/functions/api/growth-trajectory.ts
//
// Returns the latest growth-trajectory snapshot for one group. Graceful:
// if the table doesn't exist yet (migration 0081 not applied), or the group
// has no row, returns { status: "no_data" } instead of 500 — so a deploy that
// precedes the operator's remote migration apply doesn't break the tab.

import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface TrajectoryRow {
  group_key: string;
  computed_at: string;
  status: string;
  history_days: number;
  posture_label: string | null;
  weakest_pillar: string | null;
  pillars: string;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const group = url.searchParams.get("group");
  if (!group) return jsonResponse({ error: "group required" }, 400);

  try {
    const rows = await d1Query<TrajectoryRow>(
      env.DB,
      `SELECT group_key, computed_at, status, history_days,
              posture_label, weakest_pillar, pillars
       FROM group_growth_trajectory WHERE group_key = ?`,
      [group],
    );
    const row = rows[0];
    if (!row) return jsonResponse({ status: "no_data" }, 200);
    let pillars: unknown = [];
    try { pillars = JSON.parse(row.pillars); } catch { pillars = []; }
    return jsonResponse({
      status: row.status,
      computed_at: row.computed_at,
      history_days: row.history_days,
      posture_label: row.posture_label,
      weakest_pillar: row.weakest_pillar,
      pillars,
    }, 200);
  } catch {
    // table missing (pre-migration) or query error → graceful empty.
    return jsonResponse({ status: "no_data" }, 200);
  }
};
