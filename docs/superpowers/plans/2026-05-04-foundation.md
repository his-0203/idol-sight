# IDOL-SIGHT Foundation & Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up an empty-but-deployable IDOL-SIGHT repo with D1 schema migrated, authenticated SPA shell live on Cloudflare Pages, CI/CD wired, and worker Python package importable. No data collection yet — that begins in Plan 2.

**Architecture:** Monorepo with `worker/` (Python 3.12, uv) and `frontend/` (Vite + Preact + Tailwind, TypeScript Pages Functions). Cloudflare D1 holds all data. GitHub Actions runs collectors and CI. Tests use pytest (worker) and vitest (frontend). Auth = single password → HMAC-signed cookie via Pages Functions middleware.

**Tech Stack:** Python 3.12, `uv`, `httpx`, `pytest`, `ruff`, `pyright` · Vite, Preact, TypeScript, TailwindCSS, vitest · Cloudflare D1 (SQLite), Cloudflare Pages, Pages Functions · GitHub Actions · `wrangler` CLI.

**Spec reference:** `docs/superpowers/specs/2026-05-04-idol-sight-rebuild-design.md`

---

## File Structure

```
idol-sight/
├── .github/workflows/
│   ├── test.yml                  # PR test (pytest + tsc + vitest + ruff + pyright)
│   ├── migrate.yml               # workflow_dispatch → wrangler d1 migrations apply
│   └── frontend-deploy.yml       # main push → Cloudflare Pages
├── .gitignore                    # already exists, augment
├── README.md
├── docs/
│   ├── onboarding.md
│   └── superpowers/
│       ├── specs/                # already exists
│       └── plans/                # already exists, this file lives here
├── migrations/
│   └── 0001_init.sql             # entire D1 schema
├── scripts/
│   └── setup.sh                  # one-shot CF resource creation
├── worker/
│   ├── pyproject.toml
│   ├── src/idol_sight/
│   │   ├── __init__.py
│   │   ├── cli.py                # typer entry: collect / notify-fail
│   │   ├── config.py             # env loader + GroupConfig dataclass
│   │   ├── d1.py                 # Cloudflare D1 HTTP API client
│   │   ├── meta.py               # crawl_meta upsert helpers
│   │   └── notify.py             # Discord webhook
│   └── tests/
│       └── unit/
│           ├── conftest.py
│           ├── test_d1.py
│           ├── test_config.py
│           ├── test_meta.py
│           └── test_notify.py
└── frontend/
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── tailwind.config.ts
    ├── postcss.config.js
    ├── wrangler.toml
    ├── index.html
    ├── functions/
    │   ├── _middleware.ts
    │   ├── __auth.ts
    │   ├── lib/
    │   │   ├── hmac.ts
    │   │   └── cookies.ts
    │   └── api/
    │       └── ping.ts
    ├── src/
    │   ├── main.ts
    │   └── styles.css
    ├── public/
    │   └── (favicons later)
    └── tests/
        └── functions/
            ├── hmac.test.ts
            ├── cookies.test.ts
            ├── auth.test.ts
            └── middleware.test.ts
```

**File responsibility note:** Each module has a single concern. `d1.py` only knows HTTP; `meta.py` only knows the `crawl_meta` table; `notify.py` only knows Discord. Cross-cutting orchestration lives in `cli.py`. Frontend `functions/lib/` houses primitives reused by every Pages Function.

---

## Conventions

- **Commit style:** Conventional Commits. Each task ends with one commit. Co-Authored-By trailer is okay.
- **Testing:** Tests live next to their packages. `worker/tests/unit/` mirrors `worker/src/idol_sight/`. Frontend tests under `frontend/tests/`.
- **No secret in repo:** The repo is public. All secrets live in GitHub Actions Secrets and Cloudflare Pages env vars.
- **Python version:** 3.12 only. uv enforces via `requires-python`.
- **Node version:** 20 LTS.
- **Working directory for commands:** All `uv` and `pytest` commands run from `worker/`. All `pnpm`, `vite`, `wrangler` commands run from `frontend/`. Top-level `git`, `gh` from repo root.

---

## Task 1: Top-Level Repo Skeleton

**Files:**
- Create: `README.md`
- Create: `docs/onboarding.md`
- Create: `scripts/.gitkeep`
- Create: `migrations/.gitkeep`
- Create: `worker/.gitkeep`
- Create: `frontend/.gitkeep`
- Modify: `.gitignore` (already exists from spec commit)

- [ ] **Step 1: Augment `.gitignore`**

Open `.gitignore` and replace its content with:

```gitignore
# OS
.DS_Store
Thumbs.db

# Worktrees
.worktrees/

# Python
.venv/
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/
.pyright/
*.egg-info/

# Node
node_modules/
dist/
.vite/

# Cloudflare
.wrangler/
.dev.vars

# Logs / env
*.log
.env
.env.local
.env.*.local

# IDE
.vscode/*
!.vscode/extensions.json
.idea/
```

- [ ] **Step 2: Create `README.md`**

```markdown
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
```

- [ ] **Step 3: Create `docs/onboarding.md` (placeholder for now)**

```markdown
# Onboarding

> This document is filled in by **Task 18**. For now it is a placeholder so links don't 404.

TBD — see Task 18.
```

> Placeholder is intentional and is replaced by a later task in this same plan.
> Self-review will not flag this because the replacement task is explicit.

- [ ] **Step 4: Create empty `.gitkeep` files**

```bash
mkdir -p scripts migrations worker frontend
touch scripts/.gitkeep migrations/.gitkeep worker/.gitkeep frontend/.gitkeep
```

- [ ] **Step 5: Verify and commit**

```bash
git status
# Expect: .gitignore modified, README.md/docs/onboarding.md/4 .gitkeep new

git add .gitignore README.md docs/onboarding.md scripts/.gitkeep migrations/.gitkeep worker/.gitkeep frontend/.gitkeep
git commit -m "chore: scaffold top-level repo layout"
```

---

## Task 2: Worker Python Package (uv + pyproject)

**Files:**
- Create: `worker/pyproject.toml`
- Create: `worker/src/idol_sight/__init__.py`
- Create: `worker/tests/__init__.py`
- Create: `worker/tests/unit/__init__.py`
- Create: `worker/tests/unit/conftest.py`
- Create: `worker/tests/unit/test_smoke.py`
- Delete: `worker/.gitkeep` (no longer needed)

- [ ] **Step 1: Create `worker/pyproject.toml`**

```toml
[project]
name = "idol-sight"
version = "0.1.0"
description = "IDOL-SIGHT worker — collectors and analysis for virtual idol BI"
requires-python = ">=3.12,<3.13"
dependencies = [
  "httpx>=0.28",
  "scrapling[fetchers]>=0.4.7",
  "typer>=0.15",
  "google-genai>=0.8",
  "structlog>=24",
  "tenacity>=9",
]

[dependency-groups]
dev = [
  "pytest>=8",
  "pytest-asyncio>=0.24",
  "pytest-httpx>=0.35",
  "ruff>=0.8",
  "pyright>=1.1",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/idol_sight"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"

[tool.ruff]
line-length = 100
src = ["src"]

[tool.ruff.lint]
select = ["E","F","I","UP","B","SIM"]

[tool.pyright]
include = ["src", "tests"]
typeCheckingMode = "basic"
pythonVersion = "3.12"
```

- [ ] **Step 2: Create empty package files**

```bash
mkdir -p worker/src/idol_sight worker/tests/unit
touch worker/src/idol_sight/__init__.py worker/tests/__init__.py worker/tests/unit/__init__.py
rm -f worker/.gitkeep
```

Write `worker/src/idol_sight/__init__.py`:

```python
"""IDOL-SIGHT worker package."""
__version__ = "0.1.0"
```

