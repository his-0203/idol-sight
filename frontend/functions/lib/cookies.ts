export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  const parts = header.split(";").map((s) => s.trim());
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    if (p.slice(0, eq) === name) return p.slice(eq + 1);
  }
  return null;
}

// The signed value inside idol_radar_auth. Deliberately date-INDEPENDENT:
// __auth sets Max-Age=30d, so the cookie's lifetime is governed by Max-Age, not
// by the signed message. (It used to sign `auth|${dayBucket()}` while the
// middleware verified against the *current* day, so every cookie stopped
// verifying at the next UTC midnight — 09:00 KST — silently logging everyone
// out daily.) Bump the suffix to force-invalidate all sessions if ever needed.
export const AUTH_MESSAGE = "auth|v1";

export function dayBucket(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
