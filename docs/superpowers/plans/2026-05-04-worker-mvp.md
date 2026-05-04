# IDOL-SIGHT Worker MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the worker actually collect data — naver, dc, theqoo, instiz collectors land rows into D1, agg_summary is populated, CLI dispatches real work, and GH Actions cron drives the loop end-to-end.

**Architecture:** Each collector is a `Collector` protocol implementation reading per-group config and returning `CollectionResult` (D1 statements + counts). The CLI orchestrator wraps the collector with `crawl_meta` recording (attempt → success/failure) and runs the batch. Aggregation runs as a separate `agg_summary` step. GH Actions runs each `(group, source)` matrix cell on its own schedule.

**Tech Stack:** Python 3.12, Scrapling (Fetcher + StealthyFetcher), httpx, typer, pytest fixtures, GitHub Actions cron.

**Spec reference:** `docs/superpowers/specs/2026-05-04-idol-sight-rebuild-design.md`
**Predecessor plan:** `docs/superpowers/plans/2026-05-04-foundation.md` (Plan 1)

---

## Plan-1 Follow-up Issues Addressed Here

Tasks 1-3 in this plan close two of the four Important issues from Plan 1's final review:
- **#4 — D1 BatchSummary partial-failure detection** → Task 1
- **#2 — Discord retry on 5xx only** → Task 2
- **#1 — setup.sh idempotence** + **#3 — gh auth check** → Task 3

The remaining issues from Plan 1 (none Critical) are tracked but not part of this plan.

---

## File Structure

Files added/modified by this plan:

```
worker/src/idol_sight/
├── d1.py                            # MODIFY — BatchSummary gains statements_sent
├── notify.py                        # MODIFY — retry policy narrowed to 5xx
├── cli.py                           # MODIFY — collect now dispatches real work
├── collectors/                      # NEW
│   ├── __init__.py
│   ├── base.py                      # Collector Protocol + CollectionResult
│   ├── naver.py
│   ├── instiz.py
│   ├── theqoo.py
│   └── dc.py
├── utils/                           # NEW
│   ├── __init__.py
│   ├── dates.py                     # parse_safe + DATE_PATTERNS
│   └── url_hash.py
├── selectors_store.py               # NEW — Scrapling auto_save → D1
├── analysis/
│   ├── __init__.py                  # NEW
│   └── agg_summary.py               # NEW
└── orchestrator.py                  # NEW — wraps collector + crawl_meta + writes

worker/tests/unit/
├── test_d1.py                       # MODIFY (BatchSummary fields)
├── test_notify.py                   # MODIFY (retry policy)
├── test_cli.py                      # MODIFY (real dispatch)
├── test_orchestrator.py             # NEW
├── test_dates.py                    # NEW
├── test_url_hash.py                 # NEW
├── test_naver.py                    # NEW
├── test_instiz.py                   # NEW
├── test_theqoo.py                   # NEW
├── test_dc.py                       # NEW
├── test_agg_summary.py              # NEW
└── fixtures/                        # NEW — captured HTML/RSS samples
    ├── naver_search.html
    ├── instiz_hotlist.html
    ├── theqoo_hotpost.html
    └── dc_gallery.html

migrations/
└── 0002_seed.sql                    # NEW — 8 groups + members

scripts/
└── setup.sh                         # MODIFY (idempotence + gh auth check)

.github/workflows/
├── collect-hourly.yml               # NEW
├── collect-6h.yml                   # NEW
└── health-check.yml                 # NEW
```

**File responsibility:**
- `collectors/base.py` defines the contract; each `collectors/<source>.py` knows only its source.
- `orchestrator.py` is the only place that knows about `crawl_meta`, `D1Client.batch`, and the lifecycle around a single collector run. Collectors return statements; orchestrator persists.
- `analysis/agg_summary.py` reads D1 raw tables and upserts `agg_summary`. Pure function, no orchestration.
- `utils/` houses shared primitives reused across collectors.

---

## Conventions

- All shell commands run from the **worktree root** (`/Users/user/Desktop/idol-sight/.worktrees/foundation`) unless noted otherwise. Worker subcommands run from `worker/`.
- Tests use captured fixtures (HTML/RSS files) so they run offline. Live tests are gated by an env var and skipped in CI.
- Each collector reads `GroupConfig` (from `config.py`) — no hardcoded URLs in collectors.
- Per-collector tests load fixture, parse, assert row count + sample row contents.
- Commit policy: one focused commit per task, conventional-commits style.
- Use `git -c user.email=heesoo0203@gmail.com -c user.name=user commit -m "..."` if needed.

---

## Task 1: D1 BatchSummary partial-failure detection

**Files:**
- Modify: `worker/src/idol_sight/d1.py`
- Modify: `worker/tests/unit/test_d1.py`

- [ ] **Step 1: Update test for the new BatchSummary fields**

Open `worker/tests/unit/test_d1.py` and replace the `test_batch_sends_multi_statement` test with:

```python
def test_batch_returns_full_summary(client, httpx_mock: HTTPXMock):
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
    assert summary.statements_sent == 2
    assert summary.statements_executed == 2
    assert summary.total_changes == 3


def test_batch_detects_partial_failure(client, httpx_mock: HTTPXMock):
    httpx_mock.add_response(
        json={"success": True, "result": [
            {"results": [], "meta": {"changes": 1}},
        ]},
    )
    summary = client.batch([
        ("INSERT INTO groups(key,name,name_kr) VALUES(?,?,?)", ["plave", "PLAVE", "플레이브"]),
        ("INSERT INTO groups(key,name,name_kr) VALUES(?,?,?)", ["isedol", "ISEDOL", "이세계아이돌"]),
    ])
    assert summary.statements_sent == 2
    assert summary.statements_executed == 1   # cloudflare returned only 1 result
    assert summary.total_changes == 1
```

- [ ] **Step 2: Run tests to verify FAIL**

```bash
cd worker
uv run pytest tests/unit/test_d1.py -v
```

Expected: FAIL — `BatchSummary` has no `statements_sent` attribute.

- [ ] **Step 3: Update `d1.py`**

Replace the `BatchSummary` dataclass and the body of `D1Client.batch`:

```python
@dataclass
class BatchSummary:
    statements_sent: int
    statements_executed: int
    total_changes: int


class D1Client:
    # ... __init__ unchanged ...

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
        return BatchSummary(
            statements_sent=len(statements),
            statements_executed=len(results),
            total_changes=total_changes,
        )
```

- [ ] **Step 4: Run tests to verify PASS**

```bash
cd worker
uv run pytest tests/unit/test_d1.py -v
```

Expected: 4 PASSED (the original 3 tests + new partial-failure test). The previous `test_batch_sends_multi_statement` was renamed to `test_batch_returns_full_summary`.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/d1.py worker/tests/unit/test_d1.py
git commit -m "feat(worker): D1 BatchSummary tracks statements_sent for partial-failure detection"
```

---

## Task 2: Discord notifier retries on 5xx only

**Files:**
- Modify: `worker/src/idol_sight/notify.py`
- Modify: `worker/tests/unit/test_notify.py`

> **Why:** Plan 1 retried on every `httpx.HTTPError`. A misconfigured webhook URL returning 4xx wastes 3 retries with 1-second sleeps. Narrow retry to transient failures (5xx + connection errors).

- [ ] **Step 1: Update tests**

Replace `worker/tests/unit/test_notify.py` with:

```python
import httpx
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


def test_notify_failure_retries_on_5xx(httpx_mock: HTTPXMock):
    httpx_mock.add_response(url="https://discord.test/hook", status_code=500)
    httpx_mock.add_response(url="https://discord.test/hook", status_code=500)
    httpx_mock.add_response(url="https://discord.test/hook", status_code=204)
    notify_failure(webhook_url="https://discord.test/hook",
                   job="dc:plave",
                   error="x")
    requests = httpx_mock.get_requests()
    assert len(requests) == 3   # retried twice, succeeded on third


def test_notify_failure_does_not_retry_on_4xx(httpx_mock: HTTPXMock):
    httpx_mock.add_response(url="https://discord.test/hook", status_code=404)
    notify_failure(webhook_url="https://discord.test/hook",
                   job="dc:plave",
                   error="x")
    requests = httpx_mock.get_requests()
    assert len(requests) == 1   # 4xx is permanent — no retry


def test_notify_failure_swallows_persistent_5xx(httpx_mock: HTTPXMock):
    for _ in range(5):
        httpx_mock.add_response(url="https://discord.test/hook", status_code=500)
    notify_failure(webhook_url="https://discord.test/hook",
                   job="dc:plave",
                   error="x")
    # Must not raise even after retry exhaustion.
```

- [ ] **Step 2: Run tests to verify FAIL**

```bash
cd worker
uv run pytest tests/unit/test_notify.py -v
```

Expected: at least one FAIL (the 4xx-no-retry test fails because current code retries everything).

- [ ] **Step 3: Update `notify.py`**

Replace the file contents with:

```python
"""Discord webhook notifier. Failures are logged but never re-raised.

Retry policy:
- 5xx and connection errors are transient → retry up to 3 times with 1s wait
- 4xx is permanent (likely misconfigured URL) → do not retry
"""

from __future__ import annotations

import logging

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_fixed,
)

log = logging.getLogger(__name__)


@retry(
    retry=retry_if_exception_type((httpx.ConnectError, httpx.HTTPStatusError)),
    stop=stop_after_attempt(3),
    wait=wait_fixed(1),
    reraise=True,
)
def _post(webhook_url: str, body: dict) -> None:
    with httpx.Client(timeout=10.0) as c:
        r = c.post(webhook_url, json=body)
        # Distinguish transient (5xx) vs permanent (4xx).
        if 500 <= r.status_code < 600:
            r.raise_for_status()                 # raises HTTPStatusError → retry
        if 400 <= r.status_code < 500:
            log.warning("discord 4xx (no retry): %s %s", r.status_code, r.text[:200])
            return                               # swallow; do not raise
        r.raise_for_status()                     # any other non-2xx → raise but won't retry


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