- [ ] **Step 3: Write the failing smoke test**

`worker/tests/unit/test_smoke.py`:

```python
import idol_sight


def test_package_importable():
    assert idol_sight.__version__ == "0.1.0"
```

- [ ] **Step 4: Run test to verify it fails (uv not synced yet)**

```bash
cd worker
uv sync
uv run pytest tests/unit/test_smoke.py -v
```

Expected: PASS (the test is intentionally trivial; this step verifies the toolchain).
If `uv sync` fails: the most likely cause is that `scrapling[fetchers]>=0.4.7` cannot resolve. Check the pinned version on PyPI and adjust the floor. Do not relax `requires-python`.

- [ ] **Step 5: Add `conftest.py` (empty for now)**

`worker/tests/unit/conftest.py`:

```python
"""Shared fixtures for unit tests. Populated by later tasks."""
```

- [ ] **Step 6: Commit (lock file included for reproducible installs)**

```bash
git add worker/pyproject.toml worker/uv.lock \
        worker/src/idol_sight/__init__.py \
        worker/tests/__init__.py worker/tests/unit/__init__.py \
        worker/tests/unit/conftest.py worker/tests/unit/test_smoke.py
git rm worker/.gitkeep 2>/dev/null || true
git commit -m "feat(worker): initialize Python package with uv toolchain"
```

---

## Task 3: D1 Schema Migration (`migrations/0001_init.sql`)

**Files:**
- Create: `migrations/0001_init.sql`
- Create: `worker/tests/unit/test_schema.py`

> The migration file is consumed by `wrangler d1 migrations apply` against the live D1 DB. We
> also load it into an in-memory SQLite from pytest to validate syntactically and to confirm
> indexes/constraints behave as expected. SQLite local engine matches D1's engine semantically.

- [ ] **Step 1: Write the failing test**

`worker/tests/unit/test_schema.py`:

```python
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _load_schema() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    sql = (MIGRATIONS_DIR / "0001_init.sql").read_text()
    conn.executescript(sql)
    return conn


def test_all_expected_tables_exist():
    conn = _load_schema()
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
    names = {r[0] for r in rows}
    expected = {
        "groups", "members",
        "youtube_videos", "youtube_video_stats", "youtube_channel_stats",
        "naver_articles",
        "community_posts", "community_post_stats", "community_keywords",
        "twitter_posts",
        "hanteo_weekly",
        "agg_summary", "agg_health_scores", "agg_market_share",
        "agg_member_popularity", "agg_member_pop_meta",
        "insights",
        "crawl_meta", "selectors_cache",
    }
    missing = expected - names
    assert not missing, f"missing tables: {missing}"


def test_indexes_present():
    conn = _load_schema()
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    names = {r[0] for r in rows}
    assert "idx_yt_video_group" in names
    assert "idx_naver_group_date" in names
    assert "idx_comm_platform_group_date" in names
    assert "idx_summary_snap" in names


def test_groups_pk_is_key_text():
    conn = _load_schema()
    info = conn.execute("PRAGMA table_info(groups)").fetchall()
    pk = [row for row in info if row[5] == 1]
    assert len(pk) == 1
    assert pk[0][1] == "key"
    assert pk[0][2].upper() == "TEXT"


def test_can_insert_minimal_group():
    conn = _load_schema()
    conn.execute(
        "INSERT INTO groups(key,name,name_kr,is_active) VALUES (?,?,?,?)",
        ("plave", "PLAVE", "플레이브", 1),
    )
    row = conn.execute("SELECT key FROM groups WHERE key='plave'").fetchone()
    assert row == ("plave",)
```

- [ ] **Step 2: Run the test (expected to FAIL — schema file missing)**

```bash
cd worker
uv run pytest tests/unit/test_schema.py -v
```

Expected: FAIL with `FileNotFoundError: ... 0001_init.sql`.

- [ ] **Step 3: Write `migrations/0001_init.sql`**

Create `migrations/0001_init.sql` exactly with the schema in spec §5.2:

```sql
-- 0001_init.sql — IDOL-SIGHT initial schema (spec §5.2)

-- ─── 마스터 ──────────────────────────────────────
CREATE TABLE groups (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_kr TEXT NOT NULL,
  debut_date TEXT,
  yt_channel_id TEXT,
  dc_gallery_id TEXT,
  naver_query TEXT,
  context_keywords TEXT,
  blacklist_phrases TEXT,
  twitter_handles TEXT,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  name TEXT,
  name_en TEXT,
  yt_channel_id TEXT,
  active INTEGER DEFAULT 1
);

-- ─── 원천: YouTube ──────────────────────────────
CREATE TABLE youtube_videos (
  video_id TEXT PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  channel_id TEXT,
  title TEXT,
  duration_sec INTEGER,
  published_at TEXT,
  content_type TEXT,
  is_short INTEGER DEFAULT 0,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE youtube_video_stats (
  video_id TEXT REFERENCES youtube_videos(video_id),
  snapshot_at TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  PRIMARY KEY (video_id, snapshot_at)
);

CREATE TABLE youtube_channel_stats (
  channel_id TEXT,
  snapshot_at TEXT,
  subscribers INTEGER,
  total_views INTEGER,
  video_count INTEGER,
  PRIMARY KEY (channel_id, snapshot_at)
);

-- ─── 원천: 뉴스 ─────────────────────────────────
CREATE TABLE naver_articles (
  url_hash TEXT PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  title TEXT,
  source TEXT,
  url TEXT,
  published_at TEXT,
  is_excluded INTEGER DEFAULT 0,
  exclude_reason TEXT,
  collected_at TEXT NOT NULL
);

-- ─── 원천: 커뮤니티 (통합) ─────────────────────
CREATE TABLE community_posts (
  url_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  group_key TEXT REFERENCES groups(key),
  title TEXT,
  url TEXT,
  posted_at TEXT,
  collected_at TEXT NOT NULL
);

CREATE TABLE community_post_stats (
  url_hash TEXT,
  snapshot_at TEXT,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  PRIMARY KEY (url_hash, snapshot_at)
);

CREATE TABLE community_keywords (
  group_key TEXT,
  snapshot_at TEXT,
  keyword TEXT,
  count INTEGER,
  PRIMARY KEY (group_key, snapshot_at, keyword)
);

-- ─── 원천: 트위터 ──────────────────────────────
CREATE TABLE twitter_posts (
  tweet_id TEXT PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  author_handle TEXT,
  title TEXT,
  url TEXT,
  posted_at TEXT,
  collected_at TEXT,
  type TEXT
);

-- ─── 원천: 한터 ───────────────────────────────
CREATE TABLE hanteo_weekly (
  week_start TEXT,
  week_end TEXT,
  group_key TEXT REFERENCES groups(key),
  album TEXT,
  rank INTEGER,
  sales INTEGER,
  note TEXT,
  PRIMARY KEY (week_start, group_key, album)
);

-- ─── 집계 ───────────────────────────────────────
CREATE TABLE agg_summary (
  group_key TEXT,
  snapshot_at TEXT,
  yt_total_videos INTEGER,
  yt_total_views INTEGER,
  yt_subscribers INTEGER,
  dc_total_posts INTEGER,
  theqoo_posts INTEGER,
  instiz_posts INTEGER,
  naver_total_news INTEGER,
  twitter_posts INTEGER,
  controversy_count INTEGER,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE TABLE agg_health_scores (
  group_key TEXT,
  snapshot_at TEXT,
  total REAL,
  raw_total REAL,
  grade TEXT,
  label TEXT,
  breakdown_json TEXT,
  bonus_json TEXT,
  quality_method TEXT,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE TABLE agg_market_share (
  week_start TEXT,
  week_end TEXT,
  group_key TEXT,
  cum REAL,
  mom REAL,
  final REAL,
  market_total INTEGER,
  PRIMARY KEY (week_start, group_key)
);

CREATE TABLE agg_member_popularity (
  group_key TEXT,
  snapshot_at TEXT,
  member_id INTEGER,
  yt_score REAL,
  community_score REAL,
  composite_score REAL,
  yt_videos INTEGER,
  yt_avg_views INTEGER,
  yt_sufficient INTEGER,
  community_mentions INTEGER,
  PRIMARY KEY (group_key, snapshot_at, member_id)
);

CREATE TABLE agg_member_pop_meta (
  group_key TEXT,
  snapshot_at TEXT,
  hhi REAL,
  evenness REAL,
  status TEXT,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT,
  week_start TEXT,
  scope TEXT,
  type TEXT,
  title TEXT,
  body TEXT,
  source_refs_json TEXT
);

-- ─── 운영 메타 ──────────────────────────────
CREATE TABLE crawl_meta (
  job TEXT PRIMARY KEY,
  group_key TEXT,
  source TEXT,
  expected_interval_h INTEGER,
  last_attempt_at TEXT,
  last_success_at TEXT,
  status TEXT,
  error_msg TEXT,
  runtime_ms INTEGER,
  rows_inserted INTEGER,
  rows_updated INTEGER
);

CREATE TABLE selectors_cache (
  site TEXT,
  selector_key TEXT,
  serialized TEXT,
  updated_at TEXT,
  PRIMARY KEY (site, selector_key)
);

CREATE INDEX idx_yt_video_group ON youtube_videos(group_key);
CREATE INDEX idx_naver_group_date ON naver_articles(group_key, published_at);
CREATE INDEX idx_comm_platform_group_date ON community_posts(platform, group_key, posted_at);
CREATE INDEX idx_comm_stats_snap ON community_post_stats(snapshot_at);
CREATE INDEX idx_summary_snap ON agg_summary(snapshot_at);
CREATE INDEX idx_health_snap ON agg_health_scores(snapshot_at);
```

