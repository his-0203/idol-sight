// /api/group-events — read group_events table (migration 0017).
//
// Query parameters:
//   group: optional group_key. If present, only that group's events.
//          If absent, all groups' events (cap 200 rows).
//   from:  optional ISO date (inclusive). Default = now - 90d.
//   to:    optional ISO date (inclusive). Default = now + 90d.
//
// The from/to defaults give the operator a 6-month window centered
// on today, which fits the DebutCurve / MiiWAN briefing usage where
// recent + upcoming events are what matter; older history is still
// reachable by widening the range.

import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface EventRow {
  id: number;
  group_key: string;
  event_date: string;
  event_type: string;
  title: string;
  description: string | null;
  source_url: string | null;
  confidence: string;
}

const DEFAULT_FROM_OFFSET_DAYS = -90;
const DEFAULT_TO_OFFSET_DAYS = 90;
const ABSOLUTE_LIMIT = 200;

function isoOffset(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const group = url.searchParams.get("group");
  const from = url.searchParams.get("from") || isoOffset(DEFAULT_FROM_OFFSET_DAYS);
  const to   = url.searchParams.get("to")   || isoOffset(DEFAULT_TO_OFFSET_DAYS);

  const sql = group
    ? `SELECT id, group_key, event_date, event_type, title, description,
              source_url, confidence
         FROM group_events
        WHERE group_key = ?
          AND event_date >= ? AND event_date <= ?
        ORDER BY event_date ASC LIMIT ?`
    : `SELECT id, group_key, event_date, event_type, title, description,
              source_url, confidence
         FROM group_events
        WHERE event_date >= ? AND event_date <= ?
        ORDER BY event_date ASC LIMIT ?`;
  const params = group ? [group, from, to, ABSOLUTE_LIMIT] : [from, to, ABSOLUTE_LIMIT];

  const rows = await d1Query<EventRow>(env.DB, sql, params);
  return jsonResponse({ from, to, group: group ?? null, events: rows });
};
