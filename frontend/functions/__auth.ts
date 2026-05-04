import { hmacSign, verifyPassword } from "./lib/hmac";
import { dayBucket } from "./lib/cookies";

export const onRequestPost: PagesFunction<{
  SITE_PASSWORD_HASH: string;
  COOKIE_SECRET: string;
}> = async ({ request, env }) => {
  const fd = await request.formData();
  const pw = String(fd.get("password") ?? "");

  if (!(await verifyPassword(pw, env.SITE_PASSWORD_HASH))) {
    const headers = new Headers({ Location: "/?err=1" });
    return new Response(null, { status: 302, headers });
  }

  const sig = await hmacSign(env.COOKIE_SECRET, `auth|${dayBucket()}`);
  const headers = new Headers({
    Location: "/",
    "Set-Cookie": `idol_radar_auth=${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
  });
  return new Response(null, { status: 302, headers });
};