Expected: 4 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/notify.py worker/tests/unit/test_notify.py
git commit -m "fix(worker): discord notify retries 5xx/connect only, swallows 4xx without retry"
```

---

## Task 3: setup.sh idempotence + gh auth guard

**Files:**
- Modify: `scripts/setup.sh`

- [ ] **Step 1: Open `scripts/setup.sh` and locate the `require` block (around line 22-30)**

Add a `gh auth status` check immediately after the existing requires.

After:
```bash
require wrangler
require gh
require jq
require sed
require node
require openssl
```

…and after the existing CF env var checks…
```bash
[[ -n "${CF_API_TOKEN:-}" ]] || { echo "export CF_API_TOKEN first" >&2; exit 1; }
[[ -n "${CF_ACCOUNT_ID:-}" ]] || { echo "export CF_ACCOUNT_ID first" >&2; exit 1; }
```

…add:

```bash
if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi
```

- [ ] **Step 2: Replace the wrangler.toml patching block with idempotent version**

Locate the existing block:

```bash
echo "==> patching $WRANGLER_TOML"
sed -i.bak "s|REPLACE_WITH_REAL_ID|$DB_ID|" "$WRANGLER_TOML" && rm -f "$WRANGLER_TOML.bak"
```

Replace with:

```bash
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
```

- [ ] **Step 3: Smoke check syntactic validity**

```bash
bash -n scripts/setup.sh
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add scripts/setup.sh
git commit -m "fix(scripts): setup.sh checks gh auth and is idempotent on wrangler.toml patch"
```

---

## Task 4: Group + member seed migration

**Files:**
- Create: `migrations/0002_seed.sql`
- Create: `worker/tests/unit/test_seed.py`

> **Important:** This task fills the 8 group rows and their members. The exact `yt_channel_id`, `dc_gallery_id`, `naver_query`, `context_keywords`, `blacklist_phrases`, and member solo-channel IDs must be researched online by the implementer. The implementer should:
>
> 1. Visit each group's official YouTube channel and copy the channel ID (`UC...`).
> 2. Find the dcinside gallery slug (e.g., `plave`, `isedol`).
> 3. Confirm the Korean name and English name spellings.
> 4. List members from official sources (group's debut press release, official site).
> 5. Write `context_keywords` to include all member names + group's English/Korean names + agency name + the word "버추얼".
> 6. Write `blacklist_phrases` for known false-positive sources (e.g., for B:DAWN, "비던 와이너리" if such a thing exists; otherwise leave `[]`).
> 7. After research, paste the resulting INSERTs into the SQL file using the schema below.

**Schema reminder** (from `migrations/0001_init.sql`):

```sql
groups: key, name, name_kr, debut_date, yt_channel_id, dc_gallery_id, naver_query,
        context_keywords (TEXT, JSON array), blacklist_phrases (TEXT, JSON array),
        twitter_handles (TEXT, JSON array), is_active

members: id, group_key, name, name_en, yt_channel_id, active
```

- [ ] **Step 1: Write the validation test (TDD outside-in)**

`worker/tests/unit/test_seed.py`:

```python
import json
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


def _load_with_seed() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.executescript((MIGRATIONS_DIR / "0001_init.sql").read_text())
    conn.executescript((MIGRATIONS_DIR / "0002_seed.sql").read_text())
    return conn


def test_eight_active_groups_seeded():
    conn = _load_with_seed()
    rows = conn.execute(
        "SELECT key FROM groups WHERE is_active=1 ORDER BY key"
    ).fetchall()
    keys = [r[0] for r in rows]
    assert keys == ["bdawn", "isedol", "miiwan", "myrakl", "owis", "plave", "skinz", "stellive"]


def test_each_group_has_required_fields():
    conn = _load_with_seed()
    for key, in conn.execute("SELECT key FROM groups WHERE is_active=1"):
        row = conn.execute(
            "SELECT name, name_kr, naver_query, context_keywords FROM groups WHERE key=?",
            (key,),
        ).fetchone()
        name, name_kr, naver_query, ctx_json = row
        assert name and name_kr, f"{key}: empty name fields"
        assert naver_query, f"{key}: missing naver_query"
        ctx = json.loads(ctx_json or "[]")
        assert isinstance(ctx, list) and len(ctx) >= 3, \
            f"{key}: context_keywords must be list of >=3"


def test_groups_with_debut_have_yt_channel_id():
    conn = _load_with_seed()
    for key, debut, ch in conn.execute(
        "SELECT key, debut_date, yt_channel_id FROM groups WHERE is_active=1"
    ):
        if debut:
            assert ch and ch.startswith("UC"), \
                f"{key}: debuted group missing or bad yt_channel_id ({ch!r})"


def test_members_have_group_fk():
    conn = _load_with_seed()
    bad = conn.execute(
        "SELECT m.name, m.group_key FROM members m "
        "LEFT JOIN groups g ON g.key = m.group_key "
        "WHERE g.key IS NULL"
    ).fetchall()
    assert bad == [], f"members with no matching group: {bad}"


def test_each_active_group_has_at_least_three_members():
    conn = _load_with_seed()
    for key, in conn.execute("SELECT key FROM groups WHERE is_active=1"):
        cnt, = conn.execute(
            "SELECT COUNT(*) FROM members WHERE group_key=? AND active=1",
            (key,),
        ).fetchone()
        assert cnt >= 3, f"{key}: only {cnt} active members"
```

- [ ] **Step 2: Run test to verify FAIL**

```bash
cd worker
uv run pytest tests/unit/test_seed.py -v
```

Expected: FileNotFoundError on `0002_seed.sql`.

- [ ] **Step 3: Research and write `migrations/0002_seed.sql`**

Use this template, filling actual researched values:

```sql
-- 0002_seed.sql — initial group + member seeds for IDOL-SIGHT.
-- Sources: official YouTube channels, dcinside galleries, naver news.
-- Researched 2026-05-04. Update via 0003_*.sql, never edit this file.

INSERT INTO groups (key, name, name_kr, debut_date, yt_channel_id, dc_gallery_id, naver_query, context_keywords, blacklist_phrases, twitter_handles, is_active) VALUES
  ('plave',    'PLAVE',    '플레이브',     '2023-03-12',
   'UC<replace>',  'plave',
   '플레이브',
   '["플레이브","PLAVE","노아","예준","하민","밤비","은호","버추얼","VLAST"]',
   '[]',
   '["plave_official"]',
   1),
  ('isedol',   'ISEDOL',   '이세계아이돌', '2021-12-17',
   'UC<replace>',  'isedol',
   '이세계아이돌',
   '["이세계아이돌","ISEDOL","릴파","아이네","징버거","주르르","고세구","비챤","버추얼","왁타버스"]',
   '[]',
   '["isedolofficial"]',
   1),
  ('stellive', 'STELLIVE', '스텔라이브',   '2023-03-08',
   'UC<replace>',  'stellive',
   '스텔라이브',
   '["스텔라이브","STELLIVE","스텔라","유니","후야","시부키","히나","마시로","리제","타비","나나","린","리코","버추얼"]',
   '[]',
   '["stelliveofficial"]',
   1),
  ('skinz',    'SKINZ',    '스킨즈',       '2025-08-01',
   'UC<replace>',  'skinz',
   'SKINZ 스킨즈',
   '["SKINZ","스킨즈","버추얼"]',
   '[]',
   '[]',
   1),
  ('myrakl',   'MY:RAKL',  '미라클',       '2025-09-15',
   'UC<replace>',  'myrakl',
   'MY:RAKL 미라클 버추얼',
   '["MY:RAKL","마이라클","미라클","버추얼"]',
   '["기적","축구"]',
   '[]',
   1),
  ('owis',     'OWIS',     '오위스',       '2026-03-23',
   'UC<replace>',  'owis',
   'OWIS 오위스',
   '["OWIS","오위스","썸머","소이","세린","하루","유니","올마이애닉도츠","AllMyAnyCs","버추얼"]',
   '[]',
   '[]',
   1),
  ('miiwan',   'MiiWAN',   '미완소년',     '2026-06-01',
   'UC<replace>',  'miiwan',
   'MiiWAN 미완소년',
   '["MiiWAN","미완소년","나이선","임온","마하진","안석우","원주율","IPX","어비스컴퍼니","버추얼"]',
   '[]',
   '["miiwan_official"]',
   1),
  ('bdawn',    'B:DAWN',   '비던',         NULL,
   NULL,           'bdawn',
   'B:DAWN 비던 버추얼',
   '["B:DAWN","비던","강호","서도진","임이온","이한솔","송우림","버추얼"]',
   '["와이너리","마을"]',
   '[]',
   1);

INSERT INTO members (group_key, name, name_en, yt_channel_id, active) VALUES
  -- PLAVE
  ('plave', '노아', 'Noah',  'UC<replace_or_null>', 1),
  ('plave', '예준', 'Yejun', NULL, 1),
  ('plave', '하민', 'Hamin', NULL, 1),
  ('plave', '밤비', 'Bamby', NULL, 1),
  ('plave', '은호', 'Eunho', NULL, 1),
  -- ISEDOL
  ('isedol', '릴파',   'Lilpa',     NULL, 1),
  ('isedol', '아이네', 'Ine',       NULL, 1),
  ('isedol', '징버거', 'Jingburger', NULL, 1),
  ('isedol', '주르르', 'Jururu',    NULL, 1),
  ('isedol', '고세구', 'Gosegu',    NULL, 1),
  ('isedol', '비챤',   'Viichan',   NULL, 1),
  -- STELLIVE
  ('stellive', '아야츠노 유니',   'Ayatsuno Yuni',   NULL, 1),
  ('stellive', '사키하네 후야',   'Sakihane Fuya',   NULL, 1),
  ('stellive', '텐코 시부키',     'Tenko Shibuki',   NULL, 1),
  ('stellive', '시라유키 히나',   'Shirayuki Hina',  NULL, 1),
  ('stellive', '네네코 마시로',   'Neneko Mashiro',  NULL, 1),
  ('stellive', '아카네 리제',     'Akane Lize',      NULL, 1),
  ('stellive', '아라하시 타비',   'Arahashi Tabi',   NULL, 1),
  ('stellive', '하나코 나나',     'Hanako Nana',     NULL, 1),
  ('stellive', '아오쿠모 린',     'Aokumo Rin',      NULL, 1),
  ('stellive', '유즈하 리코',     'Yuzuha Riko',     NULL, 1),
  -- SKINZ — fill from research
  ('skinz', '<member1>', '<en1>', NULL, 1),
  ('skinz', '<member2>', '<en2>', NULL, 1),
  ('skinz', '<member3>', '<en3>', NULL, 1),
  -- MY:RAKL — fill from research
  ('myrakl', '<member1>', '<en1>', NULL, 1),
  ('myrakl', '<member2>', '<en2>', NULL, 1),
  ('myrakl', '<member3>', '<en3>', NULL, 1),
  -- OWIS
  ('owis', '썸머', 'Summer', NULL, 1),
  ('owis', '소이', 'Soi',    NULL, 1),
  ('owis', '세린', 'Serin',  NULL, 1),
  ('owis', '하루', 'Haru',   NULL, 1),
  ('owis', '유니', 'Yuni',   NULL, 1),
  -- MiiWAN
  ('miiwan', '나이선', 'Naison',     NULL, 1),
  ('miiwan', '임온',   'Imon',       NULL, 1),
  ('miiwan', '마하진', 'Mahajin',    NULL, 1),
  ('miiwan', '안석우', 'AnSeokwoo',  NULL, 1),
  ('miiwan', '원주율', 'Wonjuyul',   NULL, 1),
  -- B:DAWN
  ('bdawn', '강호',   'Kangho',    NULL, 1),
  ('bdawn', '서도진', 'Seodojin',  NULL, 1),
  ('bdawn', '임이온', 'Imeon',     NULL, 1),
  ('bdawn', '이한솔', 'Leehansol', NULL, 1),
  ('bdawn', '송우림', 'Songwoorim', NULL, 1);
