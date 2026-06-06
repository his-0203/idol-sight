# Live CCV Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sample YouTube live concurrent-viewers (CCV) for a configurable set of groups (MiiWAN/PLAVE/OWIS/wegosix) so MiiWAN's debut live reactions are measured and benchmarked.

**Architecture:** A global collector (mirrors `MelonChartCollector`) loads `ccv_tracked` groups, fetches each channel's RSS feed (0 YouTube quota) for recent video IDs, batches them through `videos.list(part=snippet,liveStreamingDetails)` (1 unit) to find currently-live videos + their `concurrentViewers`, and emits idempotent UPSERTs into a `live_ccv_samples` time-series table. A windowed cron drives it; a Pages Function + MiiWANBriefing card surface peak/avg CCV.

**Tech Stack:** Python 3.12 (uv, typer, httpx), Cloudflare D1, Pages Functions (TS), Preact, vitest/pytest.

Spec: `docs/superpowers/specs/2026-06-06-live-ccv-collector-design.md`

## File Structure

- Create `migrations/0080_live_ccv.sql` — `ccv_tracked` column + seed + `live_ccv_samples` table + index.
- Create `worker/src/idol_sight/collectors/live_ccv.py` — `LiveCcvCollector` (RSS + videos.list → UPSERT statements).
- Modify `worker/src/idol_sight/cli.py` — `collect-ccv` command + `_load_ccv_targets`.
- Create `.github/workflows/collect-ccv.yml` — windowed cron.
- Create `frontend/functions/api/live-ccv.ts` — peak/avg + samples per tracked group.
- Modify `frontend/src/api.ts` — `liveCcv()`.
- Create `frontend/src/components/LiveCcvCard.tsx` — debut live-reaction card.
- Modify `frontend/src/views/MiiWANBriefing.tsx` — render the card.
- Modify `docs/governance-runbook.md` + `docs/debut-readiness-checklist.md`.
- Tests: `worker/tests/unit/test_live_ccv.py`, `frontend/tests/functions/api_live_ccv.test.ts`.

---

### Task 1: Migration — ccv_tracked column + live_ccv_samples table

**Files:**
- Create: `migrations/0080_live_ccv.sql`
- Test: `worker/tests/unit/test_live_ccv.py`

- [ ] **Step 1: Write the failing test**

```python
# worker/tests/unit/test_live_ccv.py
"""Live CCV collector + migration 0080."""
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _apply_all() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def test_migration_adds_ccv_tracked_and_samples_table():
    conn = _apply_all()
    cols = {r[1] for r in conn.execute("PRAGMA table_info(groups)")}
    assert "ccv_tracked" in cols
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    assert "live_ccv_samples" in tables
    seeded = {r[0] for r in conn.execute(
        "SELECT key FROM groups WHERE ccv_tracked=1")}
    assert {"miiwan", "plave", "owis", "wegosix"} <= seeded
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_live_ccv.py::test_migration_adds_ccv_tracked_and_samples_table -v`
Expected: FAIL — `assert "ccv_tracked" in cols` (column absent).

- [ ] **Step 3: Write the migration**

```sql
-- migrations/0080_live_ccv.sql
-- Live CCV collector (debut-critical). ccv_tracked toggles which groups are
-- sampled; live_ccv_samples is the per-sample time-series (live only).
ALTER TABLE groups ADD COLUMN ccv_tracked INTEGER NOT NULL DEFAULT 0;
UPDATE groups SET ccv_tracked = 1
  WHERE key IN ('miiwan', 'plave', 'owis', 'wegosix');

CREATE TABLE live_ccv_samples (
  video_id            TEXT NOT NULL,
  group_key           TEXT NOT NULL,
  sampled_at          TEXT NOT NULL,   -- ISO8601 UTC
  concurrent_viewers  INTEGER NOT NULL,
  title               TEXT,
  PRIMARY KEY (video_id, sampled_at)
);
CREATE INDEX idx_ccv_group_time ON live_ccv_samples (group_key, sampled_at);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_live_ccv.py -v`
Expected: PASS. Also run `uv run pytest tests/unit/test_migrations_groups_json.py -q` (must still pass — ccv_tracked is non-JSON).

