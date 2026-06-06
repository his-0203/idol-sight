import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return jsonResponse({ error: "missing_q" }, 400);
  // Escape LIKE wildcards in user input so "100%" / "a_b" match literally
  // instead of acting as wildcards; pair every LIKE with ESCAPE '\'.
  const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const [groups, members, naver, community] = await Promise.all([
    d1Query(env.DB,
      "SELECT key, name, name_kr FROM groups WHERE is_active=1 "
      + "AND (key LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' "
      + "OR name_kr LIKE ? ESCAPE '\\') LIMIT 20",
      [like, like, like]),
    d1Query(env.DB,
      "SELECT id, name, group_key FROM members WHERE active=1 "
      + "AND (name LIKE ? ESCAPE '\\' OR name_en LIKE ? ESCAPE '\\') LIMIT 20",
      [like, like]),
    d1Query(env.DB,
      "SELECT url, title FROM naver_articles WHERE COALESCE(is_excluded,0)=0 "
      + "AND title LIKE ? ESCAPE '\\' ORDER BY published_at DESC LIMIT 20", [like]),
    d1Query(env.DB,
      "SELECT url, title, platform FROM community_posts WHERE title LIKE ? ESCAPE '\\' "
      + "ORDER BY posted_at DESC LIMIT 20", [like]),
  ]);
  return jsonResponse({ q, groups, members, naver, community });
};