```

**Implementer's research checklist (before pasting):**
- [ ] Replace every `UC<replace>` with the real channel ID (verify by visiting `youtube.com/channel/UC...`).
- [ ] Replace every `<member1>`, `<en1>` placeholder for SKINZ and MY:RAKL with real names.
- [ ] Verify each `dc_gallery_id` resolves at `https://gall.dcinside.com/board/lists/?id=<slug>`.
- [ ] If any group's debut date is incorrect, fix it (cross-check with naver/wikipedia).
- [ ] If member solo channels exist (e.g., PLAVE 노아 has a solo channel), fill the `yt_channel_id` column.

If the implementer cannot find a particular value with confidence, **mark the row with `is_active=0`** and add a comment in the SQL — do not silently use a wrong ID. Plan 3 has a follow-up task to verify.

- [ ] **Step 4: Run tests to verify PASS**

```bash
cd worker
uv run pytest tests/unit/test_seed.py -v
```

Expected: 5 PASSED. If `test_groups_with_debut_have_yt_channel_id` fails, the implementer hasn't filled in real channel IDs.

- [ ] **Step 5: Commit**

```bash
git add migrations/0002_seed.sql worker/tests/unit/test_seed.py
git commit -m "feat(db): seed 8 groups and their members with researched IDs"
```

---

## Task 5: Date parser utility

**Files:**
- Create: `worker/src/idol_sight/utils/__init__.py`
- Create: `worker/src/idol_sight/utils/dates.py`
- Create: `worker/tests/unit/test_dates.py`

> **Why:** The current Naver implementation crashes on dates like `"2026.03.12 alice09@..."` (text bleeds into the date field). The spec §7.4 requires a parser that limits scope to first 30 chars and tries multiple formats.

- [ ] **Step 1: Write the failing tests**

`worker/tests/unit/test_dates.py`:

```python
from datetime import datetime

from idol_sight.utils.dates import parse_safe


def test_iso_with_time():
    assert parse_safe("2026-05-04T08:15:00Z") == datetime(2026, 5, 4, 8, 15)


def test_korean_dot_format():
    assert parse_safe("2026.03.12.") == datetime(2026, 3, 12)


def test_korean_dot_with_time():
    # Time is ignored — only Y/M/D resolution kept.
    assert parse_safe("2026.03.12 14:30") == datetime(2026, 3, 12, 14, 30)


def test_slash_format():
    assert parse_safe("2026/5/04") == datetime(2026, 5, 4)


def test_iso_short():
    assert parse_safe("2026-03-12") == datetime(2026, 3, 12)


def test_text_bleed_caught_by_30char_window():
    # Real failure case from current site:
    # date field contained article body starting "2026.03.12 alice09@newspim.com 오위스는..."
    s = "2026.03.12 alice09@newspim.com 오위스는 첫 번째 미니 앨범을 발매한다."
    # The first 30 chars are "2026.03.12 alice09@newspim.com" — the parser should
    # match the leading date and ignore the rest.
    assert parse_safe(s) == datetime(2026, 3, 12)


def test_garbage_returns_none():
    assert parse_safe("이 글은 어제 작성됨") is None


def test_empty_returns_none():
    assert parse_safe("") is None
    assert parse_safe(None) is None


def test_invalid_calendar_returns_none():
    # Month 13 doesn't exist
    assert parse_safe("2026-13-01") is None
```

- [ ] **Step 2: Run test to verify FAIL**

```bash
cd worker
uv run pytest tests/unit/test_dates.py -v
```

Expected: ImportError on `idol_sight.utils.dates`.

- [ ] **Step 3: Implement the module**

Create `worker/src/idol_sight/utils/__init__.py`:

```python
"""Shared utility primitives."""
```

Create `worker/src/idol_sight/utils/dates.py`:

```python
"""Defensive date parsing for crawled fields.

Real-world data from naver/dc/theqoo often has the date column polluted with
body text. We:
1. Look only at the first 30 characters (the date should always be at the start).
2. Try multiple regex patterns in order of specificity.
3. Validate the parsed (year, month, day) against the calendar — invalid
   dates return None rather than raising.
"""

from __future__ import annotations

import re
from datetime import datetime

DATE_PATTERNS = [
    # Most specific first: ISO with time
    re.compile(r"(\d{4})-(\d{2})-(\d{2})[\sT](\d{2}):(\d{2})"),
    # Korean dot format with time
    re.compile(r"(\d{4})\.(\d{1,2})\.(\d{1,2})\.?\s+(\d{1,2}):(\d{1,2})"),
    # Korean dot format date-only
    re.compile(r"(\d{4})\.(\d{1,2})\.(\d{1,2})\.?"),
    # Slash format
    re.compile(r"(\d{4})/(\d{1,2})/(\d{1,2})"),
    # ISO date-only
    re.compile(r"(\d{4})-(\d{2})-(\d{2})"),
]

WINDOW = 30


def parse_safe(s: str | None) -> datetime | None:
    """Parse the start of `s` as a date.

    Returns None on missing input, unparseable input, or invalid calendar
    components. Never raises.
    """
    if not s:
        return None
    head = s.strip()[:WINDOW]
    for pattern in DATE_PATTERNS:
        m = pattern.search(head)
        if not m:
            continue
        try:
            parts = [int(g) for g in m.groups()]
            return datetime(*parts)   # type: ignore[arg-type]
        except (ValueError, TypeError):
            continue
    return None
```

- [ ] **Step 4: Run tests to verify PASS**

```bash
cd worker
uv run pytest tests/unit/test_dates.py -v
```

Expected: 9 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/utils/__init__.py worker/src/idol_sight/utils/dates.py \
        worker/tests/unit/test_dates.py
git commit -m "feat(worker): defensive date parser with 30-char window and calendar validation"
```

---

## Task 6: URL hash utility

**Files:**
- Create: `worker/src/idol_sight/utils/url_hash.py`
- Create: `worker/tests/unit/test_url_hash.py`

- [ ] **Step 1: Write tests**

`worker/tests/unit/test_url_hash.py`:

```python
from idol_sight.utils.url_hash import url_hash


def test_url_hash_is_stable_sha1_hex():
    h = url_hash("https://example.com/x")
    assert isinstance(h, str)
    assert len(h) == 40
    assert all(c in "0123456789abcdef" for c in h)
    # Stable
    assert url_hash("https://example.com/x") == h


def test_different_urls_different_hashes():
    assert url_hash("https://a/") != url_hash("https://b/")


def test_normalizes_trailing_whitespace():
    assert url_hash("https://example.com/x") == url_hash("https://example.com/x\n")
    assert url_hash("https://example.com/x") == url_hash("  https://example.com/x  ")
```

- [ ] **Step 2: Run test to verify FAIL**

```bash
cd worker
uv run pytest tests/unit/test_url_hash.py -v
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/utils/url_hash.py`:

```python
"""SHA-1 URL hash for primary-key columns in raw_* tables."""

from __future__ import annotations

import hashlib


def url_hash(url: str) -> str:
    """Return the lowercase hex SHA-1 of the (stripped) URL."""
    return hashlib.sha1(url.strip().encode("utf-8")).hexdigest()
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_url_hash.py -v
```

Expected: 3 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/utils/url_hash.py worker/tests/unit/test_url_hash.py
git commit -m "feat(worker): url_hash sha1 helper"
```

---

## Task 7: Collector base + CollectionResult

**Files:**
- Create: `worker/src/idol_sight/collectors/__init__.py`
- Create: `worker/src/idol_sight/collectors/base.py`

- [ ] **Step 1: Create the package marker**

`worker/src/idol_sight/collectors/__init__.py`:

```python
"""Source-specific data collectors."""
```

- [ ] **Step 2: Define the contract**

`worker/src/idol_sight/collectors/base.py`:

```python
"""Collector protocol and shared result types.

Each collector reads a GroupConfig and produces a CollectionResult containing
SQL statements ready for D1Client.batch(). Collectors do NOT touch D1 directly —
the orchestrator (orchestrator.py) is the only writer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from idol_sight.config import GroupConfig


@dataclass
class CollectionResult:
    rows_inserted: int
    rows_updated: int
    statements: list[tuple[str, list[Any]]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    runtime_ms: int = 0

    def merge(self, other: "CollectionResult") -> "CollectionResult":
        return CollectionResult(
            rows_inserted=self.rows_inserted + other.rows_inserted,
            rows_updated=self.rows_updated + other.rows_updated,
            statements=self.statements + other.statements,
            errors=self.errors + other.errors,
            runtime_ms=self.runtime_ms + other.runtime_ms,
        )


class Collector(Protocol):
    source: str        # 'naver' | 'dc' | 'theqoo' | 'instiz' | ...

    def collect(
        self,
        group: GroupConfig,
        since: str | None = None,
    ) -> CollectionResult:
        """Fetch and parse data for this (source, group), returning statements
        ready to write to D1. The `since` argument is the ISO 8601 timestamp of
        the previous successful run, used by collectors that support
        incremental fetching. Collectors that always fetch the same window may
        ignore `since`.
        """
        ...
```

- [ ] **Step 3: Smoke test by importing**

```bash
cd worker
uv run python -c "from idol_sight.collectors.base import Collector, CollectionResult; print('OK')"
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add worker/src/idol_sight/collectors/__init__.py worker/src/idol_sight/collectors/base.py
git commit -m "feat(worker): collector protocol and CollectionResult"
```

---

## Task 8: Selectors store (Scrapling auto_save → D1)

**Files:**
- Create: `worker/src/idol_sight/selectors_store.py`
- Create: `worker/tests/unit/test_selectors_store.py`

> **Why:** Scrapling's `auto_save=True` learns adaptive selectors per page, but this state lives in memory. Each GH Actions matrix run starts a fresh container, so we'd lose all learning. We persist to the `selectors_cache` D1 table.

- [ ] **Step 1: Write tests**

`worker/tests/unit/test_selectors_store.py`:

```python
from unittest.mock import MagicMock

from idol_sight.selectors_store import SelectorsStore


def test_store_upserts_via_d1():
    client = MagicMock()
    store = SelectorsStore(client)
    store.save("dc", "gallery_post", '{"selector": "div.gall_list"}')
    sql, params = client.execute.call_args[0]
    assert "selectors_cache" in sql
    assert "dc" in params
    assert "gallery_post" in params
    assert '{"selector": "div.gall_list"}' in params


def test_load_returns_none_when_missing():
    client = MagicMock()
    client.execute.return_value = []
    store = SelectorsStore(client)
    assert store.load("dc", "gallery_post") is None


def test_load_returns_serialized_when_present():
    client = MagicMock()
    client.execute.return_value = [{"serialized": "blob"}]
    store = SelectorsStore(client)
    assert store.load("dc", "gallery_post") == "blob"
```

- [ ] **Step 2: Run test to verify FAIL**

```bash
cd worker
uv run pytest tests/unit/test_selectors_store.py -v
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/selectors_store.py`:

```python
"""Persist Scrapling adaptive-selector state in D1's selectors_cache table."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_UPSERT = """
INSERT INTO selectors_cache(site, selector_key, serialized, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(site, selector_key) DO UPDATE SET
  serialized=excluded.serialized,
  updated_at=excluded.updated_at
""".strip()


_SELECT = """
SELECT serialized FROM selectors_cache WHERE site=? AND selector_key=?
""".strip()


class SelectorsStore:
    def __init__(self, client: _Executor):
        self._c = client

    def save(self, site: str, selector_key: str, serialized: str) -> None:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self._c.execute(_UPSERT, [site, selector_key, serialized, now])

    def load(self, site: str, selector_key: str) -> str | None:
        rows = self._c.execute(_SELECT, [site, selector_key])
        if not rows:
            return None
        return rows[0].get("serialized")
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_selectors_store.py -v
```

