# IDOL-SIGHT

Internal BI for tracking 8 virtual idol groups (PLAVE, ISEDOL, STELLIVE, SKINZ, MY:RAKL, MiiWAN, OWIS, B:DAWN).

- **Worker** (`worker/`) — Python 3.12 collectors + analysis, runs on GitHub Actions cron, writes to Cloudflare D1.
- **Frontend** (`frontend/`) — Vite + Preact SPA + Pages Functions, deployed to Cloudflare Pages.
- **Spec** — `docs/superpowers/specs/2026-05-04-idol-sight-rebuild-design.md`
- **Onboarding** — `docs/onboarding.md`

## Quick start

See `docs/onboarding.md` for one-time setup. After secrets are configured:

```bash
# worker (local dry run, no D1 writes)
cd worker && uv sync && uv run python -m idol_sight --help

# frontend (local dev)
cd frontend && pnpm i && pnpm dev
```

## Status

Foundation phase. No data collection yet — see `docs/superpowers/plans/`.
