# Backfill Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `backfill-yt-videos` 단일 60min timeout 사고를 3-layer 방어(matrix per-group / CLI checkpoint / health-check alert)로 자동 복원·가시화.

**Architecture:** (1) `.github/workflows/backfill-yt-videos.yml`을 matrix per-group으로 재작성하여 그룹별 격리 + max-parallel=3로 D1 429 회피. (2) `groups.last_backfilled_at` 컬럼 + `--force`/`--fresh-days` CLI 옵션으로 재실행 시 신선한 그룹 자동 skip. (3) `audit_freshness`에 14일+ stale 그룹 알림 추가.

**Tech Stack:** SQLite/D1 SQL · Python 3.12 + Typer · GitHub Actions matrix · pytest.

**Reference spec:** `docs/superpowers/specs/2026-05-12-backfill-resilience-design.md`

---

## File Structure

| 경로 | 분류 | 책임 |
|---|---|---|
| `migrations/0053_backfill_checkpoint.sql` | new | `groups.last_backfilled_at TEXT` 컬럼 추가 |
| `worker/src/idol_sight/cli.py` | modify | `backfill_yt_videos_cmd`에 `--force`, `--fresh-days` 옵션 + freshness 필터 + 그룹 완료 시 UPDATE |
| `worker/tests/unit/test_cli_backfill.py` | new | freshness 필터 / --force / UPDATE 동작 단위 테스트 |
| `worker/src/idol_sight/cli_health.py` | modify | `audit_freshness`에 backfill staleness (14일+) 추가 |
| `worker/tests/unit/test_cli_health.py` | modify | backfill stale 케이스 추가 |
| `.github/workflows/backfill-yt-videos.yml` | rewrite | matrix per-group, max-parallel=3, 30min/group, force input |
| `docs/onboarding.md` | modify | V2.21 백필 운영 절차 추가 |

---

## Task 1: DB 마이그레이션

**Files:**
- Create: `migrations/0053_backfill_checkpoint.sql`

- [ ] **Step 1: Write the migration SQL**

`migrations/0053_backfill_checkpoint.sql`:
```sql
-- 0053_backfill_checkpoint.sql
--
-- backfill-yt-videos 완료 시점 추적. matrix workflow의 그룹 단위 성공 시
-- UPDATE. CLI의 freshness 필터(기본 7일)가 이 컬럼을 읽어 최근 완료된
-- 그룹은 skip한다. health-check도 14일+ stale 그룹을 알림.
--
-- 기존 행은 NULL → 첫 실행 시 자동으로 walk 대상에 포함.

ALTER TABLE groups ADD COLUMN last_backfilled_at TEXT;
```

- [ ] **Step 2: Apply migration locally**

Run:
```bash
cd /Users/user/Desktop/idol-sight/frontend && wrangler d1 migrations apply idol-sight --local
```
Expected: `0053_backfill_checkpoint.sql` applied successfully.

- [ ] **Step 3: Verify column exists**

Run:
```bash
cd /Users/user/Desktop/idol-sight/frontend && wrangler d1 execute idol-sight --local --command="PRAGMA table_info(groups)" | grep last_backfilled_at
```
Expected: one row showing `last_backfilled_at TEXT` column.

- [ ] **Step 4: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add migrations/0053_backfill_checkpoint.sql
git commit -m "feat(db): 0053 backfill checkpoint column on groups"
```

---

## Task 2: CLI — `--fresh-days` skips fresh groups (TDD)

**Files:**
- Create: `worker/tests/unit/test_cli_backfill.py`
- Modify: `worker/src/idol_sight/cli.py` (backfill_yt_videos_cmd)

- [ ] **Step 1: Write the failing test**

`worker/tests/unit/test_cli_backfill.py`:
```python
"""Tests for backfill_yt_videos_cmd freshness filter + checkpoint UPDATE.

The CLI is wrapped in a typer command; we test its core filter logic via a
helper extracted from the command. The helper takes the candidate targets +
a fresh-set query result and returns the filtered list.
"""

import pytest

from idol_sight.cli import _filter_fresh_groups