Expected: 3 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/selectors_store.py worker/tests/unit/test_selectors_store.py
git commit -m "feat(worker): selectors_cache D1 store for Scrapling auto_save"
```

---

## Task 9: Orchestrator

**Files:**
- Create: `worker/src/idol_sight/orchestrator.py`
- Create: `worker/tests/unit/test_orchestrator.py`

> **Why:** Wraps a single collector run with crawl_meta lifecycle (attempt → success/failure), executes the batch, and reports results. This is the only module that knows about D1 batch + crawl_meta sequencing. Collectors stay pure.

- [ ] **Step 1: Write tests**

`worker/tests/unit/test_orchestrator.py`:

```python
from unittest.mock import MagicMock

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig
from idol_sight.orchestrator import run_collector


def _group():
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave",
        naver_query="플레이브",
        context_keywords=["플레이브"], blacklist_phrases=[],
        twitter_handles=[],
    )


def test_run_collector_records_attempt_then_success():
    collector = MagicMock()
    collector.source = "naver"
    collector.collect.return_value = CollectionResult(
        rows_inserted=10, rows_updated=2,
        statements=[("INSERT INTO naver_articles VALUES (?)", ["x"])],
        runtime_ms=123,
    )
    client = MagicMock()
    client.batch.return_value = MagicMock(
        statements_sent=1, statements_executed=1, total_changes=10,
    )

    summary = run_collector(client, collector, _group(), expected_interval_h=1)

    # crawl_meta upserts: attempt then success.
    assert client.execute.call_count == 2
    attempt_sql = client.execute.call_args_list[0][0][0]
    success_sql = client.execute.call_args_list[1][0][0]
    assert "running" in attempt_sql
    assert "ok" in success_sql

    # Batch was sent.
    client.batch.assert_called_once()
    assert summary.status == "ok"
    assert summary.rows_inserted == 10


def test_run_collector_records_failure_on_exception():
    collector = MagicMock()
    collector.source = "dc"
    collector.collect.side_effect = RuntimeError("cloudflare blocked")
    client = MagicMock()

    summary = run_collector(client, collector, _group(), expected_interval_h=6)

    # Attempt then failure.
    assert client.execute.call_count == 2
    failure_sql = client.execute.call_args_list[1][0][0]
    assert "failed" in failure_sql
    failure_params = client.execute.call_args_list[1][0][1]
    assert "cloudflare blocked" in failure_params

    # No batch (collector raised before producing statements).
    client.batch.assert_not_called()
    assert summary.status == "failed"


def test_run_collector_records_partial_when_batch_drops_rows():
    collector = MagicMock()
    collector.source = "naver"
    collector.collect.return_value = CollectionResult(
        rows_inserted=10, rows_updated=0,
        statements=[("INSERT", []), ("INSERT", [])],
    )
    client = MagicMock()
    client.batch.return_value = MagicMock(
        statements_sent=2, statements_executed=1, total_changes=1,
    )

    summary = run_collector(client, collector, _group(), expected_interval_h=1)
    # Treated as failure because not all statements landed.
    assert summary.status == "failed"
    assert "partial" in (summary.error_msg or "").lower()
```

- [ ] **Step 2: Run tests to verify FAIL**

```bash
cd worker
uv run pytest tests/unit/test_orchestrator.py -v
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/orchestrator.py`:

```python
"""Orchestrate a single (collector, group) run.

Lifecycle:
    1. record_attempt → crawl_meta status='running'
    2. collector.collect(group) → CollectionResult or raise
    3a. on success: client.batch(result.statements) → BatchSummary
        - if statements_executed == statements_sent: record_success
        - else: record_failure with 'partial: N/M' message
    3b. on raise: record_failure
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from time import perf_counter

from idol_sight.collectors.base import Collector
from idol_sight.config import GroupConfig
from idol_sight.d1 import D1Client
from idol_sight.meta import record_attempt, record_failure, record_success


@dataclass
class RunSummary:
    job: str
    status: str                         # 'ok' | 'failed'
    rows_inserted: int = 0
    rows_updated: int = 0
    runtime_ms: int = 0
    error_msg: str | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_collector(
    client: D1Client,
    collector: Collector,
    group: GroupConfig,
    *,
    expected_interval_h: int,
) -> RunSummary:
    job = f"{collector.source}:{group.key}"
    started = perf_counter()
    record_attempt(
        client, job=job, group_key=group.key, source=collector.source,
        expected_interval_h=expected_interval_h, now=_now_iso(),
    )

    try:
        result = collector.collect(group)
    except Exception as exc:                     # noqa: BLE001 — orchestrator is the recovery boundary
        runtime_ms = int((perf_counter() - started) * 1000)
        msg = f"{type(exc).__name__}: {exc}"[:1500]
        record_failure(client, job=job, now=_now_iso(), runtime_ms=runtime_ms, error_msg=msg)
        return RunSummary(job=job, status="failed", runtime_ms=runtime_ms, error_msg=msg)

    if result.statements:
        summary = client.batch(result.statements)
        if summary.statements_executed != summary.statements_sent:
            runtime_ms = int((perf_counter() - started) * 1000)
            msg = f"partial: {summary.statements_executed}/{summary.statements_sent}"
            record_failure(client, job=job, now=_now_iso(), runtime_ms=runtime_ms, error_msg=msg)
            return RunSummary(job=job, status="failed", runtime_ms=runtime_ms, error_msg=msg)

    runtime_ms = int((perf_counter() - started) * 1000)
    record_success(
        client, job=job, now=_now_iso(), runtime_ms=runtime_ms,
        rows_inserted=result.rows_inserted, rows_updated=result.rows_updated,
    )
    return RunSummary(
        job=job, status="ok",
        rows_inserted=result.rows_inserted, rows_updated=result.rows_updated,
        runtime_ms=runtime_ms,
    )
```

- [ ] **Step 4: Run tests to verify PASS**

```bash
cd worker
uv run pytest tests/unit/test_orchestrator.py -v
```

Expected: 3 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/orchestrator.py worker/tests/unit/test_orchestrator.py
git commit -m "feat(worker): orchestrator wraps collector with crawl_meta + batch"
```

---

## Task 10: Naver collector

**Files:**
- Create: `worker/src/idol_sight/collectors/naver.py`
- Create: `worker/src/idol_sight/analysis/__init__.py`
- Create: `worker/src/idol_sight/analysis/news_filter.py`
- Create: `worker/tests/unit/test_news_filter.py`
- Create: `worker/tests/unit/test_naver.py`
- Create: `worker/tests/unit/fixtures/naver_search.html`

> **Approach:**
> 1. Use Naver search results page (`https://search.naver.com/search.naver?where=news&query=<naver_query>`).
> 2. Parse with Scrapling's `Fetcher` (curl_cffi). Selectors target the article list (`.news_area`).
> 3. Apply `NewsFilter` from `analysis/news_filter.py` — context keyword check, date parser, blacklist, before-debut filter.
> 4. Build INSERT statements for `naver_articles` and `crawl_meta`.
> 5. Excluded rows are stored with `is_excluded=1` + `exclude_reason` so we can re-tune filters later.

- [ ] **Step 1: Capture a fixture**

The implementer should once visit `https://search.naver.com/search.naver?where=news&query=%ED%94%8C%EB%A0%88%EC%9D%B4%EB%B8%8C` (the URL-encoded form of "플레이브") in a browser, save the HTML to `worker/tests/unit/fixtures/naver_search.html`, then trim it to ~5 articles for fast tests.

- [ ] **Step 2: Write `news_filter.py` and its test (per spec §7.4)**

`worker/src/idol_sight/analysis/__init__.py`:

```python
"""Analysis layer: news filtering, scoring, aggregation."""
```

`worker/src/idol_sight/analysis/news_filter.py`:

```python
"""Filter naver news articles for relevance.

Excludes articles that:
- Don't contain at least one context keyword (catches same-name false positives).
- Have unparseable publication dates.
- Were published more than a year before the group's debut.
- Match a blacklist phrase.

Excluded articles are still saved with is_excluded=1 + exclude_reason so we
can re-tune rules without re-crawling.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe


@dataclass
class FilterResult:
    relevant: bool
    reason: str | None      # Set when relevant=False; one of:
                            # 'no_context_keyword' | 'unparseable_date'
                            # | 'before_debut_minus_year' | f'blacklist:{phrase}'


class NewsFilter:
    def __init__(self, group: GroupConfig):
        self._group = group
        if group.debut_date:
            try:
                debut = datetime.fromisoformat(group.debut_date)
                self._allow_after = (debut - timedelta(days=365)).date()
            except ValueError:
                self._allow_after = None
        else:
            self._allow_after = None

    def evaluate(self, *, title: str, snippet: str, published_at: str) -> FilterResult:
        text = f"{title} {snippet}"

        if not any(kw in text for kw in self._group.context_keywords):
            return FilterResult(False, "no_context_keyword")

        pub = parse_safe(published_at)
        if pub is None:
            return FilterResult(False, "unparseable_date")

        if self._allow_after and pub.date() < self._allow_after:
            return FilterResult(False, "before_debut_minus_year")

        for bl in self._group.blacklist_phrases:
            if bl in text:
                return FilterResult(False, f"blacklist:{bl}")

        return FilterResult(True, None)
```

`worker/tests/unit/test_news_filter.py`:

```python
from idol_sight.analysis.news_filter import NewsFilter
from idol_sight.config import GroupConfig


def _bdawn() -> GroupConfig:
    return GroupConfig(
        key="bdawn", name="B:DAWN", name_kr="비던",
        debut_date=None,
        yt_channel_id=None, dc_gallery_id="bdawn", naver_query="B:DAWN 비던",
        context_keywords=["B:DAWN", "비던", "강호", "버추얼"],
        blacklist_phrases=["와이너리", "마을"],
        twitter_handles=[],
    )


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE", "노아", "버추얼"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def test_blocks_when_no_context_keyword():
    f = NewsFilter(_plave())
    r = f.evaluate(
        title="K-팝 시장 동향",
        snippet="2026년 K-팝 매출 분석",
        published_at="2026.05.04.",
    )
    assert not r.relevant
    assert r.reason == "no_context_keyword"


def test_allows_when_context_keyword_present():
    f = NewsFilter(_plave())
    r = f.evaluate(
        title="플레이브 신곡 발매",
        snippet="버추얼 아이돌 플레이브가 신곡을 발매했다.",
        published_at="2026.05.04.",
    )
    assert r.relevant


def test_blocks_unparseable_date():
    f = NewsFilter(_plave())
    r = f.evaluate(
        title="플레이브 신곡 발매",
        snippet="...",
        published_at="어제 발매됨",
    )
    assert not r.relevant
    assert r.reason == "unparseable_date"


