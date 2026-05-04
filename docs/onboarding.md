# IDOL-SIGHT Onboarding

This is the one-time setup. Estimated time: **30 minutes**, mostly waiting for accounts.

Anything marked **[USER]** must be done by a human. Anything marked **[AUTO]** is taken care of by `scripts/setup.sh` or by GitHub Actions.

---

## 1. Prerequisites — install CLIs

```bash
brew install gh jq
npm i -g wrangler
```

```bash
# ensure Python 3.12 + uv
brew install uv
```

## 2. **[USER]** Create accounts and tokens

| What | Where | Notes |
|---|---|---|
| Cloudflare account | https://dash.cloudflare.com/sign-up | Free plan is enough |
| Cloudflare API token | Profile → API Tokens → Create Token | Template: "Edit Cloudflare Workers" + add D1 Edit + Pages Edit |
| Cloudflare Account ID | Right sidebar of any Cloudflare dashboard page | Hex string |
| YouTube Data API v3 key | https://console.cloud.google.com/ → APIs & Services | Enable "YouTube Data API v3", create API key |
| Google Gemini API key | https://aistudio.google.com/apikey | Free tier: 1M tokens/day |
| Discord webhook URL | Channel settings → Integrations → Webhooks | One channel for ops alerts |
| GitHub repo | Make `idol-sight` repo on github.com (public) | `gh repo create idol-sight --public --source=. --remote=origin --push` |

Export the ones the script needs in your shell:

```bash
export CF_API_TOKEN=...
export CF_ACCOUNT_ID=...
```

## 3. **[AUTO]** Provision Cloudflare resources

```bash
./scripts/setup.sh
```

This creates the D1 DB, patches `wrangler.toml`, applies migrations, and creates the Pages project.
At the end it prints exact `gh secret set` commands.

## 4. **[AUTO]** Password hash and cookie secret

`scripts/setup.sh` already generated and printed both for you in step 3. If you need to
regenerate them later (e.g. password rotation), run:

```bash
SITE_PASSWORD="newPassword" ./scripts/setup.sh
```

…or to compute just the hash without re-provisioning anything:

```bash
node scripts/gen-password-hash.mjs "newPassword"
openssl rand -hex 32
```

## 5. **[USER]** Register GitHub Secrets

Run the commands printed by `setup.sh`. Verify with:

```bash
gh secret list
```

Expected:

```
CF_ACCOUNT_ID
CF_API_TOKEN
CF_D1_DB_ID
COOKIE_SECRET
DISCORD_WEBHOOK
GEMINI_API_KEY
SITE_PASSWORD_HASH
YT_API_KEY
```

## 6. **[USER]** Register Cloudflare Pages env vars

Cloudflare Pages dashboard → project `idol-sight` → Settings → Environment Variables (Production):

- `SITE_PASSWORD_HASH` = same value as the GitHub secret
- `COOKIE_SECRET` = same value as the GitHub secret

Also under "Functions" → "D1 database bindings":
- variable name `DB` → database `idol-sight`

## 7. **[USER]** First deploy

```bash
git push origin main
```

The `frontend-deploy` workflow runs and publishes the SPA to `https://idol-sight.pages.dev/` (or your custom subdomain).

## 8. Smoke test

Visit the deployed URL.

- You should see "IDOL-SIGHT" with "API: ok" below it (after entering the password — currently the password gate is enforced by middleware on `/api/ping`; a friendlier login UI lands in Plan 4).
- `crawl_meta` is empty — that's expected; collectors arrive in Plan 2.

## Troubleshooting

- **`wrangler d1 migrations apply` says "no such file"** — make sure you ran from `frontend/` and that `wrangler.toml` has `migrations_dir = "../migrations"`.
- **Pages build fails with "REPLACE_WITH_REAL_ID"** — `setup.sh` failed to patch. Manually edit `frontend/wrangler.toml` and re-deploy.
- **`/api/ping` returns 401** — middleware is protecting it. POST your password to `/__auth` first or send a valid signed cookie.