- [ ] **Step 5: Commit**

```bash
git add migrations/0080_live_ccv.sql worker/tests/unit/test_live_ccv.py
git commit -m "feat(ccv): migration 0080 — ccv_tracked + live_ccv_samples"
```

---

### Task 2: LiveCcvCollector — RSS → video IDs

**Files:**
- Create: `worker/src/idol_sight/collectors/live_ccv.py`
- Test: `worker/tests/unit/test_live_ccv.py`

- [ ] **Step 1: Write the failing test** (append to test_live_ccv.py)

```python
from idol_sight.collectors.live_ccv import LiveCcvCollector


class _FakeResp:
    def __init__(self, text="", payload=None, status=200):
        self._text = text
        self._payload = payload or {}
        self.status_code = status

    @property
    def text(self):
        return self._text

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx
            raise httpx.HTTPStatusError("err", request=None, response=None)


class _FakeClient:
    """Routes .get() by URL/params to queued responses."""
    def __init__(self, handler):
        self._handler = handler

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, params=None):
        return self._handler(url, params or {})


_RSS = (
    '<?xml version="1.0"?><feed>'
    '<entry><yt:videoId>aaaaaaaaaaa</yt:videoId></entry>'
    '<entry><yt:videoId>bbbbbbbbbbb</yt:videoId></entry>'
    '<entry><yt:videoId>aaaaaaaaaaa</yt:videoId></entry>'
    '</feed>'
)


def test_rss_video_ids_parses_and_dedupes():
    coll = LiveCcvCollector(api_key="k", groups_loader=lambda: [])
    client = _FakeClient(lambda url, params: _FakeResp(text=_RSS))
    ids = coll._rss_video_ids(client, "UC_test_channel_000000")
    assert ids == ["aaaaaaaaaaa", "bbbbbbbbbbb"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_live_ccv.py::test_rss_video_ids_parses_and_dedupes -v`
Expected: FAIL — `ModuleNotFoundError: idol_sight.collectors.live_ccv`.

- [ ] **Step 3: Write minimal implementation**

```python
# worker/src/idol_sight/collectors/live_ccv.py
"""Live CCV collector — YouTube concurrent-viewers for ccv_tracked groups.

Detection is quota-cheap: channel RSS feed (no Data API → 0 quota) yields recent
video IDs, then a single videos.list(part=snippet,liveStreamingDetails) batch
(1 unit) identifies the currently-live ones and their concurrentViewers. Emits
idempotent UPSERTs into live_ccv_samples; never writes D1 directly.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Callable

import httpx

from idol_sight.collectors.base import CollectionResult

log = logging.getLogger(__name__)

API = "https://www.googleapis.com/youtube/v3"
RSS_URL = "https://www.youtube.com/feeds/videos.xml?channel_id={cid}"
VIDEOS_LIST_MAX = 50
_VIDEO_ID_RE = re.compile(r"<yt:videoId>([\w-]{11})</yt:videoId>")

_UPSERT = (
    "INSERT INTO live_ccv_samples "
    "(video_id, group_key, sampled_at, concurrent_viewers, title) "
    "VALUES (?, ?, ?, ?, ?) "
    "ON CONFLICT(video_id, sampled_at) DO UPDATE SET "
    "concurrent_viewers=excluded.concurrent_viewers, title=excluded.title"
)


class LiveCcvCollector:
    source = "live_ccv"

    def __init__(
        self,
        *,
        api_key: str,
        groups_loader: Callable[[], list[dict]],
        http_factory: Callable[[], Any] | None = None,
    ):
        self._key = api_key
        self._groups_loader = groups_loader   # () -> [{key, yt_channel_id}]
        self._http_factory = http_factory or (lambda: httpx.Client(timeout=30.0))

    def _rss_video_ids(self, client: Any, channel_id: str) -> list[str]:
        r = client.get(RSS_URL.format(cid=channel_id))
        r.raise_for_status()
        return list(dict.fromkeys(_VIDEO_ID_RE.findall(r.text)))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_live_ccv.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/collectors/live_ccv.py worker/tests/unit/test_live_ccv.py
git commit -m "feat(ccv): LiveCcvCollector RSS video-id parsing"
```