def test_filter_fresh_groups_drops_groups_within_window():
    """Groups whose last_backfilled_at is within fresh_days are skipped."""
    candidates = ["plave", "isedol", "miiwan", "owis"]
    # plave + isedol returned by D1 as "recently backfilled"
    fresh_keys = {"plave", "isedol"}
    result = _filter_fresh_groups(candidates, fresh_keys)
    assert result == ["miiwan", "owis"]


def test_filter_fresh_groups_returns_all_when_none_fresh():
    """No fresh keys → walk everyone."""
    candidates = ["plave", "isedol"]
    fresh_keys = set()
    assert _filter_fresh_groups(candidates, fresh_keys) == ["plave", "isedol"]


def test_filter_fresh_groups_preserves_order():
    """Output order matches input order (sorted KNOWN_GROUPS)."""
    candidates = ["bdawn", "isedol", "miiwan", "myrakl"]
    fresh_keys = {"miiwan"}
    assert _filter_fresh_groups(candidates, fresh_keys) == ["bdawn", "isedol", "myrakl"]
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_cli_backfill.py -v
```
Expected: ImportError on `_filter_fresh_groups`.

- [ ] **Step 3: Write the helper in cli.py**

Add to `worker/src/idol_sight/cli.py` (place near `backfill_yt_videos_cmd`, before its definition):

```python
def _filter_fresh_groups(
    candidates: list[str], fresh_keys: set[str],
) -> list[str]:
    """Return candidates with any group in fresh_keys removed.

    Preserves input order. Used by ``backfill-yt-videos`` to skip groups
    whose ``last_backfilled_at`` is within the freshness window.
    """
    return [g for g in candidates if g not in fresh_keys]
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_cli_backfill.py -v
```
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add worker/src/idol_sight/cli.py worker/tests/unit/test_cli_backfill.py
git commit -m "feat(cli): _filter_fresh_groups helper for backfill freshness"
```

---

## Task 3: CLI — `backfill_yt_videos_cmd` adds `--force` / `--fresh-days` + UPDATE

**Files:**
- Modify: `worker/src/idol_sight/cli.py:backfill_yt_videos_cmd` (around line 429)
- Modify: `worker/tests/unit/test_cli_backfill.py`

- [ ] **Step 1: Locate the existing function**

In `worker/src/idol_sight/cli.py`, find the existing `backfill_yt_videos_cmd` function (around line 429). It currently looks like:

```python
@app.command(
    "backfill-yt-videos",
    help="...",
)
def backfill_yt_videos_cmd(
    group: str | None = typer.Option(
        None, "--group",
        help="Single group key ...",
    ),
) -> None:
    ...
    if group:
        targets = [group]
    else:
        targets = sorted(KNOWN_GROUPS)
    ...
    for group_key in targets:
        grp = _load_group(client, group_key)
        ...
        result = coll.collect(grp, full_history=True)
        ...
        if result.statements:
            client.batch(result.statements)
        ...
```

- [ ] **Step 2: Write failing test for force + freshness behavior**

Append to `worker/tests/unit/test_cli_backfill.py`:

```python
from unittest.mock import MagicMock, patch

from idol_sight.cli import _resolve_backfill_targets


def test_resolve_backfill_targets_single_group_ignores_freshness():
    """When --group is given, freshness filter is bypassed (explicit intent)."""
    client = MagicMock()
    result = _resolve_backfill_targets(
        client, group="isedol", force=False, fresh_days=7,
    )
    assert result == ["isedol"]
    # No DB query for freshness in single-group mode
    client.execute.assert_not_called()


def test_resolve_backfill_targets_all_groups_force_bypasses_freshness():
    """--force walks every group, no freshness query."""
    client = MagicMock()
    result = _resolve_backfill_targets(
        client, group=None, force=True, fresh_days=7,
    )
    assert result == sorted(["plave", "isedol", "stellive", "skinz",
                              "myrakl", "miiwan", "owis", "bdawn", "wegosix"])
    client.execute.assert_not_called()


def test_resolve_backfill_targets_all_groups_freshness_filters():
    """Default mode (no group, no force, fresh_days>0) queries DB and
    skips fresh groups."""
    client = MagicMock()
    client.execute.return_value = [{"key": "isedol"}, {"key": "plave"}]
    result = _resolve_backfill_targets(
        client, group=None, force=False, fresh_days=7,
    )
    assert "isedol" not in result
    assert "plave" not in result
    assert "miiwan" in result
    # Verify the freshness query was issued
    assert client.execute.called
    call_sql = client.execute.call_args[0][0]
    assert "last_backfilled_at" in call_sql
    assert "julianday" in call_sql


def test_resolve_backfill_targets_fresh_days_zero_means_walk_all():
    """fresh_days=0 means 'no skip', same effect as --force."""
    client = MagicMock()
    result = _resolve_backfill_targets(
        client, group=None, force=False, fresh_days=0,
    )
    assert len(result) == 9
    client.execute.assert_not_called()
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_cli_backfill.py -v
```
Expected: ImportError on `_resolve_backfill_targets` for the 4 new tests.

