# Backfill Resilience — matrix + checkpoint + health-check 설계서

**작성일**: 2026-05-12
**대상 버전**: V2.21 (가칭)
**배경**: 오늘(2026-05-12) `backfill-yt-videos.yml` (group=all) 1회 실행이 60분 timeout에서 cancelled되어 9그룹 중 5그룹만 완료. 남은 4그룹은 수동으로 scoped 실행하여 복구. 향후 동일 사고 자동 복원하기 위한 시스템.

---

## §1 Problem

현재 `backfill-yt-videos.yml`은 단일 job 안에서 9그룹을 순차 처리한다.

**문제:**
- 단일 60-min timeout: 한 그룹(특히 isedol/stellive — 멤버 솔로 채널 합산)이 페이지네이션에 오래 걸리면 후속 그룹이 모두 실행 못 함
- 자동 복원 없음: timeout 후 사람이 로그 보고 완료/미완료 그룹 식별해서 수동 dispatch
- 어떤 그룹의 백필이 stale한지 가시화 안 됨 (collect-daily의 health-check은 last_success_at만 추적하고 백필 freshness는 추적 안 함)

**Goal:**
1. 단일 그룹 timeout이 다른 그룹 실행을 막지 않도록 격리
2. 부분 실패 후 재실행이 quota 낭비 없이 남은 그룹만 처리하도록 checkpoint
3. 백필이 N일 이상 stale한 그룹을 자동으로 식별·알림

---

## §2 Architecture

3-layer 방어:

```
Layer 1 — Workflow (격리)
  matrix per-group, max-parallel=3, timeout=30min/group
  → 한 그룹 실패가 다른 그룹 차단 안 함

Layer 2 — CLI (체크포인트)
  groups.last_backfilled_at 컬럼 + freshness 7일 필터
  → 재실행 시 미완료 그룹만 자동 walk

Layer 3 — Health-check (알림)
  audit_freshness에 backfill staleness 검사 추가
  → 14일+ stale 그룹 발견 시 Discord 알림
```

각 layer 독립 작동. Layer 1만으로도 단일 timeout 면역, Layer 2 추가로 quota 절감, Layer 3 추가로 사고 가시화.

---

## §3 DB 마이그레이션

`migrations/0053_backfill_checkpoint.sql`:

```sql
-- 0053_backfill_checkpoint.sql
--
-- backfill-yt-videos 완료 시점 추적 컬럼. matrix workflow의 그룹 단위
-- 성공 시 UPDATE. CLI의 freshness 필터(기본 7일)가 이 컬럼을 읽어
-- 최근 완료된 그룹은 skip한다. health-check도 14일+ stale 그룹을 알림.

ALTER TABLE groups ADD COLUMN last_backfilled_at TEXT;

-- 기존 행은 NULL → 첫 실행 시 자동으로 walk 대상 포함
```

마이그레이션은 추가만(non-destructive). 기존 행 NULL 상태가 "백필 안 됨"으로 자연스럽게 동작.

---

## §4 CLI 변경

`worker/src/idol_sight/cli.py:backfill_yt_videos_cmd`:

### 4.1 새 파라미터

```python
def backfill_yt_videos_cmd(
    group: str | None = typer.Option(...),
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
```

### 4.2 Freshness 필터 로직

- `group` 명시 시: freshness 필터 무시 (사용자가 명시적으로 1개 그룹 지정한 경우 의도 존중)
- `group=None` (default 전체 순회): `--force` 또는 `--fresh-days=0` 가 아니면 freshness 필터 적용

```python
if group:
    targets = [group]
else:
    targets = sorted(KNOWN_GROUPS)
    if not force and fresh_days > 0:
        # Filter out groups backfilled within the freshness window
        fresh_rows = client.execute(
            "SELECT key FROM groups "
            "WHERE last_backfilled_at IS NOT NULL "
            "  AND julianday('now') - julianday(last_backfilled_at) < ?",
            [fresh_days],
        )
        fresh = {r["key"] for r in fresh_rows}
        skipped = [g for g in targets if g in fresh]
        targets = [g for g in targets if g not in fresh]
        if skipped:
            typer.echo(f"skipping {len(skipped)} fresh groups (< {fresh_days}d): "
                       f"{', '.join(skipped)}")
```