---

### Task 3: LiveCcvCollector — videos.list live detection + CCV

**Files:**
- Modify: `worker/src/idol_sight/collectors/live_ccv.py`
- Test: `worker/tests/unit/test_live_ccv.py`

- [ ] **Step 1: Write the failing test** (append)

```python
_VIDEOS_PAYLOAD = {
    "items": [
        {"id": "aaaaaaaaaaa",
         "snippet": {"liveBroadcastContent": "live", "title": "MiiWAN 데뷔 라이브"},
         "liveStreamingDetails": {"concurrentViewers": "1234"}},
        {"id": "bbbbbbbbbbb",
         "snippet": {"liveBroadcastContent": "none", "title": "지난 영상"},
         "liveStreamingDetails": {}},
    ]
}


def test_live_samples_extracts_only_live_with_ccv():
    coll = LiveCcvCollector(api_key="k", groups_loader=lambda: [])
    client = _FakeClient(lambda url, params: _FakeResp(payload=_VIDEOS_PAYLOAD))
    live = coll._live_samples(client, ["aaaaaaaaaaa", "bbbbbbbbbbb"])
    assert set(live) == {"aaaaaaaaaaa"}
    assert live["aaaaaaaaaaa"] == {"ccv": 1234, "title": "MiiWAN 데뷔 라이브"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_live_ccv.py::test_live_samples_extracts_only_live_with_ccv -v`
Expected: FAIL — `AttributeError: 'LiveCcvCollector' object has no attribute '_live_samples'`.

- [ ] **Step 3: Add the method** (append inside the class)

```python
    def _live_samples(self, client: Any, video_ids: list[str]) -> dict[str, dict]:
        """video_id -> {"ccv": int, "title": str} for currently-live videos."""
        out: dict[str, dict] = {}
        for i in range(0, len(video_ids), VIDEOS_LIST_MAX):
            batch = video_ids[i:i + VIDEOS_LIST_MAX]
            r = client.get(
                f"{API}/videos",
                params={
                    "key": self._key,
                    "id": ",".join(batch),
                    "part": "snippet,liveStreamingDetails",
                },
            )
            r.raise_for_status()
            for item in r.json().get("items", []):
                sn = item.get("snippet") or {}
                lsd = item.get("liveStreamingDetails") or {}
                ccv = lsd.get("concurrentViewers")
                if sn.get("liveBroadcastContent") == "live" and ccv is not None:
                    out[item["id"]] = {
                        "ccv": int(ccv),
                        "title": sn.get("title"),
                    }
        return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_live_ccv.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/collectors/live_ccv.py worker/tests/unit/test_live_ccv.py
git commit -m "feat(ccv): videos.list live detection + concurrentViewers extraction"
```

---

### Task 4: LiveCcvCollector — collect_global orchestration

**Files:**
- Modify: `worker/src/idol_sight/collectors/live_ccv.py`
- Test: `worker/tests/unit/test_live_ccv.py`

- [ ] **Step 1: Write the failing test** (append)