- [ ] **Step 4: Implement `_resolve_backfill_targets` in cli.py**

Add to `worker/src/idol_sight/cli.py` (near `_filter_fresh_groups`, before `backfill_yt_videos_cmd`):

```python
def _resolve_backfill_targets(
    client, *, group: str | None, force: bool, fresh_days: int,
) -> list[str]:
    """Decide which group keys this backfill run should walk.

    - ``group`` explicit → just that group (freshness ignored — explicit intent)
    - ``group=None`` + ``force=True`` → every KNOWN_GROUPS
    - ``group=None`` + ``fresh_days <= 0`` → every KNOWN_GROUPS
    - ``group=None`` + ``fresh_days > 0`` → KNOWN_GROUPS minus rows whose
      ``groups.last_backfilled_at`` is within the freshness window
    """
    if group:
        return [group]
    candidates = sorted(KNOWN_GROUPS)
    if force or fresh_days <= 0:
        return candidates
    fresh_rows = client.execute(
        "SELECT key FROM groups "
        "WHERE last_backfilled_at IS NOT NULL "
        "  AND julianday('now') - julianday(last_backfilled_at) < ?",
        [fresh_days],
    )
    fresh_keys = {r["key"] for r in fresh_rows}
    return _filter_fresh_groups(candidates, fresh_keys)
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_cli_backfill.py -v
```
Expected: 7 PASS (3 from Task 2 + 4 new).

- [ ] **Step 6: Wire the new options into `backfill_yt_videos_cmd`**

Replace the existing `backfill_yt_videos_cmd` definition in `worker/src/idol_sight/cli.py` with:

```python
@app.command(
    "backfill-yt-videos",
    help="One-shot full-history walk of every active group's YouTube "
         "channel(s). Uses playlistItems.list paginated against the "
         "channel's uploads playlist (1 quota unit per page) to reach "
         "every video the channel ever posted, not just the latest 50. "
         "Run once per major group set or after schema changes; "
         "subsequent daily collect runs only top up new uploads. "
         "Default skips groups backfilled within --fresh-days (7); use "
         "--force or an explicit --group to bypass.",
)
def backfill_yt_videos_cmd(
    group: str | None = typer.Option(
        None, "--group",
        help="Single group key (e.g. 'isedol'). Bypasses freshness "
             "filter — explicit intent wins. Omit to walk every "
             "group in KNOWN_GROUPS filtered by --fresh-days.",
    ),
    force: bool = typer.Option(
        False, "--force",
        help="Skip the freshness check — walk all targets regardless "
             "of last_backfilled_at. Use when seed corrections require "
             "full re-walk.",
    ),
    fresh_days: int = typer.Option(
        7, "--fresh-days",
        help="Skip groups whose last_backfilled_at is within this "
             "many days. Default 7. Use 0 to walk everything (same as --force).",
    ),
) -> None:
    from idol_sight.collectors.youtube import YouTubeCollector

    settings = load_settings()
    client = _make_d1_client(settings)
    api_key = settings.yt_api_key
    if not api_key:
        typer.echo("YT_API_KEY not set", err=True)
        raise typer.Exit(code=2)

    def _members(group_key: str) -> list[dict[str, Any]]:
        rows = client.execute(
            "SELECT yt_channel_id FROM members "
            " WHERE group_key=? AND yt_channel_id IS NOT NULL "
            "   AND COALESCE(active, 1) = 1",
            [group_key],
        )
        return [{"yt_channel_id": r["yt_channel_id"]} for r in rows]

    if group and group not in KNOWN_GROUPS:
        typer.echo(f"unknown group: {group}", err=True)
        raise typer.Exit(code=2)

    targets = _resolve_backfill_targets(
        client, group=group, force=force, fresh_days=fresh_days,
    )
    if not targets:
        typer.echo(f"all groups fresh (< {fresh_days}d); nothing to backfill")
        return

    typer.echo(f"backfill targets: {', '.join(targets)}")

    coll = YouTubeCollector(api_key, members_loader=_members)
    total_videos = 0
    total_groups = 0
    errors: list[str] = []
    for group_key in targets:
        grp = _load_group(client, group_key)
        if not grp.yt_channel_id:
            continue
        try:
            result = coll.collect(grp, full_history=True)
        except Exception as exc:
            errors.append(f"{group_key}: {exc}")
            typer.echo(f"[{group_key}] FAIL: {exc}", err=True)
            continue
        if result.statements:
            client.batch(result.statements)
        # Mark this group as backfilled (idempotent — re-runs just
        # advance the timestamp).
        client.execute(
            "UPDATE groups SET last_backfilled_at=? WHERE key=?",
            [datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), group_key],
        )
        total_videos += result.rows_inserted
        total_groups += 1
        typer.echo(
            f"[{group_key}] {result.rows_inserted} videos walked "
            f"({result.runtime_ms} ms)"
        )
    typer.echo(
        f"backfill-yt-videos: {total_groups} groups, "
        f"{total_videos} total videos written"
    )
    if errors:
        typer.echo(f"errors: {errors}", err=True)
        raise typer.Exit(code=1)
```