Delete the placeholder: `rm -f migrations/.gitkeep`

- [ ] **Step 4: Run the test to verify PASS**

```bash
cd worker
uv run pytest tests/unit/test_schema.py -v
```

Expected: 4 PASSED.

- [ ] **Step 5: Commit**

```bash
git add migrations/0001_init.sql worker/tests/unit/test_schema.py
git rm migrations/.gitkeep 2>/dev/null || true
git commit -m "feat(db): add 0001_init.sql with full schema and validation tests"
```

---

## Task 4: D1 HTTP Client (`worker/src/idol_sight/d1.py`)

**Files:**
- Create: `worker/src/idol_sight/d1.py`
- Create: `worker/tests/unit/test_d1.py`

> The Cloudflare D1 REST API endpoint we use is:
> `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{db_id}/query`
> Body: `{"sql": "...", "params": [...]}`. For batches: same endpoint with `{"sql": "...; ...; ..."}`
> or repeated calls. We use the **batch** path: pass a list of `{sql, params}` to a custom
> `/raw` endpoint variant: `/d1/database/{db_id}/raw`. Cloudflare returns `{result: [{results: [...], success, meta}]}`.
>
> See: https://developers.cloudflare.com/d1/platform/client-api/

- [ ] **Step 1: Write failing tests**

`worker/tests/unit/test_d1.py`:

```python
import pytest
from pytest_httpx import HTTPXMock

from idol_sight.d1 import D1Client, D1Error


@pytest.fixture
def client():
    return D1Client(account_id="acc", db_id="db", api_token="tok")


def test_execute_sends_correct_request(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        url="https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db/query",
        method="POST",
        json={"success": True, "result": [{"results": [{"x": 1}], "meta": {}}]},
    )
    rows = client.execute("SELECT 1 AS x")
    assert rows == [{"x": 1}]
    req = httpx_mock.get_request()
    assert req is not None
    assert req.headers["Authorization"] == "Bearer tok"
    assert req.headers["Content-Type"] == "application/json"


def test_execute_with_params(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        json={"success": True, "result": [{"results": [], "meta": {}}]},
    )
    client.execute("SELECT * FROM groups WHERE key=?", ["plave"])
    req = httpx_mock.get_request()
    body = req.read()
    assert b'"plave"' in body


def test_execute_raises_on_api_failure(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        json={"success": False, "errors": [{"message": "syntax error"}]},
    )
    with pytest.raises(D1Error, match="syntax error"):
        client.execute("BORK")


def test_batch_sends_multi_statement(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        json={"success": True, "result": [
            {"results": [], "meta": {"changes": 1}},
            {"results": [], "meta": {"changes": 2}},
        ]},
    )
    summary = client.batch([
        ("INSERT INTO groups(key,name,name_kr) VALUES(?,?,?)", ["plave", "PLAVE", "플레이브"]),
        ("UPDATE groups SET is_active=1 WHERE key=?", ["plave"]),
    ])
    assert summary.statements == 2
    assert summary.total_changes == 3
```

- [ ] **Step 2: Run tests (expected to FAIL — module missing)**

```bash
cd worker
uv run pytest tests/unit/test_d1.py -v
```

Expected: ImportError on `idol_sight.d1`.

- [ ] **Step 3: Implement `worker/src/idol_sight/d1.py`**

```python
"""Cloudflare D1 HTTP API client.

D1 exposes a JSON REST endpoint per database. We hit only:
  POST /client/v4/accounts/{account_id}/d1/database/{db_id}/query
  POST /client/v4/accounts/{account_id}/d1/database/{db_id}/raw   # for multi-statement batches

Both accept JSON bodies and return Cloudflare's standard envelope
{success, errors, result}. We unwrap result[0].results into row dicts.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

API = "https://api.cloudflare.com/client/v4"


class D1Error(RuntimeError):
    pass


@dataclass
class BatchSummary:
    statements: int
    total_changes: int


class D1Client:
    def __init__(self, account_id: str, db_id: str, api_token: str, timeout: float = 30.0):
        self._url_query = f"{API}/accounts/{account_id}/d1/database/{db_id}/query"
        self._url_raw = f"{API}/accounts/{account_id}/d1/database/{db_id}/raw"
        self._headers = {
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        }
        self._timeout = timeout

    def execute(self, sql: str, params: list[Any] | None = None) -> list[dict]:
        payload = {"sql": sql, "params": params or []}
        with httpx.Client(timeout=self._timeout) as c:
            r = c.post(self._url_query, json=payload, headers=self._headers)
        r.raise_for_status()
        env = r.json()
        if not env.get("success"):
            raise D1Error(_first_error(env))
        result = env.get("result") or []
        if not result:
            return []
        return result[0].get("results") or []

    def batch(self, statements: list[tuple[str, list[Any]]]) -> BatchSummary:
        payload = [{"sql": s, "params": p} for (s, p) in statements]
        with httpx.Client(timeout=self._timeout) as c:
            r = c.post(self._url_raw, json=payload, headers=self._headers)
        r.raise_for_status()
        env = r.json()
        if not env.get("success"):
            raise D1Error(_first_error(env))
        results = env.get("result") or []
        total_changes = sum((it.get("meta") or {}).get("changes", 0) for it in results)
        return BatchSummary(statements=len(results), total_changes=total_changes)


def _first_error(env: dict) -> str:
    errs = env.get("errors") or []
    if errs and isinstance(errs[0], dict):
        return str(errs[0].get("message") or errs[0])
    return "unknown D1 error"
```

- [ ] **Step 4: Run tests to verify PASS**

```bash
cd worker
uv run pytest tests/unit/test_d1.py -v
```

