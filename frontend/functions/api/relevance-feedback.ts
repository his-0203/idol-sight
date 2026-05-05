// POST /api/relevance-feedback — operator-driven labeling for community
// posts. Sets community_posts.user_flagged_irrelevant=1 plus flagged_at
// and an optional reason. Flagged rows are filtered out of the BI views
// at read time (group/[key].ts), so the operator sees the noise leave
// immediately. The persisted signal is also the substrate for a future
// active-learning loop on the worker side.
//
// We accept either url_hash (preferred — stable) or url (we hash it
// server-side via SHA-256 to match utils.url_hash). If a row is already
// flagged we keep the original flagged_at (idempotent) but allow
// updating the reason.

import { d1QueryOne, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface Body {
  url_hash?: string;
  url?: string;
  group_key?: string;
  reason?: string | null;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const onRequestPost: PagesFunction<{ DB: D1Database }> = async ({ request, env }) => {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  let urlHash = (body.url_hash ?? "").trim();
  if (!urlHash && body.url) {
    urlHash = await sha256Hex(body.url.trim());
  }
  if (!urlHash) return jsonResponse({ error: "url_hash_required" }, 400);
  if (!body.group_key) return jsonResponse({ error: "group_key_required" }, 400);

  const reason = (body.reason ?? "irrelevant").toString().slice(0, 200);
  const nowIso = new Date().toISOString();

  // Confirm the row exists and matches the claimed group_key. This stops
  // a malformed or replay request from flagging an unrelated row.
  const existing = await d1QueryOne<{ url_hash: string; group_key: string; user_flagged_irrelevant: number | null }>(
    env.DB,
    "SELECT url_hash, group_key, user_flagged_irrelevant FROM community_posts WHERE url_hash = ?",
    [urlHash],
  );
  if (!existing) return jsonResponse({ error: "not_found" }, 404);
  if (existing.group_key !== body.group_key) {
    return jsonResponse({ error: "group_mismatch" }, 409);
  }

  // Keep the first flagged_at on repeat flags (idempotent), but always
  // refresh the reason so the operator can correct a typo.
  await env.DB.prepare(
    `UPDATE community_posts
        SET user_flagged_irrelevant = 1,
            flagged_at = COALESCE(flagged_at, ?),
            flag_reason = ?
      WHERE url_hash = ?`,
  )
    .bind(nowIso, reason, urlHash)
    .all();

  return jsonResponse({ ok: true, url_hash: urlHash, flagged_at: nowIso });
};
