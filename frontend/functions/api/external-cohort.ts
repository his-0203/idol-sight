// /api/external-cohort — manually-curated benchmark cohort of recent
// live K-pop boy groups. Lets the dashboard frame "where is MiiWAN
// vs the broader market", not just "vs our 7 virtual peers".
//
// Returns each group's roster + the latest external_metrics snapshot.
// Data is human-seeded today; future work is a collector that calls
// Spotify Web API + YouTube Data API to refresh periodically.

import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface RosterRow {
  key: string; name: string; name_kr: string | null;
  agency: string | null; debut_date: string | null;
  group_type: string;
  yt_subscribers: number | null;
  yt_total_views: number | null;
  spotify_monthly_listeners: number | null;
  spotify_followers: number | null;
  snapshot_at: string | null;
  source: string | null;
  notes: string | null;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  // LATERAL-style join workaround for SQLite: pick the latest
  // external_metrics row per group via a correlated subquery on the
  // PK ordering. This stays cheap because external_groups is small
  // (single-digit rows) and external_metrics is indexed on
  // (group_key, snapshot_at DESC).
  const rows = await d1Query<RosterRow>(env.DB,
    `SELECT g.key, g.name, g.name_kr, g.agency, g.debut_date, g.group_type,
            g.notes,
            m.yt_subscribers, m.yt_total_views,
            m.spotify_monthly_listeners, m.spotify_followers,
            m.snapshot_at, m.source
       FROM external_groups g
       LEFT JOIN external_metrics m
              ON m.group_key = g.key
             AND m.snapshot_at = (
               SELECT MAX(snapshot_at) FROM external_metrics
                WHERE group_key = g.key)
      WHERE g.is_active = 1
      ORDER BY g.debut_date DESC, g.name ASC`);

  return jsonResponse({
    cohort: rows.map((r) => ({
      key: r.key, name: r.name, name_kr: r.name_kr,
      agency: r.agency, debut_date: r.debut_date, group_type: r.group_type,
      notes: r.notes,
      metrics: r.snapshot_at ? {
        snapshot_at: r.snapshot_at,
        yt_subscribers: r.yt_subscribers,
        yt_total_views: r.yt_total_views,
        spotify_monthly_listeners: r.spotify_monthly_listeners,
        spotify_followers: r.spotify_followers,
        source: r.source,
      } : null,
    })),
  });
};