### 4.3 그룹 완료 시 UPDATE

기존 `client.batch(result.statements)` 직후:

```python
client.batch(result.statements)
client.execute(
    "UPDATE groups SET last_backfilled_at=? WHERE key=?",
    [datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), group_key],
)
```

원자성: batch 실패 시 UPDATE도 안 됨 → idempotent (다음 실행에서 다시 시도).

---

## §5 워크플로 변경

`.github/workflows/backfill-yt-videos.yml` 재작성 (matrix 패턴):

```yaml
name: backfill-yt-videos
on:
  workflow_dispatch:
    inputs:
      group:
        description: 'Single group key (e.g. isedol) — or "all" for every group (default: all)'
        default: 'all'
        required: false
      force:
        description: 'Skip freshness check (default false)'
        type: boolean
        default: false

jobs:
  backfill:
    strategy:
      fail-fast: false
      max-parallel: 3   # collect-hourly/daily와 동일 패턴 — D1 _load_group cold-start 429 회피
      matrix:
        group: [bdawn, isedol, miiwan, myrakl, owis, plave, skinz, stellive, wegosix]
    runs-on: ubuntu-latest
    timeout-minutes: 30   # 그룹당 30분 (stellive 솔로 채널 합산 worst case 여유)
    # workflow_dispatch에서 group이 'all'이 아니면 그 그룹만 실행:
    if: ${{ inputs.group == 'all' || inputs.group == '' || matrix.group == inputs.group }}
    steps:
      - uses: actions/checkout@v5
      - uses: astral-sh/setup-uv@v7
      - run: uv sync --frozen
        working-directory: worker
      - name: Backfill ${{ matrix.group }}
        run: |
          uv run python -m idol_sight backfill-yt-videos \
            --group ${{ matrix.group }} \
            ${{ inputs.force && '--force' || '' }}
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

**Behavior:**
- `workflow_dispatch` 디폴트 (`group=all`): 9개 job 병렬 (max 3 동시) → 단일 그룹 timeout이 다른 8개에 영향 없음
- `group=isedol`: matrix는 9개 생성되지만 `if` 조건으로 isedol만 실행 (다른 8개는 skipped)
- `force=true`: CLI에 `--force` 전달

**구버전 `backfill-yt-videos` CLI의 `--group=None` 전체 순회 동작은 유지** (cron 트리거나 수동 CLI에서 호환). 새 워크플로는 matrix로 같은 일을 더 빠르고 안전하게 수행.

---

## §6 Health-check 통합

`worker/src/idol_sight/cli_health.py:audit_freshness` 확장 — 기존 job freshness 외에 backfill freshness도 검사.

`groups.last_backfilled_at`를 검사하여 14일+ stale 그룹을 stale list에 포함:

```python
def audit_freshness(client, now_iso: str | None = None) -> list[dict]:
    # ... existing job freshness check ...

    # NEW: backfill freshness
    BACKFILL_ALERT_DAYS = 14
    stale_backfill = client.execute(
        "SELECT key FROM groups "
        "WHERE is_active = 1 "
        "  AND (last_backfilled_at IS NULL "
        "       OR julianday(?) - julianday(last_backfilled_at) > ?)",
        [now_iso or now_default, BACKFILL_ALERT_DAYS],
    )
    for r in stale_backfill:
        stale.append({
            "job": f"backfill:{r['key']}",
            "last_success_at": r.get("last_backfilled_at"),
            "age_h": ...,  # 시간 단위 변환
            "kind": "backfill",
        })

    return stale