def test_blocks_before_debut_minus_year():
    f = NewsFilter(_plave())   # debut 2023-03-12
    r = f.evaluate(
        title="플레이브 관련",
        snippet="...",
        published_at="2020-01-01",
    )
    assert not r.relevant
    assert r.reason == "before_debut_minus_year"


def test_blocks_blacklist_phrase():
    f = NewsFilter(_bdawn())
    r = f.evaluate(
        title="비던 와이너리 신제품 출시",
        snippet="...",
        published_at="2026.05.04.",
    )
    assert not r.relevant
    assert r.reason and r.reason.startswith("blacklist:와이너리")


def test_pre_debut_group_skips_date_floor():
    f = NewsFilter(_bdawn())   # no debut_date
    r = f.evaluate(
        title="비던 데뷔 예정",
        snippet="버추얼 그룹 비던",
        published_at="2020-01-01",
    )
    assert r.relevant   # No debut → no floor
```

- [ ] **Step 3: Run news_filter tests**

```bash
cd worker
uv run pytest tests/unit/test_news_filter.py -v
```

Expected: 6 PASSED.

- [ ] **Step 4: Implement Naver collector**

`worker/src/idol_sight/collectors/naver.py`:

```python
"""Naver news collector.

Fetches search.naver.com results for the group's naver_query, parses each
article card, runs NewsFilter, and emits INSERTs for naver_articles. Rows
filtered out are still inserted with is_excluded=1 so filter rules can be
tuned later.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from time import perf_counter
from typing import Any
from urllib.parse import quote

from scrapling import Fetcher

from idol_sight.analysis.news_filter import NewsFilter
from idol_sight.collectors.base import CollectionResult, Collector
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe
from idol_sight.utils.url_hash import url_hash

log = logging.getLogger(__name__)


SEARCH_URL = "https://search.naver.com/search.naver?where=news&sm=tab_jum&query={q}"


class NaverCollector:
    source = "naver"

    def __init__(self, fetcher: Any | None = None):
        self._fetcher = fetcher or Fetcher

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        if not group.naver_query:
            return CollectionResult(0, 0, errors=[f"{group.key}: no naver_query"])

        started = perf_counter()
        url = SEARCH_URL.format(q=quote(group.naver_query))
        page = self._fetcher.get(url, impersonate="chrome131", stealthy_headers=True)
        articles = self._parse(page)

        filt = NewsFilter(group)
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []
        inserted = 0

        for art in articles:
            verdict = filt.evaluate(
                title=art["title"], snippet=art.get("snippet", ""),
                published_at=art["published_at_raw"],
            )
            pub = parse_safe(art["published_at_raw"])
            pub_iso = pub.strftime("%Y-%m-%dT00:00:00Z") if pub else None

            statements.append((
                """
                INSERT INTO naver_articles
                  (url_hash, group_key, title, source, url, published_at,
                   is_excluded, exclude_reason, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url_hash) DO UPDATE SET
                  title=excluded.title,
                  is_excluded=excluded.is_excluded,
                  exclude_reason=excluded.exclude_reason
                """.strip(),
                [
                    url_hash(art["url"]),
                    group.key,
                    art["title"][:500],
                    art.get("press") or "",
                    art["url"],
                    pub_iso,
                    0 if verdict.relevant else 1,
                    verdict.reason,
                    now_iso,
                ],
            ))
            inserted += 1

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=inserted, rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )

    @staticmethod
    def _parse(page: Any) -> list[dict[str, str]]:
        """Extract article cards from a Naver search results page.

        The current markup uses `.news_wrap.api_ani_send` (or `.news_area`) per
        article. We tolerate either selector and skip cards missing required
        fields rather than raising.
        """
        out: list[dict[str, str]] = []
        cards = page.css(".news_wrap.api_ani_send") or page.css(".news_area")
        for card in cards:
            try:
                a = card.css_first("a.news_tit") or card.css_first("a.tit")
                if a is None:
                    continue
                title = (a.attrib.get("title") or a.text or "").strip()
                href = a.attrib.get("href", "").strip()
                if not (title and href):
                    continue
                press_node = card.css_first(".press") or card.css_first(".info_group .info")
                press = (press_node.text or "").strip() if press_node else ""
                date_node = card.css_first(".info_group span.info") or card.css_first("span.info")
                pub_raw = (date_node.text or "").strip() if date_node else ""
                snippet_node = card.css_first(".news_dsc")
                snippet = (snippet_node.text or "").strip() if snippet_node else ""
                out.append({
                    "title": title,
                    "url": href,
                    "press": press,
                    "published_at_raw": pub_raw,
                    "snippet": snippet,
                })
            except Exception as e:                  # noqa: BLE001
                log.warning("naver card parse skipped: %s", e)
        return out
```

- [ ] **Step 5: Write the parser test using a fixture**

`worker/tests/unit/test_naver.py`:

```python
from pathlib import Path
from unittest.mock import MagicMock

from scrapling import Fetcher
from scrapling.parser import Adaptor

from idol_sight.collectors.naver import NaverCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE", "버추얼"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def test_parses_naver_search_fixture():
    """Load a captured Naver search HTML and verify article extraction."""
    html = (FIXTURES / "naver_search.html").read_text()
    page = Adaptor(text=html, url="https://search.naver.com/search.naver?where=news")

    fetcher = MagicMock()
    fetcher.get.return_value = page

    collector = NaverCollector(fetcher=fetcher)
    result = collector.collect(_plave())

    fetcher.get.assert_called_once()
    assert result.rows_inserted >= 1
    # Each row corresponds to one INSERT statement.
    assert len(result.statements) == result.rows_inserted
    # Sanity-check the first statement's params.
    first_sql, first_params = result.statements[0]
    assert "naver_articles" in first_sql
    assert first_params[1] == "plave"             # group_key
    assert isinstance(first_params[2], str) and first_params[2]   # title


def test_skips_when_no_naver_query():
    fetcher = MagicMock()
    collector = NaverCollector(fetcher=fetcher)
    g = _plave()
    g_no_q = GroupConfig(**{**g.__dict__, "naver_query": None})
    result = collector.collect(g_no_q)
    fetcher.get.assert_not_called()
    assert result.rows_inserted == 0
    assert any("no naver_query" in e for e in result.errors)
```

- [ ] **Step 6: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_naver.py -v
```

Expected: 2 PASSED. **If `test_parses_naver_search_fixture` fails because the parser found 0 cards, the implementer must verify the fixture HTML's actual class names and update both selector lines in `_parse` (`.news_wrap.api_ani_send`, `.news_area`, `a.news_tit`) accordingly. Selectors must come from the fixture, not from this plan.**

- [ ] **Step 7: Commit**

```bash
git add worker/src/idol_sight/collectors/naver.py \
        worker/src/idol_sight/analysis/__init__.py \
        worker/src/idol_sight/analysis/news_filter.py \
        worker/tests/unit/test_naver.py \
        worker/tests/unit/test_news_filter.py \
        worker/tests/unit/fixtures/naver_search.html
git commit -m "feat(worker): naver collector with NewsFilter (context, date, blacklist)"
```

---

## Task 11: Instiz collector

**Files:**
- Create: `worker/src/idol_sight/collectors/instiz.py`
- Create: `worker/tests/unit/fixtures/instiz_hotlist.html`
- Create: `worker/tests/unit/test_instiz.py`

> **Approach:**
> 1. URL: `https://www.instiz.net/pt/`(hot list — title-search filtered by group's KR name).
> 2. Tier 1 `Fetcher` first; fall back to `StealthyFetcher` if blocked.
> 3. Each row → INSERT into `community_posts` (`platform='instiz'`) + INSERT into `community_post_stats`.

- [ ] **Step 1: Capture fixture HTML**

The implementer browses `https://www.instiz.net/pt/list.php?category=tv&page=1` (or hot list) with the group's name in URL params, saves the HTML, trims to 3-5 posts.

- [ ] **Step 2: Write the test**

`worker/tests/unit/test_instiz.py`:

```python
from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.instiz import InstizCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _isedol() -> GroupConfig:
    return GroupConfig(
        key="isedol", name="ISEDOL", name_kr="이세계아이돌",
        debut_date="2021-12-17",
        yt_channel_id=None, dc_gallery_id="isedol", naver_query="이세계아이돌",
        context_keywords=["이세계아이돌"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def test_parses_instiz_fixture():
    html = (FIXTURES / "instiz_hotlist.html").read_text()
    page = Adaptor(text=html, url="https://www.instiz.net/pt/")
    fetcher = MagicMock()
    fetcher.get.return_value = page

    c = InstizCollector(fetcher=fetcher)
    result = c.collect(_isedol())
    assert result.rows_inserted >= 1
    # Each post creates 2 statements (community_posts INSERT + community_post_stats INSERT).
    assert len(result.statements) == 2 * result.rows_inserted
    # First statement is community_posts, second is community_post_stats.
    sql0, params0 = result.statements[0]
    sql1, params1 = result.statements[1]
    assert "community_posts" in sql0 and "instiz" in params0
    assert "community_post_stats" in sql1
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/collectors/instiz.py`:

```python
"""Instiz hot-list collector.

