import { hmacVerify } from "./lib/hmac";
import { dayBucket, getCookie } from "./lib/cookies";

export const onRequest: PagesFunction<{
  COOKIE_SECRET: string;
}> = async ({ request, next, env }) => {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/__auth")) return next();
  if (!url.pathname.startsWith("/api/")) return next();

  const sig = getCookie(request, "idol_radar_auth");
  if (!sig) return new Response("unauth", { status: 401 });

  const ok = await hmacVerify(env.COOKIE_SECRET, sig, `auth|${dayBucket()}`);
  if (!ok) return new Response("unauth", { status: 401 });

  return next();
};
