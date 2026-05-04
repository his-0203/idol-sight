#!/usr/bin/env bash
# scripts/setup.sh — one-shot Cloudflare resource provisioning.
#
# Prereqs (the human user must do these first; see docs/onboarding.md):
#   1. Cloudflare account exists, API token created with D1 + Pages perms
#   2. `wrangler` and `gh` CLIs installed and authenticated locally
#   3. CF_API_TOKEN and CF_ACCOUNT_ID exported in the current shell
#
# What this script does (idempotent):
#   - Creates the D1 database "idol-sight" if it does not exist
#   - Patches frontend/wrangler.toml with the real database_id
#   - Creates a Cloudflare Pages project "idol-sight" if it does not exist
#   - Applies migrations (remote)
#   - Prints the GitHub Secrets/Vars the user must register

set -euo pipefail

cd "$(dirname "$0")/.."

REPO_ROOT="$(pwd)"
WRANGLER_TOML="$REPO_ROOT/frontend/wrangler.toml"
PROJECT="idol-sight"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required cli: $1" >&2
    exit 1
  }
}

require wrangler
require gh
require jq
require sed
require node
require openssl

[[ -n "${CF_API_TOKEN:-}" ]] || { echo "export CF_API_TOKEN first" >&2; exit 1; }
[[ -n "${CF_ACCOUNT_ID:-}" ]] || { echo "export CF_ACCOUNT_ID first" >&2; exit 1; }

if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

echo "==> ensuring D1 database '$PROJECT' exists"
DB_ID="$(wrangler d1 list --json 2>/dev/null \
          | jq -r ".[] | select(.name==\"$PROJECT\") | .uuid" \
          || true)"

if [[ -z "${DB_ID:-}" ]]; then
  echo "==> creating D1 database '$PROJECT'"
  CREATE_OUT="$(wrangler d1 create "$PROJECT")"
  DB_ID="$(echo "$CREATE_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
  [[ -n "$DB_ID" ]] || { echo "could not extract D1 id from wrangler output" >&2; exit 1; }
fi
echo "    D1 id: $DB_ID"

echo "==> patching $WRANGLER_TOML"
if grep -q "REPLACE_WITH_REAL_ID" "$WRANGLER_TOML"; then
  sed -i.bak "s|REPLACE_WITH_REAL_ID|$DB_ID|" "$WRANGLER_TOML" && rm -f "$WRANGLER_TOML.bak"
  echo "    patched (database_id=$DB_ID)"
else
  current=$(grep -E '^database_id\s*=\s*"' "$WRANGLER_TOML" | sed -E 's/.*"([^"]+)".*/\1/')
  if [[ "$current" == "$DB_ID" ]]; then
    echo "    already patched (database_id=$DB_ID)"
  else
    echo "    WARNING: $WRANGLER_TOML has database_id=$current but D1 returned $DB_ID" >&2
    echo "    (will not overwrite a hand-edited file; fix manually if needed)" >&2
  fi
fi

echo "==> applying migrations (remote)"
( cd frontend && wrangler d1 migrations apply "$PROJECT" --remote )

echo "==> ensuring Cloudflare Pages project '$PROJECT' exists"
if ! wrangler pages project list 2>/dev/null | grep -qE "^[[:space:]]*$PROJECT[[:space:]]"; then
  wrangler pages project create "$PROJECT" --production-branch main
fi

echo "==> generating SITE_PASSWORD_HASH and COOKIE_SECRET"
SITE_PASSWORD="${SITE_PASSWORD:-Virtual2026}"
PASSWORD_HASH="$(node "$REPO_ROOT/scripts/gen-password-hash.mjs" "$SITE_PASSWORD")"
COOKIE_SECRET="$(openssl rand -hex 32)"

cat <<EOF

==============================================================================
Done. Generated values (record these now — they will not be shown again):

  SITE_PASSWORD       = $SITE_PASSWORD
  SITE_PASSWORD_HASH  = $PASSWORD_HASH
  COOKIE_SECRET       = $COOKIE_SECRET
  CF_D1_DB_ID         = $DB_ID

Next manual steps (one time):

1. Register GitHub Secrets:
       printf %s "\$CF_ACCOUNT_ID"      | gh secret set CF_ACCOUNT_ID
       printf %s "$DB_ID"              | gh secret set CF_D1_DB_ID
       printf %s "\$CF_API_TOKEN"       | gh secret set CF_API_TOKEN
       printf %s "$PASSWORD_HASH"       | gh secret set SITE_PASSWORD_HASH
       printf %s "$COOKIE_SECRET"       | gh secret set COOKIE_SECRET
       gh secret set DISCORD_WEBHOOK   # paste when prompted
       gh secret set YT_API_KEY        # paste when prompted
       gh secret set GEMINI_API_KEY    # paste when prompted

2. In the Cloudflare Pages dashboard for project '$PROJECT', register:
   - Environment variable SITE_PASSWORD_HASH (same value as above)
   - Environment variable COOKIE_SECRET (same value as above)
   - D1 binding: variable name DB → database '$PROJECT'

3. Push to main; the frontend-deploy workflow runs automatically.
==============================================================================
EOF