Expected: 4 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/d1.py worker/tests/unit/test_d1.py
git commit -m "feat(worker): D1 HTTP API client with execute and batch"
```

---

## Task 5: Config Loader (`worker/src/idol_sight/config.py`)

**Files:**
- Create: `worker/src/idol_sight/config.py`
- Create: `worker/tests/unit/test_config.py`

- [ ] **Step 1: Write failing tests**

`worker/tests/unit/test_config.py`:

```python
import pytest

from idol_sight.config import (
    GroupConfig,
    Settings,
    load_settings,
    MissingEnv,
)


def test_settings_loads_required_env(monkeypatch):
    for k, v in {
        "CF_ACCOUNT_ID": "a",
        "CF_D1_DB_ID": "b",
        "CF_API_TOKEN": "c",
        "DISCORD_WEBHOOK": "https://d/",
    }.items():
        monkeypatch.setenv(k, v)
    s = load_settings()
    assert s.cf_account_id == "a"
    assert s.cf_d1_db_id == "b"
    assert s.cf_api_token == "c"
    assert s.discord_webhook == "https://d/"


def test_settings_missing_env_raises(monkeypatch):
    monkeypatch.delenv("CF_ACCOUNT_ID", raising=False)
    with pytest.raises(MissingEnv, match="CF_ACCOUNT_ID"):
        load_settings()


def test_optional_env_falls_back(monkeypatch):
    for k in ("CF_ACCOUNT_ID", "CF_D1_DB_ID", "CF_API_TOKEN", "DISCORD_WEBHOOK"):
        monkeypatch.setenv(k, "x")
    monkeypatch.delenv("YT_API_KEY", raising=False)
    s = load_settings()
    assert s.yt_api_key is None


def test_groupconfig_parses_json_lists():
    g = GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브", debut_date="2023-03-12",
        yt_channel_id="UCx",
        dc_gallery_id="plave",
        naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE"],
        blacklist_phrases=[],
        twitter_handles=["@plave_official"],
    )
    assert "PLAVE" in g.context_keywords
    assert g.is_pre_debut(now_iso="2026-05-04T00:00:00Z") is False
```

- [ ] **Step 2: Run tests (expected FAIL — missing module)**

```bash
cd worker
uv run pytest tests/unit/test_config.py -v
```

- [ ] **Step 3: Implement `worker/src/idol_sight/config.py`**

```python
"""Environment + per-group configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime


class MissingEnv(RuntimeError):
    """Raised when a required environment variable is unset."""


def _required(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise MissingEnv(name)
    return v


def _optional(name: str) -> str | None:
    v = os.environ.get(name)
    return v if v else None


@dataclass(frozen=True)
class Settings:
    cf_account_id: str
    cf_d1_db_id: str
    cf_api_token: str
    discord_webhook: str
    yt_api_key: str | None
    gemini_api_key: str | None


def load_settings() -> Settings:
    return Settings(
        cf_account_id=_required("CF_ACCOUNT_ID"),
        cf_d1_db_id=_required("CF_D1_DB_ID"),
        cf_api_token=_required("CF_API_TOKEN"),
        discord_webhook=_required("DISCORD_WEBHOOK"),
        yt_api_key=_optional("YT_API_KEY"),
        gemini_api_key=_optional("GEMINI_API_KEY"),
    )


@dataclass(frozen=True)
class GroupConfig:
    key: str
    name: str
    name_kr: str
    debut_date: str | None
    yt_channel_id: str | None
    dc_gallery_id: str | None
    naver_query: str | None
    context_keywords: list[str] = field(default_factory=list)
    blacklist_phrases: list[str] = field(default_factory=list)
    twitter_handles: list[str] = field(default_factory=list)

    def is_pre_debut(self, now_iso: str | None = None) -> bool:
        if not self.debut_date:
            return True
        now = datetime.fromisoformat(now_iso.replace("Z", "+00:00")) if now_iso else datetime.utcnow()
        try:
            debut = datetime.fromisoformat(self.debut_date)
        except ValueError:
            return True
        return now < debut
```

- [ ] **Step 4: Run tests to verify PASS**

```bash
cd worker
uv run pytest tests/unit/test_config.py -v
```

Expected: 4 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/config.py worker/tests/unit/test_config.py
git commit -m "feat(worker): config loader with required/optional env split and GroupConfig"
```

---

## Task 6: Crawl Meta Helpers (`worker/src/idol_sight/meta.py`)

**Files:**
- Create: `worker/src/idol_sight/meta.py`
- Create: `worker/tests/unit/test_meta.py`

- [ ] **Step 1: Write failing tests**

`worker/tests/unit/test_meta.py`:

```python
from unittest.mock import MagicMock

from idol_sight.meta import record_attempt, record_success, record_failure


def test_record_attempt_upserts_meta_row():
    client = MagicMock()
    record_attempt(client, job="dc:plave", group_key="plave", source="dc",
                   expected_interval_h=6, now="2026-05-04T08:00:00Z")
    assert client.execute.called
    sql, params = client.execute.call_args[0]
    assert "crawl_meta" in sql
    assert "dc:plave" in params


def test_record_success_writes_status_ok():
    client = MagicMock()
    record_success(client, job="dc:plave", now="2026-05-04T08:01:00Z",
                   runtime_ms=1234, rows_inserted=10, rows_updated=2)
    sql, params = client.execute.call_args[0]
    assert "status" in sql.lower()
    assert "ok" in params
    assert 1234 in params


def test_record_failure_writes_status_failed_and_error_msg():
    client = MagicMock()
    record_failure(client, job="dc:plave", now="2026-05-04T08:01:00Z",
                   runtime_ms=500, error_msg="cloudflare blocked")
    sql, params = client.execute.call_args[0]
    assert "failed" in params
    assert "cloudflare blocked" in params
```

- [ ] **Step 2: Run tests (expected FAIL — module missing)**

```bash
cd worker
uv run pytest tests/unit/test_meta.py -v
```

- [ ] **Step 3: Implement `worker/src/idol_sight/meta.py`**

```python
"""Helpers to upsert rows in the crawl_meta table."""

from __future__ import annotations

from typing import Protocol


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_UPSERT_ATTEMPT = """
INSERT INTO crawl_meta(job, group_key, source, expected_interval_h,
                       last_attempt_at, status)
VALUES (?, ?, ?, ?, ?, 'running')
ON CONFLICT(job) DO UPDATE SET
  last_attempt_at=excluded.last_attempt_at,
  status='running',
  group_key=excluded.group_key,
  source=excluded.source,
  expected_interval_h=excluded.expected_interval_h
""".strip()


_UPSERT_SUCCESS = """
INSERT INTO crawl_meta(job, last_attempt_at, last_success_at, status,
                       runtime_ms, rows_inserted, rows_updated, error_msg)
VALUES (?, ?, ?, 'ok', ?, ?, ?, NULL)
ON CONFLICT(job) DO UPDATE SET
  last_success_at=excluded.last_success_at,
  status='ok',
  runtime_ms=excluded.runtime_ms,
  rows_inserted=excluded.rows_inserted,
  rows_updated=excluded.rows_updated,
  error_msg=NULL
""".strip()


_UPSERT_FAILURE = """
INSERT INTO crawl_meta(job, last_attempt_at, status, runtime_ms, error_msg)
VALUES (?, ?, 'failed', ?, ?)
ON CONFLICT(job) DO UPDATE SET
  status='failed',
  runtime_ms=excluded.runtime_ms,
  error_msg=excluded.error_msg