- [ ] **Step 7: Run full test suite**

Run:
```bash
cd /Users/user/Desktop/idol-sight/worker && uv run pytest
```
Expected: All tests pass (including the 7 new test_cli_backfill tests).

- [ ] **Step 8: Run lint**

Run:
```bash
cd /Users/user/Desktop/idol-sight/worker && uv run ruff check src tests
```
Expected: `All checks passed!`.

- [ ] **Step 9: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add worker/src/idol_sight/cli.py worker/tests/unit/test_cli_backfill.py
git commit -m "feat(cli): backfill --force/--fresh-days + checkpoint UPDATE on success"
```

---

## Task 4: Workflow — matrix per-group rewrite

**Files:**
- Rewrite: `.github/workflows/backfill-yt-videos.yml`

- [ ] **Step 1: Read the current file**

Open `.github/workflows/backfill-yt-videos.yml` and confirm it currently is a single-job workflow with `if [ "${{ inputs.group }}" = "all" ]; then ... else ...` branching inside one step.

- [ ] **Step 2: Rewrite as matrix per-group**

Replace the file contents with:

```yaml
name: backfill-yt-videos
# One-shot full-history walk per group. Matrix per-group so a single
# group's timeout doesn't block the others. Default freshness filter in
# the CLI skips groups backfilled within 7 days; --force/checkbox bypasses.
on:
  workflow_dispatch:
    inputs:
      group:
        description: 'Single group key (e.g. isedol) — or "all" for every group'
        default: 'all'
        required: false
      force:
        description: 'Skip freshness filter (walk all targets)'
        type: boolean
        default: false