```python
def test_collect_global_maps_videos_to_groups_and_upserts():
    targets = [
        {"key": "miiwan", "yt_channel_id": "UCmiiwan0000000000000000"},
        {"key": "owis", "yt_channel_id": "UCowis00000000000000000000"},
    ]

    def handler(url, params):
        if "feeds/videos.xml" in url:
            if "UCmiiwan" in url:
                return _FakeResp(
                    text="<feed><entry><yt:videoId>aaaaaaaaaaa</yt:videoId></entry></feed>")
            return _FakeResp(
                text="<feed><entry><yt:videoId>bbbbbbbbbbb</yt:videoId></entry></feed>")
        return _FakeResp(payload=_VIDEOS_PAYLOAD)  # aaaa live, bbbb not

    coll = LiveCcvCollector(
        api_key="k", groups_loader=lambda: targets,
        http_factory=lambda: _FakeClient(handler))
    result = coll.collect_global(now_iso="2026-06-06T12:00:00Z")
    assert result.rows_inserted == 1            # only aaaa is live
    sql, params = result.statements[0]
    assert "INSERT INTO live_ccv_samples" in sql
    assert params == ["aaaaaaaaaaa", "miiwan", "2026-06-06T12:00:00Z", 1234,
                      "MiiWAN 데뷔 라이브"]


def test_collect_global_all_rss_fail_returns_error():
    def handler(url, params):
        return _FakeResp(status=500)
    coll = LiveCcvCollector(
        api_key="k",
        groups_loader=lambda: [{"key": "miiwan", "yt_channel_id": "UCx"}],
        http_factory=lambda: _FakeClient(handler))
    result = coll.collect_global(now_iso="2026-06-06T12:00:00Z")
    assert result.statements == []
    assert result.errors
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_live_ccv.py -k collect_global -v`
Expected: FAIL — `AttributeError: ... 'collect_global'`.

- [ ] **Step 3: Add the method** (append inside the class)

```python
    def collect_global(self, *, now_iso: str) -> CollectionResult:
        targets = [t for t in self._groups_loader() if t.get("yt_channel_id")]
        errors: list[str] = []
        vid_to_group: dict[str, str] = {}
        statements: list[tuple[str, list[Any]]] = []

        with self._http_factory() as client:
            for t in targets:
                try:
                    ids = self._rss_video_ids(client, t["yt_channel_id"])
                except (httpx.HTTPError, httpx.TimeoutException) as exc:
                    errors.append(f"rss {t['key']}: {exc}")
                    continue
                for vid in ids:
                    vid_to_group.setdefault(vid, t["key"])

            if vid_to_group:
                try:
                    live = self._live_samples(client, list(vid_to_group))
                except (httpx.HTTPError, httpx.TimeoutException) as exc:
                    errors.append(f"videos.list: {exc}")
                    live = {}
                for vid, info in live.items():
                    statements.append((_UPSERT, [
                        vid, vid_to_group[vid], now_iso,
                        info["ccv"], info["title"],
                    ]))

        # Every target's RSS failed and nothing was sampled → sentinel error so
        # the CLI exits non-zero and the workflow's notify-fail fires.
        if targets and not statements and len(errors) >= len(targets):
            return CollectionResult(0, 0, statements=[],
                                    errors=errors or ["live_ccv: all targets failed"])
        return CollectionResult(
            rows_inserted=len(statements), rows_updated=0,
            statements=statements, errors=errors,
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd worker && uv run pytest tests/unit/test_live_ccv.py -v && uv run ruff check src/idol_sight/collectors/live_ccv.py`
Expected: PASS; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/collectors/live_ccv.py worker/tests/unit/test_live_ccv.py
git commit -m "feat(ccv): collect_global — RSS→videos.list→UPSERT with sentinel"
```

---

### Task 5: CLI command `collect-ccv` + target loader

**Files:**
- Modify: `worker/src/idol_sight/cli.py`
- Test: `worker/tests/unit/test_live_ccv.py`

- [ ] **Step 1: Write the failing test** (append)

```python
from unittest.mock import MagicMock

from idol_sight import cli