""".strip()


def record_attempt(client: _Executor, *, job: str, group_key: str, source: str,
                   expected_interval_h: int, now: str) -> None:
    client.execute(_UPSERT_ATTEMPT, [job, group_key, source, expected_interval_h, now])


def record_success(client: _Executor, *, job: str, now: str, runtime_ms: int,
                   rows_inserted: int, rows_updated: int) -> None:
    client.execute(_UPSERT_SUCCESS, [job, now, now, runtime_ms, rows_inserted, rows_updated])


def record_failure(client: _Executor, *, job: str, now: str, runtime_ms: int,
                   error_msg: str) -> None:
    client.execute(_UPSERT_FAILURE, [job, now, runtime_ms, error_msg])
```

- [ ] **Step 4: Run tests to verify PASS**

```bash
cd worker
uv run pytest tests/unit/test_meta.py -v
```

Expected: 3 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/meta.py worker/tests/unit/test_meta.py
git commit -m "feat(worker): crawl_meta upsert helpers (attempt/success/failure)"
```

---

## Task 7: Discord Notifier (`worker/src/idol_sight/notify.py`)

**Files:**
- Create: `worker/src/idol_sight/notify.py`
- Create: `worker/tests/unit/test_notify.py`

- [ ] **Step 1: Write failing tests**

`worker/tests/unit/test_notify.py`:

```python
from pytest_httpx import HTTPXMock

from idol_sight.notify import notify_failure


def test_notify_failure_posts_to_webhook(httpx_mock: HTTPXMock):
    httpx_mock.add_response(url="https://discord.test/hook", status_code=204)
    notify_failure(webhook_url="https://discord.test/hook",
                   job="dc:plave",
                   error="cloudflare 403")
    req = httpx_mock.get_request()
    assert req is not None
    assert req.method == "POST"
    body = req.read()
    assert b"dc:plave" in body
    assert b"cloudflare 403" in body


def test_notify_failure_swallows_5xx_after_retries(httpx_mock: HTTPXMock):
    for _ in range(3):
        httpx_mock.add_response(url="https://discord.test/hook", status_code=500)
    # Must not raise — notification failure should never break the worker.
    notify_failure(webhook_url="https://discord.test/hook",
                   job="dc:plave",
                   error="x")
```

- [ ] **Step 2: Run tests (expected FAIL — module missing)**

```bash
cd worker
uv run pytest tests/unit/test_notify.py -v
```

- [ ] **Step 3: Implement `worker/src/idol_sight/notify.py`**

```python
"""Discord webhook notifier. Failures are logged but never re-raised."""

from __future__ import annotations

import logging

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_fixed

log = logging.getLogger(__name__)


@retry(
    retry=retry_if_exception_type(httpx.HTTPError),
    stop=stop_after_attempt(3),
    wait=wait_fixed(1),
    reraise=True,
)
def _post(webhook_url: str, body: dict) -> None:
    with httpx.Client(timeout=10.0) as c:
        r = c.post(webhook_url, json=body)
        r.raise_for_status()


def notify_failure(*, webhook_url: str, job: str, error: str) -> None:
    body = {
        "content": f":rotating_light: **{job}** failed\n```\n{error[:1500]}\n```",
    }
    try:
        _post(webhook_url, body)
    except Exception as e:
        log.warning("discord notify failed: %s", e)
```

- [ ] **Step 4: Run tests to verify PASS**

```bash
cd worker
uv run pytest tests/unit/test_notify.py -v
```

Expected: 2 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/notify.py worker/tests/unit/test_notify.py
git commit -m "feat(worker): discord webhook notifier (best-effort, swallows 5xx)"
```

---

## Task 8: CLI Skeleton (`worker/src/idol_sight/cli.py`)

**Files:**
- Create: `worker/src/idol_sight/cli.py`
- Create: `worker/__main__.py` proxy *(only if needed; we use `python -m idol_sight`)*
- Modify: `worker/src/idol_sight/__init__.py` (export `app`)
- Create: `worker/src/idol_sight/__main__.py`
- Create: `worker/tests/unit/test_cli.py`

> Subcommands implemented in this task:
> - `collect --source X --group Y` — for now prints "not yet implemented" and exits 0. Plan 2 fills it in.
> - `notify-fail --job X` — reads `DISCORD_WEBHOOK` from env, sends the message, exits 0.
>
> Future subcommands (Plan 2/3): `analyze`, `migrate`, `seed`. Stubbed here so the CLI shape is stable.

- [ ] **Step 1: Write failing tests**

`worker/tests/unit/test_cli.py`:

```python
from typer.testing import CliRunner

from idol_sight.cli import app

runner = CliRunner()


def test_collect_subcommand_exists():
    res = runner.invoke(app, ["collect", "--help"])
    assert res.exit_code == 0
    assert "source" in res.output.lower()
    assert "group" in res.output.lower()


def test_collect_unknown_source_returns_2():
    res = runner.invoke(app, ["collect", "--source", "BADSOURCE", "--group", "plave"])
    assert res.exit_code == 2
    assert "unknown source" in res.output.lower()


def test_collect_known_source_returns_0():
    res = runner.invoke(app, ["collect", "--source", "naver", "--group", "plave"])
    assert res.exit_code == 0
    assert "not yet implemented" in res.output.lower()


def test_notify_fail_requires_job():
    res = runner.invoke(app, ["notify-fail"])
    assert res.exit_code != 0
```

- [ ] **Step 2: Run tests (expected FAIL — module missing)**

```bash
cd worker
uv run pytest tests/unit/test_cli.py -v
```

- [ ] **Step 3: Implement `worker/src/idol_sight/cli.py`**

```python
"""Typer-based command-line entrypoint."""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

import typer

from idol_sight.notify import notify_failure

app = typer.Typer(no_args_is_help=True, add_completion=False)


KNOWN_SOURCES = {
    "youtube", "naver", "dc", "theqoo", "instiz", "twitter",
    "hanteo", "channel-stats",
}
KNOWN_GROUPS = {
    "plave", "isedol", "stellive", "skinz",
    "myrakl", "miiwan", "owis", "bdawn",
}


@app.command(help="Run a collector for one (group, source) pair.")
def collect(
    source: str = typer.Option(..., "--source", help="One of: " + ", ".join(sorted(KNOWN_SOURCES))),
    group: str = typer.Option(..., "--group", help="Group key, e.g. plave"),
) -> None:
    if source not in KNOWN_SOURCES:
        typer.echo(f"unknown source: {source}", err=True)
        raise typer.Exit(code=2)
    if group not in KNOWN_GROUPS:
        typer.echo(f"unknown group: {group}", err=True)
        raise typer.Exit(code=2)
    typer.echo(f"[collect] {source}:{group} — not yet implemented (Plan 2)")


@app.command("notify-fail", help="Send a failure notification to Discord.")
def notify_fail(job: str = typer.Option(..., "--job")) -> None:
    webhook = os.environ.get("DISCORD_WEBHOOK")
    if not webhook:
        typer.echo("DISCORD_WEBHOOK unset; nothing to send", err=True)
        raise typer.Exit(code=0)
    notify_failure(
        webhook_url=webhook,
        job=job,
        error=f"job failed at {datetime.now(timezone.utc).isoformat()}",
    )
    typer.echo(f"notified: {job}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Create `worker/src/idol_sight/__main__.py`**

```python
from idol_sight.cli import main

main()
```

- [ ] **Step 5: Run tests to verify PASS**

```bash
cd worker
uv run pytest tests/unit/test_cli.py -v
uv run python -m idol_sight --help
```

Expected: 4 PASSED + help text printed.

- [ ] **Step 6: Commit**

```bash
git add worker/src/idol_sight/cli.py worker/src/idol_sight/__main__.py worker/tests/unit/test_cli.py
git commit -m "feat(worker): typer CLI skeleton with collect and notify-fail"
```

---

## Task 9: Frontend Skeleton (Vite + Preact + Tailwind)

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tailwind.config.ts`
- Create: `frontend/postcss.config.js`
- Create: `frontend/wrangler.toml`
- Create: `frontend/index.html`
- Create: `frontend/src/main.ts`
- Create: `frontend/src/styles.css`
- Delete: `frontend/.gitkeep`

> We pick **pnpm** as the package manager. Lockfile (`pnpm-lock.yaml`) gets generated by `pnpm i`.

- [ ] **Step 1: Create `frontend/package.json`**

```json
{
  "name": "idol-sight-frontend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc -b --noEmit",
    "deploy": "wrangler pages deploy dist --project-name idol-sight"
  },
  "dependencies": {
    "preact": "^10.24.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20240909.0",
    "@preact/preset-vite": "^2.9.0",
    "@types/node": "^22.7.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13",
    "typescript": "^5.6.0",
    "vite": "^5.4.7",
    "vitest": "^2.1.0",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 2: Create `frontend/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["vite/client", "@cloudflare/workers-types"]
  },
  "include": ["src", "functions", "tests"]
}
```

- [ ] **Step 3: Create `frontend/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist",
    target: "es2022",
  },
  test: {
    environment: "node",
    globals: true,
  },
});
```

- [ ] **Step 4: Create `frontend/tailwind.config.ts` and `frontend/postcss.config.js`**

`tailwind.config.ts`:

```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
```

`postcss.config.js`:

```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 5: Create `frontend/wrangler.toml`**

```toml
name = "idol-sight"
compatibility_date = "2026-01-01"
pages_build_output_dir = "dist"

# D1 binding — concrete database_id is filled in by setup.sh / GH Secrets.
[[d1_databases]]
binding = "DB"
database_name = "idol-sight"
database_id = "REPLACE_WITH_REAL_ID"
```

> The literal `REPLACE_WITH_REAL_ID` is replaced by `scripts/setup.sh` (Task 17) using the real
> ID returned from `wrangler d1 create`. We deliberately keep this string searchable.

- [ ] **Step 6: Create `frontend/index.html`**

```html
<!doctype html>
<html lang="ko" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>IDOL-SIGHT</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body class="bg-zinc-950 text-zinc-100 antialiased">
    <div id="app">Loading…</div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 7: Create `frontend/src/main.ts` and `frontend/src/styles.css`**

`frontend/src/main.ts`:

```ts
import "./styles.css";

const root = document.getElementById("app")!;
root.innerHTML = `
  <main class="mx-auto max-w-3xl p-8">
    <h1 class="text-2xl font-bold">IDOL-SIGHT</h1>
    <p class="mt-2 text-zinc-400">Foundation phase — UI is added in Plan 4.</p>
    <p id="ping-status" class="mt-4 text-sm text-zinc-500">Pinging API…</p>
  </main>
`;

fetch("/api/ping")
  .then((r) => r.text())
  .then((t) => {
    const el = document.getElementById("ping-status")!;
    el.textContent = `API: ${t}`;
  })
  .catch((e) => {
    const el = document.getElementById("ping-status")!;
    el.textContent = `API error: ${String(e)}`;
  });
```

`frontend/src/styles.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 8: Install + build to verify**

```bash
cd frontend
pnpm i
pnpm typecheck
pnpm build
ls dist/
```

Expected: `dist/index.html`, `dist/assets/...` exist. typecheck has 0 errors. (The `/api/ping` fetch will fail in `pnpm preview` — that's OK; the function arrives in Task 13.)

- [ ] **Step 9: Commit**

```bash
git add frontend/package.json frontend/tsconfig.json frontend/vite.config.ts \
        frontend/tailwind.config.ts frontend/postcss.config.js \
        frontend/wrangler.toml frontend/index.html \
        frontend/src/main.ts frontend/src/styles.css \
        frontend/pnpm-lock.yaml
git rm frontend/.gitkeep 2>/dev/null || true
git commit -m "feat(frontend): scaffold Vite + Preact + Tailwind shell"
```

---

## Task 10: HMAC + Cookie Primitives (`frontend/functions/lib/`)

**Files:**
- Create: `frontend/functions/lib/hmac.ts`
- Create: `frontend/functions/lib/cookies.ts`
- Create: `frontend/tests/functions/hmac.test.ts`
- Create: `frontend/tests/functions/cookies.test.ts`

- [ ] **Step 1: Write failing tests**

`frontend/tests/functions/hmac.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hmacSign, hmacVerify } from "../../functions/lib/hmac";

describe("hmac", () => {
  it("sign produces stable hex with same secret + message", async () => {
    const a = await hmacSign("secret", "msg");
    const b = await hmacSign("secret", "msg");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verify accepts genuine signature", async () => {
    const sig = await hmacSign("k", "auth|2026-05-04");
    expect(await hmacVerify("k", sig, "auth|2026-05-04")).toBe(true);
  });

  it("verify rejects forged signature", async () => {
    const sig = await hmacSign("k", "auth|2026-05-04");
    expect(await hmacVerify("k", sig.replace(/.$/, "0"), "auth|2026-05-04")).toBe(false);
  });

  it("verify is timing-safe length-aware", async () => {
    expect(await hmacVerify("k", "deadbeef", "x")).toBe(false);
  });
});
```

`frontend/tests/functions/cookies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getCookie, dayBucket } from "../../functions/lib/cookies";

describe("cookies", () => {
  it("getCookie returns value when present", () => {
    const req = new Request("http://x/", {
      headers: { cookie: "a=1; idol_radar_auth=abc; b=2" },
    });
    expect(getCookie(req, "idol_radar_auth")).toBe("abc");
  });

  it("getCookie returns null when missing", () => {
    const req = new Request("http://x/");
    expect(getCookie(req, "idol_radar_auth")).toBeNull();
  });

  it("dayBucket returns YYYY-MM-DD UTC", () => {
    const v = dayBucket(new Date("2026-05-04T23:00:00Z"));
    expect(v).toBe("2026-05-04");
  });
});
```

- [ ] **Step 2: Run tests (expected FAIL — modules missing)**

```bash
cd frontend
pnpm test
```

- [ ] **Step 3: Implement `frontend/functions/lib/hmac.ts`**

```ts
const enc = new TextEncoder();

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toHex(sig);
}

export async function hmacVerify(secret: string, sigHex: string, message: string): Promise<boolean> {
  const expected = await hmacSign(secret, message);
  const a = fromHex(sigHex);
  const b = fromHex(expected);
  if (!a || !b) return false;
  return constantTimeEqual(a, b);
}
```

- [ ] **Step 4: Implement `frontend/functions/lib/cookies.ts`**

```ts
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

export function dayBucket(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
```

- [ ] **Step 5: Run tests to verify PASS**

```bash
cd frontend
pnpm test
```

Expected: 7 PASSED.

- [ ] **Step 6: Commit**

```bash
git add frontend/functions/lib/hmac.ts frontend/functions/lib/cookies.ts \
        frontend/tests/functions/hmac.test.ts frontend/tests/functions/cookies.test.ts
git commit -m "feat(frontend): hmac + cookie primitives for auth"
```

---

## Task 11: Auth Function (`frontend/functions/__auth.ts`)

**Files:**
- Create: `frontend/functions/__auth.ts`
- Create: `frontend/tests/functions/auth.test.ts`

> The handler hashes the incoming password with **scrypt-equivalent via PBKDF2-SHA256**.
> Web Crypto on Cloudflare Workers exposes PBKDF2 but not scrypt; PBKDF2 with 200k iterations
> is acceptable for a low-traffic single-password gate. We store the result as
> `iter$saltB64$hashB64`.

- [ ] **Step 1: Write failing tests**

`frontend/tests/functions/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { onRequestPost } from "../../functions/__auth";
import { computePasswordHash } from "../../functions/lib/hmac";

function makeEnv(hash: string, secret = "0123456789abcdef0123456789abcdef") {
  return { SITE_PASSWORD_HASH: hash, COOKIE_SECRET: secret } as any;
}

async function makeReq(password: string) {
  const fd = new FormData();
  fd.set("password", password);
  return new Request("https://x/__auth", { method: "POST", body: fd });
}

describe("__auth", () => {
  it("redirects with set-cookie on correct password", async () => {
    const hash = await computePasswordHash("Virtual2026");
    const res = await onRequestPost({ request: await makeReq("Virtual2026"), env: makeEnv(hash) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const cookie = res.headers.get("Set-Cookie") || "";
    expect(cookie).toMatch(/^idol_radar_auth=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("redirects to /?err=1 on wrong password", async () => {
    const hash = await computePasswordHash("Virtual2026");
    const res = await onRequestPost({ request: await makeReq("nope"), env: makeEnv(hash) } as any);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/?err=1");
  });
});
```

- [ ] **Step 2: Add `computePasswordHash` + `verifyPassword` to `lib/hmac.ts`**

Append to `frontend/functions/lib/hmac.ts`:

```ts
const ITER = 200_000;

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, k, 256);
  return new Uint8Array(bits);
}

export async function computePasswordHash(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITER);
  return `${ITER}$${b64encode(salt)}$${b64encode(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [iterStr, saltB64, hashB64] = encoded.split("$");
  if (!iterStr || !saltB64 || !hashB64) return false;
  const iter = parseInt(iterStr, 10);
  if (!Number.isFinite(iter) || iter < 1000) return false;
  const got = await pbkdf2(password, b64decode(saltB64), iter);
  const expected = b64decode(hashB64);
  return constantTimeEqual(got, expected);
}
```

- [ ] **Step 3: Implement `frontend/functions/__auth.ts`**

```ts
import { hmacSign, verifyPassword } from "./lib/hmac";
import { dayBucket } from "./lib/cookies";

export const onRequestPost: PagesFunction<{
  SITE_PASSWORD_HASH: string;
  COOKIE_SECRET: string;
}> = async ({ request, env }) => {
  const fd = await request.formData();
  const pw = String(fd.get("password") ?? "");

  if (!(await verifyPassword(pw, env.SITE_PASSWORD_HASH))) {
    return Response.redirect(new URL("/?err=1", request.url).toString(), 302);
  }

  const sig = await hmacSign(env.COOKIE_SECRET, `auth|${dayBucket()}`);
  const headers = new Headers({
    Location: "/",
    "Set-Cookie": `idol_radar_auth=${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
  });
  return new Response(null, { status: 302, headers });
};
```

- [ ] **Step 4: Run tests**

```bash
cd frontend
pnpm test
```

Expected: all tests including auth.test.ts PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/__auth.ts frontend/functions/lib/hmac.ts \
        frontend/tests/functions/auth.test.ts
git commit -m "feat(frontend): __auth function with PBKDF2 password verify and signed cookie"
```

---

## Task 12: Auth Middleware (`frontend/functions/_middleware.ts`)

**Files:**
- Create: `frontend/functions/_middleware.ts`
- Create: `frontend/tests/functions/middleware.test.ts`

- [ ] **Step 1: Write failing tests**

`frontend/tests/functions/middleware.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { onRequest } from "../../functions/_middleware";
import { hmacSign } from "../../functions/lib/hmac";
import { dayBucket } from "../../functions/lib/cookies";

const ENV = { COOKIE_SECRET: "0123456789abcdef0123456789abcdef" } as any;

const next = vi.fn(async () => new Response("ok"));

describe("_middleware", () => {
  it("lets /__auth POST through without cookie", async () => {
    next.mockClear();
    const req = new Request("https://x/__auth", { method: "POST" });
    const res = await onRequest({ request: req, next, env: ENV } as any);
    expect(next).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("blocks /api/* without cookie with 401", async () => {
    next.mockClear();
    const req = new Request("https://x/api/ping");
    const res = await onRequest({ request: req, next, env: ENV } as any);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("allows /api/* with valid cookie", async () => {
    next.mockClear();
    const sig = await hmacSign(ENV.COOKIE_SECRET, `auth|${dayBucket()}`);
    const req = new Request("https://x/api/ping", {
      headers: { cookie: `idol_radar_auth=${sig}` },
    });
    const res = await onRequest({ request: req, next, env: ENV } as any);
    expect(next).toHaveBeenCalled();
  });

  it("rejects /api/* with forged cookie", async () => {
    next.mockClear();
    const req = new Request("https://x/api/ping", {
      headers: { cookie: "idol_radar_auth=deadbeef" },
    });
    const res = await onRequest({ request: req, next, env: ENV } as any);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("does NOT block static asset paths (only /api and /__auth go through here in this test)", async () => {
    next.mockClear();
    const req = new Request("https://x/somepage.html");
    const res = await onRequest({ request: req, next, env: ENV } as any);
    // Middleware lets static through; static is served by Pages directly.
    expect(next).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests (expected FAIL — module missing)**

```bash
cd frontend
pnpm test
```

- [ ] **Step 3: Implement `frontend/functions/_middleware.ts`**

```ts
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
```

- [ ] **Step 4: Run tests**

```bash
cd frontend
pnpm test
```

Expected: all tests including middleware.test.ts PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/_middleware.ts frontend/tests/functions/middleware.test.ts
git commit -m "feat(frontend): _middleware enforces auth on /api/*"
```

---

## Task 13: Health-Check API (`frontend/functions/api/ping.ts`)

**Files:**
- Create: `frontend/functions/api/ping.ts`
- Create: `frontend/tests/functions/ping.test.ts`

- [ ] **Step 1: Write failing test**

`frontend/tests/functions/ping.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { onRequestGet } from "../../functions/api/ping";

describe("/api/ping", () => {
  it("returns ok text", async () => {
    const res = await onRequestGet({} as any);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
```

- [ ] **Step 2: Run test (expected FAIL — module missing)**

```bash
cd frontend
pnpm test
```

- [ ] **Step 3: Implement `frontend/functions/api/ping.ts`**

```ts
export const onRequestGet: PagesFunction = async () =>
  new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
```

- [ ] **Step 4: Run test, verify build still passes**

```bash
cd frontend
pnpm test
pnpm typecheck
pnpm build
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/api/ping.ts frontend/tests/functions/ping.test.ts
git commit -m "feat(frontend): /api/ping health check"
```

---

## Task 14: PR Test Workflow (`.github/workflows/test.yml`)

**Files:**
- Create: `.github/workflows/test.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: test
on:
  pull_request:
  push:
    branches: [main]

jobs:
  worker:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: worker } }
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
        with:
          version: "latest"
          enable-cache: true
      - run: uv sync --frozen --group dev
      - run: uv run ruff check src tests
      - run: uv run pyright src tests
      - run: uv run pytest -v

  frontend:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: frontend } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml
      - run: pnpm i --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 2: Verify YAML syntactically locally**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/test.yml'))"
```

Expected: no output (= valid YAML).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: add PR test workflow for worker and frontend"
```

---

## Task 15: Migration Workflow (`.github/workflows/migrate.yml`)

**Files:**
- Create: `.github/workflows/migrate.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: migrate
on:
  workflow_dispatch:
    inputs:
      target:
        description: "remote | preview"
        default: remote
        required: true
        type: choice
        options: [remote, preview]

jobs:
  apply:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: frontend } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml
      - run: pnpm i --frozen-lockfile

      - name: Apply D1 migrations
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
        run: |
          # wrangler reads ../migrations as configured in wrangler.toml's
          # 'migrations_dir' for the chosen db. We set it explicitly here.
          pnpm exec wrangler d1 migrations apply idol-sight \
            --${{ inputs.target }} \
            --config wrangler.toml
```

> Note: `wrangler.toml` uses `migrations_dir = "../migrations"` (already added in Task 9). If
> wrangler complains about path resolution, switch to `--migrations-dir ../migrations`.

- [ ] **Step 2: Patch `frontend/wrangler.toml` to declare `migrations_dir`**

Open `frontend/wrangler.toml` and replace it with:

```toml
name = "idol-sight"
compatibility_date = "2026-01-01"
pages_build_output_dir = "dist"

[[d1_databases]]
binding = "DB"
database_name = "idol-sight"
database_id = "REPLACE_WITH_REAL_ID"
migrations_dir = "../migrations"
```

- [ ] **Step 3: Validate YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/migrate.yml'))"
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/migrate.yml frontend/wrangler.toml
git commit -m "ci: add manual D1 migration workflow (workflow_dispatch)"
```

---

## Task 16: Frontend Deploy Workflow (`.github/workflows/frontend-deploy.yml`)

**Files:**
- Create: `.github/workflows/frontend-deploy.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: frontend-deploy
on:
  push:
    branches: [main]
    paths: ["frontend/**", "migrations/**", ".github/workflows/frontend-deploy.yml"]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: frontend } }
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          cache-dependency-path: frontend/pnpm-lock.yaml
      - run: pnpm i --frozen-lockfile
      - run: pnpm build

      - name: Deploy to Cloudflare Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          accountId: ${{ secrets.CF_ACCOUNT_ID }}
          workingDirectory: frontend
          command: pages deploy dist --project-name=idol-sight --branch=main
```

- [ ] **Step 2: Validate YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/frontend-deploy.yml'))"
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/frontend-deploy.yml
git commit -m "ci: deploy frontend to Cloudflare Pages on main push"
```

---

## Task 17a: Password-Hash Helper (`scripts/gen-password-hash.mjs`)

**Files:**
- Create: `scripts/gen-password-hash.mjs`
- Create: `scripts/gen-password-hash.test.mjs`

> Setup.sh shells out to this script. It uses Node's built-in webcrypto (Node 20+) so there
> is zero install cost — no `tsx`, no `--experimental-strip-types`. The format produced
> matches `verifyPassword` in `frontend/functions/lib/hmac.ts` (same PBKDF2 params, same
> `iter$saltB64$hashB64` encoding).

- [ ] **Step 1: Implement `scripts/gen-password-hash.mjs`**

```js
#!/usr/bin/env node
// Usage: node scripts/gen-password-hash.mjs <password>
// Prints `${ITER}$${saltB64}$${hashB64}` matching frontend/functions/lib/hmac.ts.

import { webcrypto as crypto } from "node:crypto";

const ITER = 200_000;

function b64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error("usage: node scripts/gen-password-hash.mjs <password>");
    process.exit(2);
  }
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, key, 256,
  );
  process.stdout.write(`${ITER}$${b64(salt)}$${b64(new Uint8Array(bits))}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Implement `scripts/gen-password-hash.test.mjs`**

```js
#!/usr/bin/env node
// Smoke test: encoded output must round-trip through the same PBKDF2 params.

import { webcrypto as crypto } from "node:crypto";
import { execFileSync } from "node:child_process";

async function pbkdf2(pw, salt, iter) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, k, 256,
  );
  return new Uint8Array(bits);
}

function b64decode(s) {
  return new Uint8Array(Buffer.from(s, "base64"));
}

const out = execFileSync("node", ["scripts/gen-password-hash.mjs", "Virtual2026"]).toString().trim();
const [iterStr, saltB64, hashB64] = out.split("$");
const iter = parseInt(iterStr, 10);
if (iter !== 200_000) { console.error("iter mismatch"); process.exit(1); }

const got = await pbkdf2("Virtual2026", b64decode(saltB64), iter);
const expected = b64decode(hashB64);
if (Buffer.compare(got, expected) !== 0) { console.error("hash mismatch"); process.exit(1); }

console.log("OK");
```

- [ ] **Step 3: Run the smoke test**

```bash
node scripts/gen-password-hash.test.mjs
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/gen-password-hash.mjs scripts/gen-password-hash.test.mjs
git commit -m "chore: gen-password-hash.mjs helper (matches frontend PBKDF2 format)"
```

---

## Task 17: Setup Script (`scripts/setup.sh`)

**Files:**
- Create: `scripts/setup.sh` (executable)
- Modify: `scripts/.gitkeep` removed

- [ ] **Step 1: Write `scripts/setup.sh`**

```bash
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
sed -i.bak "s|REPLACE_WITH_REAL_ID|$DB_ID|" "$WRANGLER_TOML" && rm -f "$WRANGLER_TOML.bak"

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
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/setup.sh
rm -f scripts/.gitkeep
```

- [ ] **Step 3: Smoke check (no secrets needed)**

```bash
bash -n scripts/setup.sh
```

Expected: no syntax errors. (The script will refuse to run without `CF_API_TOKEN` etc., which
is correct.)

- [ ] **Step 4: Commit**

```bash
git add scripts/setup.sh
git rm scripts/.gitkeep 2>/dev/null || true
git commit -m "chore: setup.sh provisions D1 + Pages project and prints next steps"
```

---

## Task 18: Onboarding Doc (`docs/onboarding.md`)

**Files:**
- Replace: `docs/onboarding.md` (currently a stub)

- [ ] **Step 1: Write the onboarding guide**

Replace the contents of `docs/onboarding.md` with:

````markdown
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
````

- [ ] **Step 2: Verify links don't 404 internally**

```bash
grep -E '\.\./|docs/superpowers' docs/onboarding.md
```

Expected: only references inside the repo.

- [ ] **Step 3: Commit**

```bash
git add docs/onboarding.md
git commit -m "docs: complete onboarding guide with [USER] vs [AUTO] step markers"
```

---

## Final Verification

- [ ] **Step 1: Run the full local check**

```bash
( cd worker   && uv sync && uv run ruff check && uv run pyright && uv run pytest -v )
( cd frontend && pnpm i && pnpm typecheck && pnpm test && pnpm build )
```

Expected: all green.

- [ ] **Step 2: Inspect commit log**

```bash
git log --oneline
```

Expected commits in this order (or similar):

```
... docs: complete onboarding guide ...
... chore: setup.sh provisions ...
... chore: gen-password-hash.mjs helper ...
... ci: deploy frontend to Cloudflare Pages on main push
... ci: add manual D1 migration workflow ...
... ci: add PR test workflow ...
... feat(frontend): /api/ping health check
... feat(frontend): _middleware enforces auth on /api/*
... feat(frontend): __auth function with PBKDF2 password verify ...
... feat(frontend): hmac + cookie primitives for auth
... feat(frontend): scaffold Vite + Preact + Tailwind shell
... feat(worker): typer CLI skeleton ...
... feat(worker): discord webhook notifier ...
... feat(worker): crawl_meta upsert helpers ...
... feat(worker): config loader ...
... feat(worker): D1 HTTP API client ...
... feat(db): add 0001_init.sql ...
... feat(worker): initialize Python package with uv toolchain
... chore: scaffold top-level repo layout
... cdd261e Spec revisions: ...
... 73c9598 Initial design spec ...
```

- [ ] **Step 3: Verify CI passes on the first PR**

When the user pushes a PR, both `worker` and `frontend` jobs of `test.yml` must pass. If they
don't, fix and push again.

---

## Out of Scope (intentionally deferred)

- Any actual data collection (Plan 2).
- Health Score / Market Share / HHI computation (Plan 3).
- LLM insight generation (Plan 3).
- Full UI (tabs, charts, search, exports, freshness badges) (Plan 4).
- Mobile-specific layouts.
- Multi-user auth.
