import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface GroupRow {
  key: string;
  name: string;
  name_kr: string;
  debut_date: string | null;
  group_model: string | null;
  yt_channel_id: string | null;
  dc_gallery_id: string | null;
  context_keywords: string | null;
  is_active: number;
  has_data: number;
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  const rows = await d1Query<GroupRow>(
    env.DB,
    `SELECT g.key, g.name, g.name_kr, g.debut_date, g.group_model, g.yt_channel_id,
            g.dc_gallery_id, g.context_keywords, g.is_active,
            CASE WHEN EXISTS (
              SELECT 1 FROM agg_summary s WHERE s.group_key = g.key
            ) THEN 1 ELSE 0 END AS has_data
       FROM groups g
      WHERE g.is_active = 1
      ORDER BY g.key`,
  );
  return jsonResponse({
    groups: rows.map((r) => ({
      key: r.key, name: r.name, name_kr: r.name_kr,
      debut_date: r.debut_date,
      group_model: r.group_model,
      yt_channel_id: r.yt_channel_id,
      dc_gallery_id: r.dc_gallery_id,
      context_keywords: parseList(r.context_keywords),
      has_data: r.has_data === 1,
    })),
  });
};