Each post emits two rows:
- community_posts (metadata, idempotent on url_hash)
- community_post_stats (snapshot row, time-series PK)
"""

from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from scrapling import Fetcher, StealthyFetcher

from idol_sight.collectors.base import CollectionResult, Collector
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe
from idol_sight.utils.url_hash import url_hash

LIST_URL = "https://www.instiz.net/pt/list.php?category=tv&page=1"


class InstizCollector:
    source = "instiz"

    def __init__(self, fetcher: Any | None = None, stealthy: Any | None = None):
        self._fetcher = fetcher or Fetcher
        self._stealthy = stealthy or StealthyFetcher

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        started = perf_counter()
        page = self._fetcher.get(LIST_URL, impersonate="chrome131", stealthy_headers=True)
        rows = self._parse(page)
        # If parse returns nothing, fall back to stealthy fetch.
        if not rows:
            page = self._stealthy.fetch(LIST_URL, headless=True, network_idle=True)
            rows = self._parse(page)

        # Filter to posts whose title mentions a context keyword.
        relevant = [
            r for r in rows
            if any(kw in r["title"] for kw in group.context_keywords)
        ]

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []

        for r in relevant:
            uh = url_hash(r["url"])
            posted = parse_safe(r.get("posted_at_raw", ""))
            posted_iso = posted.strftime("%Y-%m-%dT%H:%M:%SZ") if posted else None
            statements.append((
                """
                INSERT INTO community_posts
                  (url_hash, platform, group_key, title, url, posted_at, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url_hash) DO UPDATE SET
                  title=excluded.title
                """.strip(),
                [uh, "instiz", group.key, r["title"][:500], r["url"], posted_iso, now_iso],
            ))
            statements.append((
                """
                INSERT INTO community_post_stats(url_hash, snapshot_at, views, likes, comments)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(url_hash, snapshot_at) DO UPDATE SET
                  views=excluded.views, likes=excluded.likes, comments=excluded.comments
                """.strip(),
                [uh, now_iso, r.get("views"), r.get("likes"), r.get("comments")],
            ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(relevant), rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )

    @staticmethod
    def _parse(page: Any) -> list[dict[str, Any]]:
        """Extract title/url/views/posted_at from instiz hot list rows."""
        out: list[dict[str, Any]] = []
        for tr in page.css("table tr"):
            link = tr.css_first("td.subject a") or tr.css_first("a.subject")
            if link is None:
                continue
            title = (link.text or "").strip()
            href = link.attrib.get("href", "").strip()
            if not (title and href):
                continue
            if href.startswith("/"):
                href = f"https://www.instiz.net{href}"
            views_node = tr.css_first("td.cnt") or tr.css_first("td.hit")
            date_node = tr.css_first("td.date") or tr.css_first("td.regdate")
            try:
                views = int((views_node.text or "0").replace(",", "")) if views_node else None
            except ValueError:
                views = None
            posted = (date_node.text or "").strip() if date_node else ""
            out.append({
                "title": title, "url": href, "views": views, "posted_at_raw": posted,
            })
        return out
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_instiz.py -v
```

Expected: 1 PASSED. As with naver, if 0 rows are parsed, the implementer must inspect the fixture HTML and adjust selectors in `_parse`.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/collectors/instiz.py \
        worker/tests/unit/fixtures/instiz_hotlist.html \
        worker/tests/unit/test_instiz.py
git commit -m "feat(worker): instiz collector with Tier-1 + Stealthy fallback"
```

---

## Task 12: TheQoo collector

**Files:**
- Create: `worker/src/idol_sight/collectors/theqoo.py`
- Create: `worker/tests/unit/fixtures/theqoo_hotpost.html`
- Create: `worker/tests/unit/test_theqoo.py`

> **Approach:**
> 1. URL: `https://theqoo.net/index.php?mid=hot&category=<cat>` — TheQoo hot post list.
> 2. **StealthyFetcher** (Cloudflare). Tier 2 from start.
> 3. Each post → community_posts + community_post_stats rows (`platform='theqoo'`).

- [ ] **Step 1: Capture fixture**

Same as Instiz, but for TheQoo. URL: `https://theqoo.net/index.php?mid=hot`.

- [ ] **Step 2: Write the test**

`worker/tests/unit/test_theqoo.py`:

```python
from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.theqoo import TheQooCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브", "PLAVE"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def test_parses_theqoo_fixture():
    html = (FIXTURES / "theqoo_hotpost.html").read_text()
    page = Adaptor(text=html, url="https://theqoo.net/hot")
    stealthy = MagicMock()
    stealthy.fetch.return_value = page

    c = TheQooCollector(stealthy=stealthy)
    result = c.collect(_plave())
    stealthy.fetch.assert_called_once()
    assert result.rows_inserted >= 1
    assert len(result.statements) == 2 * result.rows_inserted
    # First INSERT must hit community_posts with platform='theqoo'.
    sql0, params0 = result.statements[0]
    assert "community_posts" in sql0
    assert "theqoo" in params0
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/collectors/theqoo.py`:

```python
"""TheQoo hot-list collector (Cloudflare-protected → StealthyFetcher)."""

from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from scrapling import StealthyFetcher

from idol_sight.collectors.base import CollectionResult, Collector
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe
from idol_sight.utils.url_hash import url_hash

LIST_URL = "https://theqoo.net/index.php?mid=hot"


class TheQooCollector:
    source = "theqoo"

    def __init__(self, stealthy: Any | None = None):
        self._stealthy = stealthy or StealthyFetcher

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        started = perf_counter()
        page = self._stealthy.fetch(
            LIST_URL,
            headless=True, network_idle=True,
            block_resources=True, solve_cloudflare=True,
        )
        rows = self._parse(page)

        relevant = [
            r for r in rows
            if any(kw in r["title"] for kw in group.context_keywords)
        ]

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []

        for r in relevant:
            uh = url_hash(r["url"])
            posted = parse_safe(r.get("posted_at_raw", ""))
            posted_iso = posted.strftime("%Y-%m-%dT%H:%M:%SZ") if posted else None
            statements.append((
                """
                INSERT INTO community_posts
                  (url_hash, platform, group_key, title, url, posted_at, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url_hash) DO UPDATE SET title=excluded.title
                """.strip(),
                [uh, "theqoo", group.key, r["title"][:500], r["url"], posted_iso, now_iso],
            ))
            statements.append((
                """
                INSERT INTO community_post_stats(url_hash, snapshot_at, views, likes, comments)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(url_hash, snapshot_at) DO UPDATE SET
                  views=excluded.views, likes=excluded.likes, comments=excluded.comments
                """.strip(),
                [uh, now_iso, r.get("views"), r.get("likes"), r.get("comments")],
            ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(relevant), rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )

    @staticmethod
    def _parse(page: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for tr in page.css("table.bd_lst tr") or page.css("table tr"):
            a = tr.css_first("td.title a") or tr.css_first("a.hx")
            if a is None:
                continue
            title = (a.text or "").strip()
            href = a.attrib.get("href", "").strip()
            if not (title and href):
                continue
            if href.startswith("/"):
                href = f"https://theqoo.net{href}"
            views_node = tr.css_first("td.m_no") or tr.css_first("td.readNum")
            date_node = tr.css_first("td.time") or tr.css_first("td.date")
            try:
                views = int((views_node.text or "0").replace(",", "")) if views_node else None
            except ValueError:
                views = None
            posted = (date_node.text or "").strip() if date_node else ""
            out.append({"title": title, "url": href, "views": views, "posted_at_raw": posted})
        return out
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_theqoo.py -v
```

Expected: 1 PASSED. Selector adjustment likely needed based on actual fixture.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/collectors/theqoo.py \
        worker/tests/unit/fixtures/theqoo_hotpost.html \
        worker/tests/unit/test_theqoo.py
git commit -m "feat(worker): theqoo collector via StealthyFetcher"
```

---

## Task 13: DC collector

**Files:**
- Create: `worker/src/idol_sight/collectors/dc.py`
- Create: `worker/tests/unit/fixtures/dc_gallery.html`
- Create: `worker/tests/unit/test_dc.py`

> **Approach:**
> 1. URL: `https://gall.dcinside.com/board/lists/?id=<dc_gallery_id>`.
> 2. **StealthyFetcher** (DC blocks aggressively).
> 3. Each row → community_posts + community_post_stats (`platform='dc'`).
> 4. `dc_top_keywords` and `dc_views_dist` are computed in Plan 3 (analysis layer); this task only collects raw posts.

- [ ] **Step 1: Capture fixture**

`https://gall.dcinside.com/board/lists/?id=plave` HTML, trimmed to 3-5 posts.

- [ ] **Step 2: Write the test**

`worker/tests/unit/test_dc.py`:

```python
from pathlib import Path
from unittest.mock import MagicMock

from scrapling.parser import Adaptor

from idol_sight.collectors.dc import DcCollector
from idol_sight.config import GroupConfig

FIXTURES = Path(__file__).parent / "fixtures"


def _plave() -> GroupConfig:
    return GroupConfig(
        key="plave", name="PLAVE", name_kr="플레이브",
        debut_date="2023-03-12",
        yt_channel_id=None, dc_gallery_id="plave", naver_query="플레이브",
        context_keywords=["플레이브"],
        blacklist_phrases=[],
        twitter_handles=[],
    )


def test_parses_dc_fixture():
    html = (FIXTURES / "dc_gallery.html").read_text()
    page = Adaptor(text=html, url="https://gall.dcinside.com/board/lists/?id=plave")
    stealthy = MagicMock()
    stealthy.fetch.return_value = page

    c = DcCollector(stealthy=stealthy)
    result = c.collect(_plave())
    stealthy.fetch.assert_called_once()
    assert result.rows_inserted >= 1
    sql0, params0 = result.statements[0]
    assert "community_posts" in sql0
    assert "dc" in params0
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/collectors/dc.py`:

```python
"""dcinside gallery collector (StealthyFetcher → Cloudflare bypass)."""

from __future__ import annotations

from datetime import datetime, timezone
from time import perf_counter
from typing import Any

from scrapling import StealthyFetcher

from idol_sight.collectors.base import CollectionResult, Collector
from idol_sight.config import GroupConfig
from idol_sight.utils.dates import parse_safe
from idol_sight.utils.url_hash import url_hash

LIST_URL_TPL = "https://gall.dcinside.com/board/lists/?id={gallery_id}"


class DcCollector:
    source = "dc"

    def __init__(self, stealthy: Any | None = None):
        self._stealthy = stealthy or StealthyFetcher

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        if not group.dc_gallery_id:
            return CollectionResult(0, 0, errors=[f"{group.key}: no dc_gallery_id"])

        started = perf_counter()
        url = LIST_URL_TPL.format(gallery_id=group.dc_gallery_id)
        page = self._stealthy.fetch(
            url,
            headless=True, network_idle=True,
            block_resources=True, solve_cloudflare=True,
        )
        rows = self._parse(page)

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []

        for r in rows:
            uh = url_hash(r["url"])
            posted = parse_safe(r.get("posted_at_raw", ""))
            posted_iso = posted.strftime("%Y-%m-%dT%H:%M:%SZ") if posted else None
            statements.append((
                """
                INSERT INTO community_posts
                  (url_hash, platform, group_key, title, url, posted_at, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(url_hash) DO UPDATE SET title=excluded.title
                """.strip(),
                [uh, "dc", group.key, r["title"][:500], r["url"], posted_iso, now_iso],
            ))
            statements.append((
                """
                INSERT INTO community_post_stats(url_hash, snapshot_at, views, likes, comments)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(url_hash, snapshot_at) DO UPDATE SET
                  views=excluded.views, likes=excluded.likes, comments=excluded.comments
                """.strip(),
                [uh, now_iso, r.get("views"), r.get("likes"), r.get("comments")],
            ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(rows), rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )

    @staticmethod
    def _parse(page: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for tr in page.css("table.gall_list tbody tr.us-post"):
            a = tr.css_first("td.gall_tit a")
            if a is None:
                continue
            title = (a.text or "").strip()
            href = a.attrib.get("href", "").strip()
            if not (title and href):
                continue
            if href.startswith("/"):
                href = f"https://gall.dcinside.com{href}"
            views_node = tr.css_first("td.gall_count")
            recommend_node = tr.css_first("td.gall_recommend")
            date_node = tr.css_first("td.gall_date")
            try:
                views = int((views_node.text or "0").replace(",", "")) if views_node else None
            except ValueError:
                views = None
            try:
                likes = int((recommend_node.text or "0").replace(",", "")) if recommend_node else None
            except ValueError:
                likes = None
            posted = (date_node.attrib.get("title") or date_node.text or "").strip() if date_node else ""
            out.append({
                "title": title, "url": href, "views": views, "likes": likes,
                "posted_at_raw": posted,
            })
        return out
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_dc.py -v
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/collectors/dc.py \
        worker/tests/unit/fixtures/dc_gallery.html \
        worker/tests/unit/test_dc.py
git commit -m "feat(worker): dcinside collector via StealthyFetcher"
```

---

## Task 14: agg_summary writer

**Files:**
- Create: `worker/src/idol_sight/analysis/agg_summary.py`
- Create: `worker/tests/unit/test_agg_summary.py`

> **Computes per-group counts** by reading raw_* tables and upserts a snapshot into agg_summary. Idempotent — re-running for the same snapshot_at overwrites the row.

- [ ] **Step 1: Write the test**

`worker/tests/unit/test_agg_summary.py`:

```python
from unittest.mock import MagicMock

from idol_sight.analysis.agg_summary import build_agg_summary


def _client_returning(rows_by_query: dict[str, list[dict]]):
    """Return a mock D1 client whose execute() returns mock rows for matching SQL."""
    client = MagicMock()
    def _execute(sql: str, params: list | None = None):
        for needle, rows in rows_by_query.items():
            if needle in sql:
                return rows
        return []
    client.execute.side_effect = _execute
    return client


def test_build_agg_summary_emits_one_upsert_per_group():
    client = _client_returning({
        # community_posts counts grouped by platform
        "platform": [
            {"group_key": "plave",  "platform": "dc",     "n": 89663},
            {"group_key": "plave",  "platform": "theqoo", "n": 20219},
            {"group_key": "plave",  "platform": "instiz", "n": 35454},
            {"group_key": "isedol", "platform": "dc",     "n": 12500},
        ],
        "naver_articles": [
            {"group_key": "plave",  "n": 282},
            {"group_key": "isedol", "n": 365},
        ],
        "youtube_videos": [
            {"group_key": "plave",  "n_videos": 24, "total_views": 160608883, "subscribers": 1140000},
        ],
        "twitter_posts": [
            {"group_key": "plave", "n": 30, "controversy_count": 0},
        ],
    })

    result = build_agg_summary(client, snapshot_at="2026-05-04T00:00:00Z")

    # One INSERT per group seen across queries.
    statements = result.statements
    upserts = [s for s, _ in statements if "agg_summary" in s and "INSERT" in s.upper()]
    assert len(upserts) == 2   # plave + isedol

    # Find PLAVE row params and verify counts.
    for sql, params in statements:
        if "plave" in params:
            # params order: group_key, snapshot_at, yt_videos, yt_views, yt_subs,
            #               dc_posts, theqoo_posts, instiz_posts, naver, twitter, controversy
            assert params[0] == "plave"
            assert params[1] == "2026-05-04T00:00:00Z"
            assert params[2] == 24
            assert params[3] == 160608883
            assert params[4] == 1140000
            assert params[5] == 89663
            assert params[6] == 20219
            assert params[7] == 35454
            assert params[8] == 282
            assert params[9] == 30
            assert params[10] == 0
            break
    else:
        raise AssertionError("plave row not found in statements")
```

- [ ] **Step 2: Run test to verify FAIL**

```bash
cd worker
uv run pytest tests/unit/test_agg_summary.py -v
```

- [ ] **Step 3: Implement**

`worker/src/idol_sight/analysis/agg_summary.py`:

```python
"""Build per-group daily summary by reading raw_* tables.

Idempotent on (group_key, snapshot_at) — re-running for the same snapshot_at
overwrites. Computes:
- yt_total_videos, yt_total_views, yt_subscribers (from youtube_videos +
  youtube_channel_stats latest row)
- dc_total_posts, theqoo_posts, instiz_posts (from community_posts grouped
  by platform)
- naver_total_news (excluding is_excluded=1)
- twitter_posts, controversy_count (from twitter_posts; controversy = type)
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Protocol

from idol_sight.collectors.base import CollectionResult


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_UPSERT = """
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_total_videos=excluded.yt_total_videos,
  yt_total_views=excluded.yt_total_views,
  yt_subscribers=excluded.yt_subscribers,
  dc_total_posts=excluded.dc_total_posts,
  theqoo_posts=excluded.theqoo_posts,
  instiz_posts=excluded.instiz_posts,
  naver_total_news=excluded.naver_total_news,
  twitter_posts=excluded.twitter_posts,
  controversy_count=excluded.controversy_count
""".strip()


def build_agg_summary(client: _Executor, *, snapshot_at: str) -> CollectionResult:
    # All groups touched across any source.
    counts: dict[str, dict[str, int]] = defaultdict(lambda: {
        "yt_videos": 0, "yt_views": 0, "yt_subs": 0,
        "dc": 0, "theqoo": 0, "instiz": 0,
        "naver": 0, "twitter": 0, "controversy": 0,
    })

    # Community posts by platform.
    rows = client.execute(
        "SELECT group_key, platform, COUNT(*) AS n "
        "FROM community_posts GROUP BY group_key, platform"
    )
    for r in rows:
        gk = r["group_key"]
        if r["platform"] == "dc":
            counts[gk]["dc"] = r["n"]
        elif r["platform"] == "theqoo":
            counts[gk]["theqoo"] = r["n"]
        elif r["platform"] == "instiz":
            counts[gk]["instiz"] = r["n"]

    # Naver articles (relevant only).
    rows = client.execute(
        "SELECT group_key, COUNT(*) AS n FROM naver_articles "
        "WHERE COALESCE(is_excluded,0)=0 GROUP BY group_key"
    )
    for r in rows:
        counts[r["group_key"]]["naver"] = r["n"]

    # Twitter posts (count + controversy subset).
    rows = client.execute(
        "SELECT group_key, COUNT(*) AS n, "
        "  SUM(CASE WHEN type='controversy' THEN 1 ELSE 0 END) AS controversy_count "
        "FROM twitter_posts GROUP BY group_key"
    )
    for r in rows:
        counts[r["group_key"]]["twitter"] = r["n"]
        counts[r["group_key"]]["controversy"] = r.get("controversy_count") or 0

    # YouTube: video count + most-recent stats sum + latest channel subs.
    rows = client.execute(
        "SELECT v.group_key, COUNT(DISTINCT v.video_id) AS n_videos, "
        "  COALESCE(SUM(s.views), 0) AS total_views, "
        "  COALESCE(MAX(c.subscribers), 0) AS subscribers "
        "FROM youtube_videos v "
        "LEFT JOIN youtube_video_stats s "
        "  ON s.video_id = v.video_id AND s.snapshot_at = ("
        "    SELECT MAX(snapshot_at) FROM youtube_video_stats "
        "    WHERE video_id = v.video_id) "
        "LEFT JOIN youtube_channel_stats c "
        "  ON c.channel_id = v.channel_id AND c.snapshot_at = ("
        "    SELECT MAX(snapshot_at) FROM youtube_channel_stats "
        "    WHERE channel_id = v.channel_id) "
        "GROUP BY v.group_key"
    )
    for r in rows:
        counts[r["group_key"]]["yt_videos"] = r["n_videos"]
        counts[r["group_key"]]["yt_views"] = r["total_views"]
        counts[r["group_key"]]["yt_subs"] = r["subscribers"]

    statements: list[tuple[str, list[Any]]] = []
    for gk, c in counts.items():
        statements.append((
            _UPSERT,
            [
                gk, snapshot_at,
                c["yt_videos"], c["yt_views"], c["yt_subs"],
                c["dc"], c["theqoo"], c["instiz"],
                c["naver"], c["twitter"], c["controversy"],
            ],
        ))

    return CollectionResult(
        rows_inserted=len(statements), rows_updated=0,
        statements=statements,
    )
```

- [ ] **Step 4: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_agg_summary.py -v
```

Expected: 1 PASSED.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/agg_summary.py \
        worker/tests/unit/test_agg_summary.py
git commit -m "feat(analysis): build_agg_summary aggregates raw_* into agg_summary"
```

---

## Task 15: CLI integration — `collect` actually does work

**Files:**
- Modify: `worker/src/idol_sight/cli.py`
- Modify: `worker/tests/unit/test_cli.py`

- [ ] **Step 1: Update tests**

Open `worker/tests/unit/test_cli.py` and replace `test_collect_known_source_returns_0` with:

```python
def test_collect_naver_dispatches_orchestrator(monkeypatch):
    """`collect --source naver --group plave` constructs NaverCollector,
    loads GroupConfig from D1, runs orchestrator, and exits 0."""
    from unittest.mock import MagicMock
    import idol_sight.cli as cli

    fake_group = MagicMock(name="GroupConfig", key="plave")
    monkeypatch.setattr(cli, "_load_group", lambda client, key: fake_group)
    monkeypatch.setattr(cli, "_make_d1_client", lambda settings: MagicMock())
    monkeypatch.setattr(cli, "_make_collector",
                        lambda src: MagicMock(source=src))

    fake_summary = MagicMock(status="ok", rows_inserted=10, rows_updated=0,
                             runtime_ms=123, error_msg=None)
    run_called = MagicMock(return_value=fake_summary)
    monkeypatch.setattr(cli, "run_collector", run_called)

    res = runner.invoke(app, ["collect", "--source", "naver", "--group", "plave"])
    assert res.exit_code == 0
    run_called.assert_called_once()


def test_collect_failure_exits_nonzero(monkeypatch):
    from unittest.mock import MagicMock
    import idol_sight.cli as cli

    fake_group = MagicMock(name="GroupConfig", key="plave")
    monkeypatch.setattr(cli, "_load_group", lambda client, key: fake_group)
    monkeypatch.setattr(cli, "_make_d1_client", lambda settings: MagicMock())
    monkeypatch.setattr(cli, "_make_collector",
                        lambda src: MagicMock(source=src))
    fake_summary = MagicMock(status="failed", rows_inserted=0, rows_updated=0,
                             runtime_ms=200, error_msg="cloudflare")
    monkeypatch.setattr(cli, "run_collector", lambda *a, **kw: fake_summary)

    res = runner.invoke(app, ["collect", "--source", "naver", "--group", "plave"])
    assert res.exit_code == 1
```

- [ ] **Step 2: Update `cli.py`**

Replace the `collect` command body with real dispatch:

```python
import json
import logging
import os
import sys
from datetime import datetime, timezone

import typer

from idol_sight.collectors.dc import DcCollector
from idol_sight.collectors.instiz import InstizCollector
from idol_sight.collectors.naver import NaverCollector
from idol_sight.collectors.theqoo import TheQooCollector
from idol_sight.config import GroupConfig, load_settings, Settings
from idol_sight.d1 import D1Client
from idol_sight.notify import notify_failure
from idol_sight.orchestrator import run_collector

app = typer.Typer(no_args_is_help=True, add_completion=False)


KNOWN_SOURCES = {
    "youtube", "naver", "dc", "theqoo", "instiz", "twitter",
    "hanteo", "channel-stats",
}
KNOWN_GROUPS = {
    "plave", "isedol", "stellive", "skinz",
    "myrakl", "miiwan", "owis", "bdawn",
}

# Source → constructor (lazily added per Plan 2/3).
_COLLECTORS = {
    "naver": NaverCollector,
    "instiz": InstizCollector,
    "theqoo": TheQooCollector,
    "dc": DcCollector,
    # 'youtube', 'twitter', 'hanteo', 'channel-stats' arrive in Plan 3.
}

_INTERVALS_H = {
    "naver": 1, "twitter": 1,
    "dc": 6, "theqoo": 6, "instiz": 6, "youtube": 6, "channel-stats": 24,
    "hanteo": 168,
}


def _make_d1_client(settings: Settings) -> D1Client:
    return D1Client(
        account_id=settings.cf_account_id,
        db_id=settings.cf_d1_db_id,
        api_token=settings.cf_api_token,
    )


def _make_collector(source: str):
    cls = _COLLECTORS.get(source)
    if cls is None:
        raise NotImplementedError(f"collector for source {source!r} arrives in a later plan")
    return cls()


def _load_group(client: D1Client, key: str) -> GroupConfig:
    rows = client.execute(
        "SELECT key, name, name_kr, debut_date, yt_channel_id, dc_gallery_id, "
        "  naver_query, context_keywords, blacklist_phrases, twitter_handles "
        "FROM groups WHERE key=? AND is_active=1",
        [key],
    )
    if not rows:
        raise RuntimeError(f"group {key!r} not in D1 or inactive")
    r = rows[0]
    return GroupConfig(
        key=r["key"],
        name=r["name"], name_kr=r["name_kr"],
        debut_date=r.get("debut_date"),
        yt_channel_id=r.get("yt_channel_id"),
        dc_gallery_id=r.get("dc_gallery_id"),
        naver_query=r.get("naver_query"),
        context_keywords=json.loads(r.get("context_keywords") or "[]"),
        blacklist_phrases=json.loads(r.get("blacklist_phrases") or "[]"),
        twitter_handles=json.loads(r.get("twitter_handles") or "[]"),
    )


@app.command(help="Run a collector for one (group, source) pair.")
def collect(
    source: str = typer.Option(..., "--source"),
    group: str = typer.Option(..., "--group"),
) -> None:
    if source not in KNOWN_SOURCES:
        typer.echo(f"unknown source: {source}", err=True)
        raise typer.Exit(code=2)
    if group not in KNOWN_GROUPS:
        typer.echo(f"unknown group: {group}", err=True)
        raise typer.Exit(code=2)

    settings = load_settings()
    client = _make_d1_client(settings)
    grp = _load_group(client, group)
    coll = _make_collector(source)

    summary = run_collector(
        client, coll, grp,
        expected_interval_h=_INTERVALS_H.get(source, 24),
    )

    typer.echo(f"[{summary.job}] status={summary.status} "
               f"inserted={summary.rows_inserted} updated={summary.rows_updated} "
               f"runtime_ms={summary.runtime_ms} "
               f"err={summary.error_msg or ''}")
    raise typer.Exit(code=0 if summary.status == "ok" else 1)


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


@app.command(help="Build agg_summary for the current snapshot.")
def aggregate() -> None:
    from idol_sight.analysis.agg_summary import build_agg_summary
    settings = load_settings()
    client = _make_d1_client(settings)
    snap = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
    result = build_agg_summary(client, snapshot_at=snap)
    if result.statements:
        bs = client.batch(result.statements)
        if bs.statements_executed != bs.statements_sent:
            typer.echo(f"partial agg_summary write: "
                       f"{bs.statements_executed}/{bs.statements_sent}", err=True)
            raise typer.Exit(code=1)
    typer.echo(f"agg_summary upserted {len(result.statements)} groups at {snap}")


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    app()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_cli.py tests/unit -v
```

Expected: all tests pass (existing 22 + new 1 swap → 22 still). Verify `uv run python -m idol_sight --help` shows `collect`, `notify-fail`, `aggregate`.

- [ ] **Step 4: Commit**

```bash
git add worker/src/idol_sight/cli.py worker/tests/unit/test_cli.py
git commit -m "feat(worker): CLI dispatches real collectors via orchestrator + adds aggregate command"
```

---

## Task 16: collect-hourly workflow

**Files:**
- Create: `.github/workflows/collect-hourly.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: collect-hourly
on:
  schedule:
    - cron: '5 * * * *'
  workflow_dispatch:
    inputs:
      groups:
        description: 'comma-separated keys or "all"'
        default: 'all'

jobs:
  collect:
    strategy:
      fail-fast: false
      max-parallel: 4
      matrix:
        group:  [plave, isedol, stellive, skinz, myrakl, miiwan, owis, bdawn]
        source: [naver]
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
        working-directory: worker
      - run: |
          uv run python -m idol_sight collect \
            --source ${{ matrix.source }} \
            --group  ${{ matrix.group }}
        working-directory: worker
        env:
          CF_ACCOUNT_ID:   ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:     ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:    ${{ secrets.CF_API_TOKEN }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
      - if: failure()
        working-directory: worker
        run: |
          uv run python -m idol_sight notify-fail \
            --job '${{ matrix.source }}:${{ matrix.group }}'
        env:
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}

  aggregate:
    needs: collect
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
        working-directory: worker
      - run: uv run python -m idol_sight aggregate
        working-directory: worker
        env:
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:   ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:  ${{ secrets.CF_API_TOKEN }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/collect-hourly.yml
git commit -m "ci: add collect-hourly workflow (naver) with aggregate follow-up"
```

---

## Task 17: collect-6h workflow

**Files:**
- Create: `.github/workflows/collect-6h.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: collect-6h
on:
  schedule:
    - cron: '15 */6 * * *'
  workflow_dispatch:

jobs:
  collect:
    strategy:
      fail-fast: false
      max-parallel: 4
      matrix:
        group:  [plave, isedol, stellive, skinz, myrakl, miiwan, owis, bdawn]
        source: [dc, theqoo, instiz]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
        working-directory: worker
      - run: uv run scrapling install
        working-directory: worker
      - run: |
          uv run python -m idol_sight collect \
            --source ${{ matrix.source }} \
            --group  ${{ matrix.group }}
        working-directory: worker
        env:
          CF_ACCOUNT_ID:   ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:     ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:    ${{ secrets.CF_API_TOKEN }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
      - if: failure()
        working-directory: worker
        run: |
          uv run python -m idol_sight notify-fail \
            --job '${{ matrix.source }}:${{ matrix.group }}'
        env:
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}

  aggregate:
    needs: collect
    if: always()
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
        working-directory: worker
      - run: uv run python -m idol_sight aggregate
        working-directory: worker
        env:
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:   ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:  ${{ secrets.CF_API_TOKEN }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/collect-6h.yml
git commit -m "ci: add collect-6h workflow for community sources"
```

---

## Task 18: health-check workflow

**Files:**
- Create: `.github/workflows/health-check.yml`
- Create: `worker/src/idol_sight/cli_health.py` (a tiny CLI subcommand)
- Modify: `worker/src/idol_sight/cli.py` (register subcommand)
- Create: `worker/tests/unit/test_cli_health.py`

> **Why:** Detects stale/broken jobs by comparing `crawl_meta.last_success_at` against `expected_interval_h * 4`. If anything is broken, post to Discord.

- [ ] **Step 1: Write the test**

`worker/tests/unit/test_cli_health.py`:

```python
from unittest.mock import MagicMock

from idol_sight.cli_health import audit_freshness


def test_audit_returns_stale_jobs():
    rows = [
        {"job": "naver:plave",  "last_success_at": "2026-05-04T07:00:00Z",
         "expected_interval_h": 1},
        {"job": "dc:bdawn",     "last_success_at": "2026-04-01T00:00:00Z",
         "expected_interval_h": 6},
        {"job": "instiz:miiwan", "last_success_at": None,
         "expected_interval_h": 6},
    ]
    client = MagicMock()
    client.execute.return_value = rows
    stale = audit_freshness(client, now_iso="2026-05-04T08:00:00Z")
    # naver:plave is fresh (1h < 4h); dc:bdawn and instiz:miiwan are stale.
    stale_jobs = {s["job"] for s in stale}
    assert stale_jobs == {"dc:bdawn", "instiz:miiwan"}
```

- [ ] **Step 2: Run test, see FAIL**

```bash
cd worker
uv run pytest tests/unit/test_cli_health.py -v
```

- [ ] **Step 3: Implement the audit function**

`worker/src/idol_sight/cli_health.py`:

```python
"""Health-check audit: find jobs whose last_success_at is older than
expected_interval_h * 4. Returns a list of stale-job dicts. The CLI subcommand
in cli.py wraps this and notifies Discord on each."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


def audit_freshness(client: _Executor, *, now_iso: str | None = None) -> list[dict[str, Any]]:
    rows = client.execute(
        "SELECT job, last_success_at, expected_interval_h FROM crawl_meta"
    )
    if now_iso:
        now = datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    else:
        now = datetime.now(timezone.utc)

    stale: list[dict[str, Any]] = []
    for r in rows:
        last = r.get("last_success_at")
        interval_h = r.get("expected_interval_h") or 24
        if not last:
            stale.append({**r, "age_h": None})
            continue
        try:
            last_dt = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
        except ValueError:
            stale.append({**r, "age_h": None})
            continue
        age_h = (now - last_dt).total_seconds() / 3600
        if age_h > interval_h * 4:
            stale.append({**r, "age_h": age_h})
    return stale
```

- [ ] **Step 4: Add a CLI subcommand**

Append to `worker/src/idol_sight/cli.py`:

```python
@app.command("health-check", help="Report jobs whose last_success_at is older than expected_interval * 4.")
def health_check() -> None:
    from idol_sight.cli_health import audit_freshness
    settings = load_settings()
    client = _make_d1_client(settings)
    stale = audit_freshness(client)
    if not stale:
        typer.echo("all jobs fresh")
        return
    webhook = settings.discord_webhook
    for s in stale:
        msg = f"{s['job']}: last_success_at={s.get('last_success_at') or 'never'} (age_h={s.get('age_h')})"
        typer.echo(f"STALE: {msg}", err=True)
        notify_failure(webhook_url=webhook, job=s["job"], error=msg)
    raise typer.Exit(code=1)
```

- [ ] **Step 5: Create the workflow**

`.github/workflows/health-check.yml`:

```yaml
name: health-check
on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv sync --frozen
        working-directory: worker
      - run: uv run python -m idol_sight health-check
        working-directory: worker
        env:
          CF_ACCOUNT_ID:   ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:     ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:    ${{ secrets.CF_API_TOKEN }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
```

- [ ] **Step 6: Run tests**

```bash
cd worker
uv run pytest tests/unit/test_cli_health.py tests/unit/test_cli.py -v
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add worker/src/idol_sight/cli_health.py worker/src/idol_sight/cli.py \
        worker/tests/unit/test_cli_health.py \
        .github/workflows/health-check.yml
git commit -m "feat(worker+ci): health-check audit subcommand and hourly workflow"
```

---

## Final Verification

- [ ] **Step 1: Run full local check**

```bash
( cd worker && uv run ruff check && uv run pyright && uv run pytest -v )
```

Expected: all green.

- [ ] **Step 2: Inspect commit log**

```bash
git log --oneline | head -25
```

Expected: ~18 new commits on top of Plan 1's history.

---

## Out of Scope (deferred to Plan 3)

- YouTube Data API v3 collector + channel-stats collector
- Twitter (nitter mirror + oembed fallback)
- Hanteo weekly collector
- analysis/health_score.py, analysis/market_share.py, analysis/member_popularity.py
- LLM insights via Gemini
- DC keywords / views distribution analysis
- analyze-weekly.yml workflow