jobs:
  backfill:
    strategy:
      fail-fast: false
      # collect-hourly/daily와 동일 패턴. D1 _load_group 의 cold-start
      # 429 (Too Many Requests) 를 회피하려면 동시 3개 이하가 안전.
      max-parallel: 3
      matrix:
        group: [bdawn, isedol, miiwan, myrakl, owis, plave, skinz, stellive, wegosix]
    # 그룹당 30분. stellive 의 멤버 솔로 채널 합산 worst case 도 ~15분 →
    # 2배 여유. 단일 그룹 timeout 이 다른 8개 job 에 영향 안 함.
    timeout-minutes: 30
    # workflow_dispatch 의 group 입력이 'all'/공백 이면 모든 matrix 그룹
    # 실행, 특정 그룹이면 해당 matrix 슬롯만 실행 (나머지는 if 로 skipped).
    if: ${{ inputs.group == 'all' || inputs.group == '' || matrix.group == inputs.group }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: astral-sh/setup-uv@v7
      - run: uv sync --frozen
        working-directory: worker
      - name: Backfill ${{ matrix.group }}
        run: |
          uv run python -m idol_sight backfill-yt-videos \
            --group ${{ matrix.group }} \
            ${{ inputs.force == true && '--force' || '' }}
        working-directory: worker
        env:
          CF_ACCOUNT_ID:   ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:     ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:    ${{ secrets.CF_API_TOKEN }}
          YT_API_KEY:      ${{ secrets.YT_API_KEY }}
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
      - if: failure()
        working-directory: worker
        run: |
          uv run python -m idol_sight notify-fail --job 'backfill:${{ matrix.group }}'
        env:
          DISCORD_WEBHOOK: ${{ secrets.DISCORD_WEBHOOK }}
```

- [ ] **Step 3: Verify YAML syntax**

Run:
```bash
cd /Users/user/Desktop/idol-sight && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/backfill-yt-videos.yml'))"
```
Expected: no output (= valid YAML). If `yaml` module missing, install with `pip install pyyaml` or use `yamllint`.

- [ ] **Step 4: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add .github/workflows/backfill-yt-videos.yml
git commit -m "feat(ci): backfill-yt-videos matrix per-group + force toggle"
```

---

## Task 5: Health-check — `audit_freshness` adds backfill staleness (TDD)

**Files:**
- Modify: `worker/src/idol_sight/cli_health.py`
- Modify: `worker/tests/unit/test_cli_health.py`

- [ ] **Step 1: Read the existing test pattern**

`worker/tests/unit/test_cli_health.py` already has `test_audit_returns_stale_jobs`. It uses `MagicMock()` with `client.execute.return_value = rows` (single return value).

The extension needs to handle TWO different queries from `audit_freshness`: the existing crawl_meta query AND a new groups query. Use `side_effect` for sequenced responses.

- [ ] **Step 2: Write failing test**

Replace the existing test in `worker/tests/unit/test_cli_health.py` with this expanded version (keep the existing test, add a new one):

```python
from unittest.mock import MagicMock

from idol_sight.cli_health import audit_freshness


def test_audit_returns_stale_jobs():
    """Existing crawl_meta freshness behavior unchanged."""
    crawl_rows = [
        {"job": "naver:plave",   "last_success_at": "2026-05-04T07:00:00Z",
         "expected_interval_h": 1},
        {"job": "dc:bdawn",      "last_success_at": "2026-04-01T00:00:00Z",
         "expected_interval_h": 6},
        {"job": "instiz:miiwan", "last_success_at": None,
         "expected_interval_h": 6},
    ]
    client = MagicMock()
    # First call: crawl_meta SELECT (existing). Second call: groups
    # SELECT for backfill staleness (new — return empty so we don't
    # cross-contaminate this test).
    client.execute.side_effect = [crawl_rows, []]
    stale = audit_freshness(client, now_iso="2026-05-04T08:00:00Z")
    stale_jobs = {s["job"] for s in stale}
    # naver:plave is fresh (1h < 4h); dc:bdawn and instiz:miiwan stale.
    assert stale_jobs == {"dc:bdawn", "instiz:miiwan"}


def test_audit_flags_backfill_stale_groups():
    """Groups whose last_backfilled_at is None or older than 14 days
    show up as 'backfill:<group>' stale entries."""
    crawl_rows = []  # no crawl jobs stale
    # Three groups: one fresh (3d), one stale (20d), one never backfilled.
    backfill_rows = [
        {"key": "stellive", "last_backfilled_at": "2026-04-22T00:00:00Z"},  # 20d → stale
        {"key": "bdawn",    "last_backfilled_at": None},                      # never → stale
    ]
    client = MagicMock()
    client.execute.side_effect = [crawl_rows, backfill_rows]
    stale = audit_freshness(client, now_iso="2026-05-12T00:00:00Z")
    stale_jobs = {s["job"] for s in stale}
    assert stale_jobs == {"backfill:stellive", "backfill:bdawn"}
    # backfill entries have age_h where computable
    by_job = {s["job"]: s for s in stale}
    assert by_job["backfill:stellive"]["age_h"] is not None
    assert by_job["backfill:stellive"]["age_h"] > 14 * 24  # > 14 days in hours
    assert by_job["backfill:bdawn"]["age_h"] is None         # NULL → unknown age
```

- [ ] **Step 3: Run test to verify the new one fails**

Run:
```bash
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_cli_health.py -v
```
Expected: existing `test_audit_returns_stale_jobs` may fail because of the `side_effect` change adding a 2nd return value (the function doesn't yet query for backfill). `test_audit_flags_backfill_stale_groups` fails because the function doesn't return backfill entries yet.

- [ ] **Step 4: Extend `audit_freshness`**

Replace the body of `audit_freshness` in `worker/src/idol_sight/cli_health.py` with:

```python
def audit_freshness(client: _Executor, *, now_iso: str | None = None) -> list[dict[str, Any]]:
    rows = client.execute(
        "SELECT job, last_success_at, expected_interval_h FROM crawl_meta"
    )
    now = (
        datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
        if now_iso else datetime.now(UTC)
    )

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

    # V2.21: backfill staleness — groups whose last_backfilled_at is
    # NULL or older than BACKFILL_ALERT_DAYS surface as 'backfill:<group>'
    # entries so the operator gets the same Discord ping channel.
    BACKFILL_ALERT_DAYS = 14
    backfill_rows = client.execute(
        "SELECT key, last_backfilled_at FROM groups "
        "WHERE COALESCE(is_active, 1) = 1 "
        "  AND (last_backfilled_at IS NULL "
        "       OR julianday(?) - julianday(last_backfilled_at) > ?)",
        [now.strftime("%Y-%m-%dT%H:%M:%SZ"), BACKFILL_ALERT_DAYS],
    )
    for r in backfill_rows:
        last_bf = r.get("last_backfilled_at")
        if not last_bf:
            age_h: float | None = None
        else:
            try:
                last_dt = datetime.fromisoformat(str(last_bf).replace("Z", "+00:00"))
                age_h = (now - last_dt).total_seconds() / 3600
            except ValueError:
                age_h = None
        stale.append({
            "job": f"backfill:{r['key']}",
            "last_success_at": last_bf,
            "expected_interval_h": BACKFILL_ALERT_DAYS * 24,
            "age_h": age_h,
        })

    return stale
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_cli_health.py -v
```
Expected: 2 PASS.

- [ ] **Step 6: Run full test suite**

Run:
```bash
cd /Users/user/Desktop/idol-sight/worker && uv run pytest
```
Expected: all tests pass.

- [ ] **Step 7: Lint**

Run:
```bash
cd /Users/user/Desktop/idol-sight/worker && uv run ruff check src tests
```
Expected: `All checks passed!`.

- [ ] **Step 8: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add worker/src/idol_sight/cli_health.py worker/tests/unit/test_cli_health.py
git commit -m "feat(health): backfill staleness alert at 14d via audit_freshness"
```

---

## Task 6: Documentation — onboarding runbook

**Files:**
- Modify: `docs/onboarding.md`

- [ ] **Step 1: Append a new section**

Append at the end of `docs/onboarding.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add docs/onboarding.md
git commit -m "chore(docs): V2.21 backfill resilience runbook"
```

---

## Task 7: 최종 검증 — PR 생성 + CI 통과

**Files:**
- (no new files)

- [ ] **Step 1: Push the feature branch**

```bash
cd /Users/user/Desktop/idol-sight && git push -u origin <feature-branch>
```
(Replace `<feature-branch>` with the actual branch name, e.g. `feat/backfill-resilience`.)

- [ ] **Step 2: Create PR**

```bash
gh pr create --title "feat: backfill resilience — matrix + checkpoint + health alert" --body "$(cat <<'EOF'
## Summary

backfill-yt-videos 워크플로가 60min timeout으로 부분 실패할 때 자동 복원
하는 3-layer 방어. 2026-05-12 사고 (9그룹 중 5만 완료 후 cancelled) 대응.

## Changes

- **Layer 1 (workflow)**: matrix per-group, max-parallel=3, 30min/group.
  단일 그룹 timeout이 다른 8개 차단 안 함.
- **Layer 2 (CLI)**: `groups.last_backfilled_at` 컬럼 + `--fresh-days 7`
  freshness 필터 + `--force` 옵션. 재실행 시 미완료 그룹만 자동 walk.
- **Layer 3 (health)**: 14일+ stale 그룹을 audit_freshness가 Discord
  알림 채널로 통지.

## Spec / Plan

- 설계: [`docs/superpowers/specs/2026-05-12-backfill-resilience-design.md`](docs/superpowers/specs/2026-05-12-backfill-resilience-design.md)
- 계획: [`docs/superpowers/plans/2026-05-12-backfill-resilience.md`](docs/superpowers/plans/2026-05-12-backfill-resilience.md)

## Test plan

- [x] Migration 로컬 적용 검증
- [x] Worker 단위 테스트 통과 (test_cli_backfill 7 신규 + test_cli_health 2)
- [x] Ruff lint clean
- [x] YAML 문법 검증
- [ ] PR 머지 후 `migrate.yml` 실행으로 원격 D1에 0053 적용
- [ ] PR 머지 후 `backfill-yt-videos` workflow_dispatch (`group=miiwan`)으로
      matrix 동작 + UPDATE 동작 1그룹 검증
- [ ] 검증 후 `group=all`로 풀 dispatch 가능 확인

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for CI**

Watch:
```bash
gh pr checks --watch
```
Expected: worker (ruff + pyright + pytest) + frontend (typecheck/test/build) all green.

- [ ] **Step 4: (Reviewer step) request final code review**

Per superpowers:subagent-driven-development convention, dispatch a final reviewer subagent for the entire branch before squash-merge. Reviewer should check:
- YAML matrix syntax + `if:` condition behavior
- Freshness filter SQL correctness (julianday on TEXT column)
- `audit_freshness` regression: existing crawl_meta path unchanged
- `__all__` exports still consistent
- No `--no-verify` or git hook bypass

- [ ] **Step 5: Merge after approval**

```bash
gh pr merge <PR#> --squash --delete-branch
```

- [ ] **Step 6: Apply migration to production D1**

```bash
gh workflow run migrate.yml -f target=remote
```
Wait for success.

- [ ] **Step 7: Smoke test the new workflow**

Dispatch a single-group scoped run:
```bash
gh workflow run backfill-yt-videos.yml -f group=miiwan -f force=false
```
- Verify: 9 matrix jobs spawn, 8 are immediately skipped (the `if` condition), only miiwan runs and completes.
- After success, verify D1: `last_backfilled_at` for miiwan is updated to the run timestamp.

- [ ] **Step 8: Verify health-check sees fresh data**

Trigger the health-check workflow (or wait for its next scheduled run). The `backfill:*` entries for the 8 groups whose `last_backfilled_at` was NOT just updated should appear in stale list ONLY if their previous backfill is more than 14 days old. Currently (2026-05-12, after today's deployment which set all 9 groups via the previous backfill), none should be stale yet — the 14d clock starts now.

---

## Self-Review

**Spec coverage:**
- §1 Problem: addressed by all tasks
- §2 Architecture (3 layers): Task 4 = Layer 1, Task 3 = Layer 2, Task 5 = Layer 3 ✓
- §3 DB Migration: Task 1 ✓
- §4 CLI changes: Tasks 2-3 ✓
- §5 Workflow changes: Task 4 ✓
- §6 Health-check integration: Task 5 ✓
- §7 Implementation phases: aligns with Tasks 1-6, Task 7 covers PR + post-merge verification
- §8 Policies (7d freshness, 14d alert, max-parallel=3, 30min/group): all encoded in Tasks 3, 4, 5
- §9 Risks: noted in spec, surfaces in Task 7 verification steps
- §10 v1.1 follow-ups: deliberately deferred, not in this plan

**Placeholders:** none — all code blocks are complete and copy-paste-able.

**Type consistency:**
- `_filter_fresh_groups(candidates: list[str], fresh_keys: set[str]) -> list[str]` consistent across Tasks 2 & 3
- `_resolve_backfill_targets(client, *, group, force, fresh_days) -> list[str]` consistent across Tasks 3 (defined and tested)
- `audit_freshness` signature unchanged (positional client + keyword now_iso)
- `BACKFILL_ALERT_DAYS = 14` matches spec §8 (14일 alert)
- `--fresh-days 7` matches spec §8 (7일 freshness)
- Matrix groups in Task 4 hardcoded list `[bdawn, isedol, miiwan, myrakl, owis, plave, skinz, stellive, wegosix]` matches KNOWN_GROUPS in cli.py (alphabetical)
- Workflow `if:` uses `inputs.group == 'all' || ... || matrix.group == inputs.group` — matches spec §5