def test_load_ccv_targets_queries_tracked_groups():
    client = MagicMock()
    client.execute.return_value = [{"key": "miiwan", "yt_channel_id": "UCx"}]
    out = cli._load_ccv_targets(client)
    assert out == [{"key": "miiwan", "yt_channel_id": "UCx"}]
    sql = client.execute.call_args[0][0]
    assert "ccv_tracked=1" in sql.replace(" ", "")
    assert "yt_channel_id IS NOT NULL" in sql
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd worker && uv run pytest tests/unit/test_live_ccv.py::test_load_ccv_targets_queries_tracked_groups -v`
Expected: FAIL — `AttributeError: module 'idol_sight.cli' has no attribute '_load_ccv_targets'`.

- [ ] **Step 3: Add the loader + command** (add near `_load_active_groups` and the other `@app.command`s in cli.py)

```python
def _load_ccv_targets(client) -> list[dict]:
    return client.execute(
        "SELECT key, yt_channel_id FROM groups "
        "WHERE ccv_tracked=1 AND yt_channel_id IS NOT NULL"
    )


@app.command("collect-ccv",
             help="Sample YouTube live concurrent viewers for ccv_tracked groups.")
def collect_ccv(
    now: str | None = typer.Option(
        None, "--now", help="ISO8601 UTC sample time; default = current UTC."),
) -> None:
    from idol_sight.collectors.live_ccv import LiveCcvCollector
    settings = load_settings()
    if not settings.yt_api_key:
        typer.echo("YT_API_KEY unset", err=True)
        raise typer.Exit(code=2)
    client = _make_d1_client(settings)
    now_iso = now or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    coll = LiveCcvCollector(
        api_key=settings.yt_api_key,
        groups_loader=lambda: _load_ccv_targets(client),
    )
    result = coll.collect_global(now_iso=now_iso)
    for e in result.errors:
        typer.echo(f"WARN: {e}", err=True)
    if result.statements:
        client.batch(result.statements)
    typer.echo(f"collect-ccv: {result.rows_inserted} live samples @ {now_iso}")
    raise typer.Exit(code=0 if result.statements or not result.errors else 1)
```

(Confirm `datetime`, `UTC`, `typer`, `load_settings`, `_make_d1_client` are already imported in cli.py — they are, used by existing commands.)

- [ ] **Step 4: Run test + full worker suite**

Run: `cd worker && uv run pytest tests/unit/test_live_ccv.py -v && uv run pytest -q && uv run ruff check src/idol_sight/cli.py`
Expected: all PASS; ruff clean.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/cli.py worker/tests/unit/test_live_ccv.py
git commit -m "feat(ccv): collect-ccv CLI command + ccv-target loader"
```

---

### Task 6: Workflow — windowed cron

**Files:**
- Create: `.github/workflows/collect-ccv.yml`

- [ ] **Step 1: Write the workflow** (model on existing collect workflows; cron `*/30 8-17 * * *` UTC = KST 17:00–02:00)

```yaml
name: collect-ccv
on:
  schedule:
    - cron: "*/30 8-17 * * *"   # every 30 min, UTC 08–17 = KST 17:00–02:00
  workflow_dispatch:

concurrency:
  group: collect-ccv
  cancel-in-progress: false

jobs:
  ccv:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: worker } }
    steps:
      - uses: actions/checkout@v5
      - uses: astral-sh/setup-uv@v6
        with: { enable-cache: true }
      - run: uv sync --frozen
      - name: collect-ccv
        env:
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID: ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          YT_API_KEY: ${{ secrets.YT_API_KEY }}
        run: uv run python -m idol_sight collect-ccv
      - name: notify on failure
        if: failure()
        env:
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
        run: uv run python -m idol_sight notify-fail --job collect-ccv
```

> Verify env var names against an existing `collect-*.yml` (CF_ACCOUNT_ID / CF_D1_DB_ID / CF_API_TOKEN / YT_API_KEY) and the uv setup action version; copy whatever the repo already uses so this matches.

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/collect-ccv.yml
git commit -m "ci(ccv): windowed collect-ccv cron (KST live hours) + notify-fail"
```

---

### Task 7: API endpoint `/api/live-ccv`

**Files:**
- Create: `frontend/functions/api/live-ccv.ts`
- Modify: `frontend/src/api.ts`
- Test: `frontend/tests/functions/api_live_ccv.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/tests/functions/api_live_ccv.test.ts
import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/live-ccv";

