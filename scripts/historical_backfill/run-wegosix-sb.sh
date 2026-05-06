#!/usr/bin/env bash
# Wrapper for the Wegosix-only Social Blade Matrix API fetch.
# Required env vars:
#   SOCIALBLADE_CLIENT_ID
#   SOCIALBLADE_TOKEN
#
# Usage:
#   export SOCIALBLADE_CLIENT_ID=cli_xxx
#   export SOCIALBLADE_TOKEN=tok_xxx
#   bash scripts/historical_backfill/run-wegosix-sb.sh --history archive
#
# Pass any extra args (e.g. --history default to save credits) and they
# forward to socialblade_fetch.py.
set -euo pipefail
: "${SOCIALBLADE_CLIENT_ID:?env var SOCIALBLADE_CLIENT_ID required}"
: "${SOCIALBLADE_TOKEN:?env var SOCIALBLADE_TOKEN required}"

HERE="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$HERE"

exec uv run scripts/historical_backfill/socialblade_fetch.py \
  --only wegosix \
  --out-migration migrations/0035_wegosix_socialblade.sql \
  "$@"
