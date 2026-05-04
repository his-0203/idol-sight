import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return jsonResponse({ error: "missing_q" }, 400);
  const like = `%${q}%`;
  const [groups, members, naver, community] = await Promise.all([
    d1Query(env.DB,
      "SELECT key, name, name_kr FROM groups WHERE is_active=1 "
      + "AND (key LIKE ? OR name LIKE ? OR name_kr LIKE ?) LIMIT 20",
      [like, like, like]),
    d1Query(env.DB,
      "SELECT id, name, group_key FROM members WHERE active=1 "
      + "AND (name LIKE ? OR name_en LIKE ?) LIMIT 20",
      [like, like]),
    d1Query(env.DB,
      "SELECT url, title FROM naver_articles WHERE COALESCE(is_excluded,0)=0 "
      + "AND title LIKE ? ORDER BY published_at DESC LIMIT 20", [like]),
    d1Query(env.DB,
      "SELECT url, title, platform FROM community_posts WHERE title LIKE ? "
      + "ORDER BY posted_at DESC LIMIT 20", [like]),
  ]);
  return jsonResponse({ q, groups, members, naver, community });
};