const envWith = (h: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: h(sql) })),
  })) },
} as any);

describe("/api/live-ccv", () => {
  it("returns latest-broadcast peak/avg per group with samples", async () => {
    const env = envWith((sql) => {
      if (sql.includes("GROUP BY group_key, video_id")) {
        return [
          { group_key: "miiwan", video_id: "v1", title: "데뷔", peak: 1500,
            avg: 1200.4, n: 5, last_at: "2026-06-06T13:00:00Z" },
          { group_key: "miiwan", video_id: "v0", title: "이전", peak: 800,
            avg: 700, n: 3, last_at: "2026-06-01T13:00:00Z" },
        ];
      }
      if (sql.includes("ORDER BY sampled_at")) {
        return [
          { video_id: "v1", sampled_at: "2026-06-06T12:30:00Z", concurrent_viewers: 900 },
          { video_id: "v1", sampled_at: "2026-06-06T13:00:00Z", concurrent_viewers: 1500 },
        ];
      }
      return [];
    });
    const res = await onRequestGet({ env } as any);
    const b = await res.json() as any;
    expect(b.groups).toHaveLength(1);                  // latest video only per group
    expect(b.groups[0].video_id).toBe("v1");
    expect(b.groups[0].peak).toBe(1500);
    expect(b.groups[0].samples).toHaveLength(2);
  });

  it("returns empty groups gracefully", async () => {
    const res = await onRequestGet({ env: envWith(() => []) } as any);
    const b = await res.json() as any;
    expect(b.groups).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run tests/functions/api_live_ccv.test.ts`
Expected: FAIL — cannot import `../../functions/api/live-ccv`.

- [ ] **Step 3: Write the endpoint**

```ts
// frontend/functions/api/live-ccv.ts
// Live CCV per ccv_tracked group: the most-recent broadcast's peak/avg + a
// recent-sample sparkline. Behind site auth (middleware 401s /api/*).
import { d1Query, type D1Database } from "../lib/d1";
import { jsonResponse } from "../lib/jsonResponse";

interface AggRow {
  group_key: string; video_id: string; title: string | null;
  peak: number; avg: number; n: number; last_at: string;
}
interface SampleRow {
  video_id: string; sampled_at: string; concurrent_viewers: number;
}

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env }) => {
  // One row per (group, broadcast); ordered so the latest broadcast per group
  // is first.
  const aggs = await d1Query<AggRow>(env.DB,
    "SELECT group_key, video_id, MAX(title) AS title, "
    + "       MAX(concurrent_viewers) AS peak, AVG(concurrent_viewers) AS avg, "
    + "       COUNT(*) AS n, MAX(sampled_at) AS last_at "
    + "FROM live_ccv_samples GROUP BY group_key, video_id "
    + "ORDER BY group_key, last_at DESC");

  const latestByGroup = new Map<string, AggRow>();
  for (const r of aggs) {
    if (!latestByGroup.has(r.group_key)) latestByGroup.set(r.group_key, r);
  }
  const latest = [...latestByGroup.values()];

  let samplesByVideo = new Map<string, { t: string; ccv: number }[]>();
  if (latest.length) {
    const ids = latest.map((r) => r.video_id);
    const ph = ids.map(() => "?").join(",");
    const samples = await d1Query<SampleRow>(env.DB,
      `SELECT video_id, sampled_at, concurrent_viewers FROM live_ccv_samples `
      + `WHERE video_id IN (${ph}) ORDER BY sampled_at`, ids);
    samplesByVideo = samples.reduce((m, s) => {
      const arr = m.get(s.video_id) ?? [];
      arr.push({ t: s.sampled_at, ccv: s.concurrent_viewers });
      m.set(s.video_id, arr);
      return m;
    }, new Map<string, { t: string; ccv: number }[]>());
  }

  const groups = latest.map((r) => ({
    group_key: r.group_key,
    video_id: r.video_id,
    title: r.title,
    peak: r.peak,
    avg: Math.round(r.avg),
    sample_count: r.n,
    last_at: r.last_at,
    samples: samplesByVideo.get(r.video_id) ?? [],
  }));

  return jsonResponse({ groups });
};
```

- [ ] **Step 4: Add the api.ts client method**

In `frontend/src/api.ts`, after the `adminStatus:` line:

```ts
  liveCcv:     () => getJson<any>("/api/live-ccv"),
```

- [ ] **Step 5: Run test + tsc**

Run: `cd frontend && ./node_modules/.bin/vitest run tests/functions/api_live_ccv.test.ts && ./node_modules/.bin/tsc -b --noEmit`
Expected: PASS; tsc rc=0.

- [ ] **Step 6: Commit**

```bash
git add frontend/functions/api/live-ccv.ts frontend/src/api.ts frontend/tests/functions/api_live_ccv.test.ts
git commit -m "feat(ccv): /api/live-ccv peak/avg + sparkline endpoint"
```

---

### Task 8: Frontend — LiveCcvCard in MiiWANBriefing

**Files:**
- Create: `frontend/src/components/LiveCcvCard.tsx`
- Modify: `frontend/src/views/MiiWANBriefing.tsx`

- [ ] **Step 1: Write the component**

```tsx
// frontend/src/components/LiveCcvCard.tsx
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";

interface CcvGroup {
  group_key: string; video_id: string; title: string | null;
  peak: number; avg: number; sample_count: number; last_at: string;
  samples: { t: string; ccv: number }[];
}

const LABEL: Record<string, string> = {
  miiwan: "MiiWAN", plave: "PLAVE", owis: "OWIS", wegosix: "WE GO-6",
};

function Spark({ pts }: { pts: { ccv: number }[] }) {
  if (pts.length < 2) return null;
  const vals = pts.map((p) => p.ccv);
  const max = Math.max(...vals, 1);
  const w = 96, h = 24;
  const d = vals.map((v, i) =>
    `${(i / (vals.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg width={w} height={h} class="text-brand-fg">
      <polyline points={d} fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  );
}

export function LiveCcvCard() {
  const [groups, setGroups] = useState<CcvGroup[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.liveCcv().then((d) => setGroups(d.groups)).catch((e) => setErr(String(e)));
  }, []);

  if (err) return null;                       // card is supplementary; fail quiet
  if (!groups) return null;

  const mine = groups.find((g) => g.group_key === "miiwan");
  const others = groups.filter((g) => g.group_key !== "miiwan");

  return (
    <section class="rounded-lg border border-zinc-800 p-4">
      <h3 class="mb-2 text-sm font-semibold">라이브 반응 (동시 시청자)</h3>
      {!mine && others.length === 0 ? (
        <div class="text-hint text-zinc-500">최근 라이브 데이터 없음</div>
      ) : (
        <div class="space-y-3">
          {mine && (
            <div class="flex items-center gap-3">
              <div class="min-w-[64px] text-data font-semibold text-brand-fg">MiiWAN</div>
              <div class="text-data">
                peak <strong>{mine.peak.toLocaleString()}</strong>
                <span class="text-zinc-500"> · avg {mine.avg.toLocaleString()}</span>
              </div>
              <div class="ml-auto"><Spark pts={mine.samples} /></div>
            </div>
          )}
          {others.length > 0 && (
            <div class="border-t border-zinc-800/60 pt-2">
              <div class="mb-1 text-hint text-zinc-500">벤치마크 (최근 방송 peak)</div>
              {others.map((g) => (
                <div key={g.group_key} class="flex items-center gap-3 text-data">
                  <span class="min-w-[64px] text-zinc-400">{LABEL[g.group_key] ?? g.group_key}</span>
                  <span>{g.peak.toLocaleString()}</span>
                  <span class="ml-auto text-zinc-600 text-hint">
                    {new Date(g.last_at).toLocaleDateString("ko-KR")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Wire it into MiiWANBriefing**

In `frontend/src/views/MiiWANBriefing.tsx`, add the import near the other component imports:

```tsx
import { LiveCcvCard } from "../components/LiveCcvCard";
```

Then render it as the first child inside the main content wrapper. Find the line:

```tsx
    <div class="space-y-6">
```

(the one immediately before the `return (` body content at ~line 386) and insert directly after it:

```tsx
      <LiveCcvCard />
```

- [ ] **Step 3: Typecheck + full frontend suite**

Run: `cd frontend && ./node_modules/.bin/tsc -b --noEmit && ./node_modules/.bin/vitest run`
Expected: tsc rc=0; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/LiveCcvCard.tsx frontend/src/views/MiiWANBriefing.tsx
git commit -m "feat(ccv): MiiWANBriefing live-reaction card (peak/avg + benchmark)"
```

---

### Task 9: Docs — retention + debut-readiness; final verification

**Files:**
- Modify: `docs/governance-runbook.md`
- Modify: `docs/debut-readiness-checklist.md`

- [ ] **Step 1: Add a retention row** to the `## 데이터 보존 (Retention)` table in `docs/governance-runbook.md`:

```markdown
| `live_ccv_samples` (라이브 CCV 시계열) | 라이브 중에만 적재, 무한 누적 | 집계 수치(내용 X). 180일 후 다운샘플/삭제 검토(후속). 인덱스 idx_ccv_group_time 존재 |
```

- [ ] **Step 2: Update the debut-readiness checklist** — in `docs/debut-readiness-checklist.md` change the live-CCV line under 데뷔 당일 from `⏳ 미구현` to done:

```markdown
- [x] **라이브 CCV collector (YouTube)** — 구현됨(v1). collect-ccv 워크플로 KST 17:00–02:00 30분 cron; 데뷔 당일은 `gh workflow run collect-ccv.yml` 로 촘촘히. MiiWANBriefing "라이브 반응" 카드. 슈퍼챗 금액·치지직·티켓은 후속.
```

- [ ] **Step 3: Full suites + lint (final gate)**

Run:
```bash
cd worker && uv run pytest -q && uv run ruff check src/idol_sight/collectors/live_ccv.py src/idol_sight/cli.py
cd ../frontend && ./node_modules/.bin/tsc -b --noEmit && ./node_modules/.bin/vitest run
```
Expected: worker all pass + ruff clean; tsc rc=0; frontend all pass.

- [ ] **Step 4: Commit**

```bash
git add docs/governance-runbook.md docs/debut-readiness-checklist.md
git commit -m "docs(ccv): retention row + mark debut-readiness live-CCV done"
```

---

## Post-implementation (operator, human-gated)

1. **Apply migration 0080 to remote D1** — operator runs `gh workflow run migrate.yml` (or `wrangler d1 migrations apply idol-sight --remote`). Until applied, `/api/live-ccv` returns empty (graceful) and collect-ccv writes fail — apply before/with deploy (see CLAUDE.md deploy↔migrate ordering).
2. **frontend-deploy** auto-runs on push (card + endpoint).
3. **Confirm** on the `⚙ 상태` page that collect-ccv runs without error after the next windowed cron, then verify the MiiWANBriefing card during a real live.

## Notes / follow-ups (v2, out of scope)

- Chzzk(치지직) source, superchat message counts, ticket sell-through.
- Per-broadcast aggregate table + CCV spike alert.
- collect-ccv crawl_meta row so it appears on the status page (currently global jobs like melon-chart don't write crawl_meta).
- live_ccv_samples retention cron.
