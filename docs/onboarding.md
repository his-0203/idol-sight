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

## V2.20 Debut Window Organicity 백필 (1회성, PR 머지 후)

새로 마이그레이션된 `debut_window_video_organicity` / `debut_window_organicity_summary`
테이블을 처음 채우는 절차. 이미 데뷔한 그룹의 D-60~D+60 영상 메타데이터/통계가
필요하므로 `backfill-yt-videos` 워크플로를 9개 그룹 각각 실행한 뒤, 일일
aggregate를 한 번 돌려 신규 테이블을 채운다.

**PR 머지 후 운영 단계에서 진행. PR 진행 중에는 실행하지 말 것.**

1. 마이그레이션 원격 적용:
   ```bash
   cd frontend && wrangler d1 migrations apply idol-sight --remote
   ```
2. 9개 그룹 백필 — GitHub Actions UI에서 `backfill-yt-videos` workflow_dispatch
   를 그룹마다 실행하거나, 다음 CLI를 9번 호출:
   ```bash
   for g in plave isedol stellive skinz myrakl miiwan owis bdawn wegosix; do
     gh workflow run backfill-yt-videos.yml -f group=$g
   done
   ```
3. 백필 완료 확인 후 (`gh run list --workflow=backfill-yt-videos.yml --limit 9`),
   collect-daily 워크플로의 다음 자동 실행이 `aggregate` 안에서 신규 단계
   (`debut_window_videos`, `debut_window_summary`)를 자동 실행한다.
   즉시 채우려면:
   ```bash
   gh workflow run collect-daily.yml
   ```
4. 대시보드(idol-sight.pages.dev)에서 그룹 카드의 "Debut Window Organicity"
   행이 N/A 가 아닌 점수로 채워졌는지 확인. GroupContent의 "Debut Window"
   섹션과 MiiWAN Briefing의 "Competitive Debut Window Posture" 차트도 데이터
   로딩 확인.
5. D1 직접 확인:
   ```bash
   cd frontend && wrangler d1 execute idol-sight --remote \
     --command="SELECT COUNT(*) FROM debut_window_video_organicity"
   cd frontend && wrangler d1 execute idol-sight --remote \
     --command="SELECT group_key, window_bucket, video_count, organic_score_mean
                FROM debut_window_organicity_summary
                ORDER BY group_key, window_bucket"
   ```

## V2.21 Backfill Resilience 운영 가이드

`backfill-yt-videos` 워크플로가 matrix per-group 구조(2026-05-12 V2.21)로
재작성되어 다음 운영 패턴을 지원한다.

### 일상 운영

- **전체 그룹 백필 (default)**: GitHub UI → Actions → backfill-yt-videos →
  Run workflow → `group=all`, `force=false` → 9개 matrix job 병렬 실행
  (max-parallel 3). 최근 7일 안에 backfill된 그룹은 자동으로 skip.
- **단일 그룹 백필**: `group=<key>` 입력 → 해당 그룹만 실행 (나머지는
  matrix `if` 조건으로 즉시 skipped). 단일 그룹 모드는 freshness 필터를
  무시 (운영자가 명시적으로 재실행을 요청한 것으로 간주).

### 강제 재백필 (seed correction 후 등)

- `group=all`, `force=true` → 9개 그룹 모두 freshness 무시하고 walk.
  CLI 측에서 `--force` 플래그 전달.

### 부분 실패 자동 복원

- 한 그룹이 30분 timeout으로 cancelled → 다른 8개는 영향 없음. 다음
  스케줄 또는 수동 dispatch에서 자동으로 그 그룹만 다시 walk
  (last_backfilled_at이 갱신되지 않았으므로 freshness 필터에 안 걸림).

### 가시화 / 알림

- `health-check` 워크플로가 14일+ 백필 stale 그룹을 감지하면 Discord에
  `backfill:<group>: last_success_at=... (age=...h)` 형식으로 알림.
- D1 직접 확인:
  ```bash
  cd frontend && wrangler d1 execute idol-sight --remote \
    --command="SELECT key, last_backfilled_at,
               CAST(julianday('now') - julianday(last_backfilled_at) AS INTEGER) AS days_ago
               FROM groups ORDER BY last_backfilled_at NULLS FIRST"
  ```