```

기존 alert 채널(`notify_failure(webhook, job, error)`) 재사용. 운영자 Discord에 "backfill:stellive last_success_at=2026-04-25 (age=480h)" 형태로 표시.

---

## §7 구현 단계 + 파일 구조

| Phase | 파일 | 책임 |
|---|---|---|
| 1. Migration | `migrations/0053_backfill_checkpoint.sql` | groups.last_backfilled_at 컬럼 추가 |
| 2. CLI (TDD) | `worker/src/idol_sight/cli.py` (수정) | --force / --fresh-days 옵션 + freshness 필터 + UPDATE |
| 2. Tests | `worker/tests/unit/test_cli_backfill.py` (신규) | freshness 필터 분기 검증 (fresh skip, stale walk, --force bypass) |
| 3. Workflow | `.github/workflows/backfill-yt-videos.yml` (재작성) | matrix per-group + max-parallel=3 + timeout=30/group + force input |
| 4. Health-check | `worker/src/idol_sight/cli_health.py` (수정) | backfill freshness 추가 |
| 4. Tests | `worker/tests/unit/test_cli_health.py` (수정) | backfill 14일+ stale 케이스 추가 |
| 5. Migration 배포 | `migrate.yml` workflow 실행 | production D1에 0053 적용 |
| 6. Workflow 검증 | scoped dispatch `group=miiwan` | matrix가 정상 동작하는지 1그룹만 빠르게 검증 |

**커밋 분할 (5 commits 예상):**
1. `feat(db): 0053 backfill_checkpoint migration`
2. `feat(cli): backfill --force / --fresh-days + checkpoint UPDATE`
3. `feat(ci): backfill-yt-videos matrix per-group + freshness-aware`
4. `feat(health): backfill staleness alert at 14d`
5. `chore(docs): backfill resilience runbook`

---

## §8 정책 / 임계값

| 항목 | 값 | 근거 |
|---|---|---|
| `--fresh-days` 기본값 | 7일 | 일주일 안 백필했으면 데이터 충분히 신선 |
| Health-check alert | 14일+ | freshness 윈도우 2배 — 자연스러운 grace period |
| `max-parallel` | 3 | collect-daily/hourly와 동일 (D1 cold-start 429 회피 검증된 값) |
| 그룹당 `timeout-minutes` | 30 | 최악 케이스(stellive 10+ 채널 합산)도 ~15분 → 2배 여유 |
| 매트릭스 그룹 hardcode | 9개 | KNOWN_GROUPS와 동기화 필요 (장기적으로 reusable workflow로 분리 가능, v1.1로 미루기) |

---

## §9 리스크 / 한계

1. **Matrix groups hardcode**: workflow yaml의 그룹 리스트와 `KNOWN_GROUPS` Python 상수가 분리. 새 그룹 추가 시 두 곳 모두 업데이트 필요. v1.1에서 reusable workflow + JSON 파라미터로 통합 검토.

2. **Per-group timeout 여전히 가능**: 30분 안에도 stellive가 못 끝나면 그 그룹만 cancelled. 다른 8개는 정상이므로 영향 제한적. 14일 알림이 자동으로 통지.

3. **D1 429 risk**: max-parallel=3은 9개 직렬보다 3배 빠르지만 D1 cold-start 부담 증가. collect-hourly/daily에서 검증된 값이라 안전 마진은 있음. 문제 시 max-parallel=2로 조정.

4. **`force=true` 남용 위험**: 가끔만 쓰여야 하는 옵션이라 workflow_dispatch 폼에 명확히 "Skip freshness check" 설명 + 기본값 false.

5. **검증 후 매트릭스 활성화**: 처음엔 단일 그룹(miiwan, 영상 적음)으로 dispatch하여 matrix 동작 + UPDATE 동작 모두 확인 후 group=all로 확장.

---

## §10 후속 (별도 PR, v1.1)

- **Reusable workflow**: matrix groups를 호출 측에서 JSON으로 주입하여 그룹 추가 시 yaml 한 곳만 수정
- **Backfill-freshness 대시보드**: frontend에 "Last backfilled" 그룹별 표시 (운영자 가시화)
- **`backfill-yt-videos` orchestrator workflow**: 매주 자동 dispatch + scoped retry of cancelled groups (현재는 수동)
