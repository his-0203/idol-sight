import { hmacVerify } from "./lib/hmac";
import { AUTH_MESSAGE, getCookie } from "./lib/cookies";
import { ACCESS_COOKIE, isDocumentLoad, newClientId } from "./lib/accessLog";
import type { D1Database } from "./lib/d1";

type Env = {
  COOKIE_SECRET: string;
  DB?: D1Database;
};

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, next, env } = ctx;
  const url = new URL(request.url);

  const isApi =
    url.pathname.startsWith("/api/") && !url.pathname.startsWith("/__auth");

  // 인증 여부 판정 — 비용을 아끼려 필요한 경우(API 또는 문서 로드)에만 HMAC 검증.
  const docLoad = isDocumentLoad(request, url.pathname);
  let authed = false;
  if (isApi || docLoad) {
    const sig = getCookie(request, "idol_radar_auth");
    if (sig) authed = await hmacVerify(env.COOKIE_SECRET, sig, AUTH_MESSAGE);
  }

  // 기존 동작: 미인증 /api/* 는 401 (cid 쿠키 발급 전에 즉시 차단).
  if (isApi && !authed) return new Response("unauth", { status: 401 });

  // client_id 쿠키 보장 — 없으면 새로 발급.
  let cid = getCookie(request, ACCESS_COOKIE);
  const newCid = !cid;
  if (!cid) cid = newClientId();

  // 접속 로깅: 로그인된 문서 로드만, 비차단.
  if (authed && docLoad && env.DB) {
    const p = env.DB.prepare("INSERT INTO access_log (client_id) VALUES (?)")
      .bind(cid)
      .run()
      .catch(() => {});
    if (ctx.waitUntil) ctx.waitUntil(p);
    else await p;
  }

  const res = await next();
  if (newCid) {
    const out = new Response(res.body, res);
    out.headers.append(
      "Set-Cookie",
      `${ACCESS_COOKIE}=${cid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
    );
    return out;
  }
  return res;
};
