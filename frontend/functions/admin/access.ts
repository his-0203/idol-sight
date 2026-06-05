import { d1Query, type D1Database } from "../lib/d1";
import { renderAdminHtml, safeKeyEqual, shortCid } from "../lib/accessLog";

type Env = { DB: D1Database; ADMIN_KEY?: string };

const notFound = () => new Response("Not Found", { status: 404 });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  // env 미설정 시에도 404 — 존재 자체를 숨긴다.
  if (!env.ADMIN_KEY || !safeKeyEqual(key, env.ADMIN_KEY)) return notFound();

  const weekly = await d1Query<{ wk: string; visitors: number; hits: number }>(
    env.DB,
    `SELECT strftime('%Y-%W', datetime(created_at, '+9 hours')) AS wk,
            COUNT(DISTINCT client_id) AS visitors,
            COUNT(*) AS hits
       FROM access_log
      GROUP BY wk
      ORDER BY wk DESC
      LIMIT 8`,
  );

  const perPersonRaw = await d1Query<{ client_id: string; hits: number }>(
    env.DB,
    `SELECT client_id, COUNT(*) AS hits
       FROM access_log
      WHERE strftime('%Y-%W', datetime(created_at, '+9 hours'))
          = strftime('%Y-%W', datetime('now', '+9 hours'))
      GROUP BY client_id
      ORDER BY hits DESC`,
  );

  const perPerson = perPersonRaw.map((r) => ({ cid: shortCid(r.client_id), hits: r.hits }));
  const html = renderAdminHtml(weekly, perPerson);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
};
