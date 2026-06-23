# PLAVE Weverse 천장 CCV — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PLAVE 충성도 점수를 YouTube 실측(floor)과 Weverse 포함 운영자 추정 천장(ceiling, 15만)으로 분리해, 카드엔 floor를 정직하게 표시하면서 그룹 간 비교(Health)에는 ceiling을 쓴다.

**Architecture:** `groups.ccv_ceiling_estimate`(PLAVE=150000)를 추가하고, `loyalty.py`가 floor 산식은 그대로 두되 ceiling 필드(`conversion_rate_ceiling`/`score_ceiling`/`ccv_ceiling`)를 추가 산출한다. Health(`cli.py`)는 `COALESCE(score_ceiling, score)`로 PLAVE만 ceiling을 쓰고, 카드는 floor score를 1차로 보여주며 ceiling 비교 라인 + Weverse 주석을 덧붙인다.

**Tech Stack:** Python 3.12(uv/pytest), Cloudflare D1 SQL migration, Pages Functions(TS), Preact + Vite(vitest).

---

## 파일 구조

- `migrations/0095_plave_weverse_ccv_ceiling.sql` (생성) — groups 컬럼 + PLAVE UPDATE + agg_fan_loyalty 3컬럼.
- `worker/src/idol_sight/analysis/loyalty.py` (수정) — `compute_loyalty` ceiling 산출 + `build_fan_loyalty` 주입/INSERT.
- `worker/tests/unit/test_loyalty.py` (수정) — ceiling 단위 테스트.
- `worker/src/idol_sight/cli.py` (수정) — Health loyalty 조회 `COALESCE`.
- `frontend/functions/api/group/[key].ts` (수정) — ceiling 분리 쿼리 + merge.
- `frontend/src/components/FanLoyaltyCard.tsx` (수정) — 인터페이스 + ceiling 라인 + notes 맵.
- `frontend/src/components/FanLoyaltyCard.test.ts` (수정) — notes 맵 + ceiling 파생 헬퍼 테스트.
- `frontend/src/views/GroupContent.tsx` (수정) — 카드에 `groupKey` 전달.
- `CLAUDE.md` (수정) — V2.52 변경 로그.

---

## Task 1: Migration 0095 (스키마 + PLAVE 시드)

**Files:**
- Create: `migrations/0095_plave_weverse_ccv_ceiling.sql`

- [ ] **Step 1: 마이그레이션 파일 작성**

```sql
-- 0095: PLAVE Weverse 천장 CCV — 충성도 floor/ceiling 모델 (V2.52).
--
-- live_ccv_samples 는 YouTube concurrentViewers 만 수집한다. PLAVE 는 라이브
-- 동시 시청자의 상당 비중이 Weverse 로 빠져 YouTube-only CCV(=floor)가 실제
-- 동시 시청자를 구조적으로 과소집계한다. 운영자 추정: Weverse 포함 시 10만~20만.
--
-- floor(YouTube 실측)는 자기 페이지 1차 표시·실데이터로 유지하고, ceiling
-- (Weverse 포함 단일 추정치 = 10~20만 평균 = 150,000)은 그룹 간 비교(Health
-- Intimacy) + 카드의 "비교 기준" 라인에만 쓴다. ceiling 은 flat 추정이라
-- 방송별 분해 없이 ceiling/구독자 1회 산출한다.
--
-- 변경 (2):
--   (1) groups.ccv_ceiling_estimate — 운영자 설정 천장 추정치. plave=150000,
--       나머지 NULL. 후속으로 ISEDOL/STELLIVE(SOOP/치지직) 확장 가능.
--   (2) agg_fan_loyalty 에 ceiling 산출 3컬럼. build_fan_loyalty 가 채운다
--       (다음 aggregate cron 재집계, 백필 불필요). 기존 행은 채워지기 전까지 NULL.

ALTER TABLE groups ADD COLUMN ccv_ceiling_estimate INTEGER;
UPDATE groups SET ccv_ceiling_estimate=150000 WHERE key='plave';

ALTER TABLE agg_fan_loyalty ADD COLUMN conversion_rate_ceiling REAL;
ALTER TABLE agg_fan_loyalty ADD COLUMN score_ceiling REAL;
ALTER TABLE agg_fan_loyalty ADD COLUMN ccv_ceiling INTEGER;
```

- [ ] **Step 2: 로컬 적용으로 검증**

Run: `cd frontend && wrangler d1 migrations apply idol-sight --local`
Expected: 0095 적용 성공 (에러 없음). 이미 적용돼 있으면 "No migrations to apply".

- [ ] **Step 3: groups JSON 가드 회귀 테스트 (새 컬럼이 INTEGER라 무관함을 확인)**

Run: `cd worker && uv run pytest tests/unit/test_migrations_groups_json.py -q`
Expected: PASS (ccv_ceiling_estimate 는 INTEGER 라 JSON 가드 영향 없음).

- [ ] **Step 4: Commit**

```bash
git add migrations/0095_plave_weverse_ccv_ceiling.sql
git commit -m "feat(loyalty): migration 0095 — PLAVE Weverse 천장 CCV 컬럼 + 시드"
```

---

## Task 2: `compute_loyalty` ceiling 산출 (TDD)

**Files:**
- Test: `worker/tests/unit/test_loyalty.py`
- Modify: `worker/src/idol_sight/analysis/loyalty.py:109-173`

- [ ] **Step 1: 실패하는 테스트 작성** — `test_loyalty.py` 끝(line 211 이후)에 추가

```python
def test_compute_loyalty_ceiling_scored():
    # floor: peak median 1500 / 1,000,000 구독자 = 0.15% → score 20 (하한 클램프).
    # ceiling: 150,000 / 1,000,000 = 15% → score 100 (상한 클램프).
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 1000},
        {"video_id": "b", "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 2000},
    ]
    out = compute_loyalty(samples, subscribers=1_000_000, ceiling_estimate=150_000)
    # floor 불변
    assert out["peak_ccv_median"] == 1500.0
    assert out["conversion_rate"] == pytest.approx(0.0015)
    assert out["score"] == pytest.approx(20.0)
    assert out["basis"] == "scored"
    # ceiling 산출
    assert out["ccv_ceiling"] == 150_000
    assert out["conversion_rate_ceiling"] == pytest.approx(0.15)
    assert out["score_ceiling"] == pytest.approx(100.0)


def test_compute_loyalty_no_ceiling_estimate_fields_none():
    samples = [
        {"video_id": "a", "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 1500},
        {"video_id": "b", "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 1500},
    ]
    out = compute_loyalty(samples, subscribers=100_000)  # ceiling_estimate 미지정
    assert out["conversion_rate_ceiling"] is None
    assert out["score_ceiling"] is None
    assert out["ccv_ceiling"] is None
    assert out["score"] == pytest.approx(50.0)  # floor 불변


def test_compute_loyalty_ceiling_skipped_when_insufficient():
    # 방송 0개 → insufficient. ceiling_estimate 가 있어도 ceiling 산출 안 함
    # (실제 라이브 활동 없으면 순수 추정만으로 점수 부여 금지).
    out = compute_loyalty([], subscribers=1_000_000, ceiling_estimate=150_000)
    assert out["basis"] == "insufficient"
    assert out["ccv_ceiling"] is None
    assert out["score_ceiling"] is None
    assert out["conversion_rate_ceiling"] is None
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_loyalty.py -k ceiling -v`
Expected: FAIL — `compute_loyalty() got an unexpected keyword argument 'ceiling_estimate'`.

- [ ] **Step 3: 구현** — `loyalty.py`

3a. 시그니처 수정 (line 109-112):

```python
def compute_loyalty(
    samples: list[dict[str, Any]], subscribers: int | None,
    subs_at: Callable[[str], int | None] | None = None,
    ceiling_estimate: int | None = None,
) -> dict[str, Any]:
```

3b. base dict에 ceiling 필드 추가 (line 123-128 `base = {...}` 안, 마지막 항목 뒤에 추가):

```python
    base = {
        "conversion_rate": None, "peak_ccv_median": None,
        "broadcast_count": 0, "subscribers": subscribers,
        "score": None, "basis": "insufficient",
        "ccv_trend_pct": None, "trend_basis": "unknown",
        "conversion_rate_ceiling": None, "score_ceiling": None,
        "ccv_ceiling": None,
    }
```

3c. ceiling 산출 — floor 계산이 끝난 직후, `return base` (현재 line 173) **앞에** 추가:

```python
    # Weverse 포함 천장(ceiling) — flat 운영자 추정치. floor 가 산정된
    # 경우(broadcast_count≥1, subscribers 유효)에만, 최신 구독자를 분모로
    # 1회 산출한다. score/사다리/trend(floor)는 위에서 이미 YouTube 실측으로 확정.
    if ceiling_estimate and ceiling_estimate > 0:
        conv_ceil = ceiling_estimate / subscribers
        base["conversion_rate_ceiling"] = conv_ceil
        base["score_ceiling"] = round(score_from_conversion(conv_ceil), 2)
        base["ccv_ceiling"] = ceiling_estimate
    return base
```

> 주의: 이 블록은 `subscribers` 가 유효함이 보장된 지점(line 146-147 의 `if not subscribers ...: return base` 가드를 이미 통과)에 위치한다. broadcast_count==0 도 line 144-145 에서 먼저 return 되므로 ceiling 미산출.

- [ ] **Step 4: 통과 확인**

Run: `cd worker && uv run pytest tests/unit/test_loyalty.py -k ceiling -v`
Expected: PASS (3개).

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/loyalty.py worker/tests/unit/test_loyalty.py
git commit -m "feat(loyalty): compute_loyalty Weverse 천장 ceiling 필드 산출"
```

---

## Task 3: `build_fan_loyalty` ceiling 주입 + INSERT (TDD)

**Files:**
- Test: `worker/tests/unit/test_loyalty.py`
- Modify: `worker/src/idol_sight/analysis/loyalty.py:182,189-195,231-244`

- [ ] **Step 1: 실패하는 테스트 작성** — `test_loyalty.py` 끝에 추가

```python
def test_build_fan_loyalty_injects_ceiling_for_configured_group():
    client = _FakeClient(
        tracked=[{"key": "plave", "ccv_ceiling_estimate": 150_000},
                 {"key": "miiwan", "ccv_ceiling_estimate": None}],
        samples=[
            {"group_key": "plave", "video_id": "a",
             "sampled_at": "2026-06-01T10:00:00Z", "concurrent_viewers": 2000},
            {"group_key": "plave", "video_id": "b",
             "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 2000},
            {"group_key": "miiwan", "video_id": "c",
             "sampled_at": "2026-06-05T10:00:00Z", "concurrent_viewers": 1500},
        ],
        subs=[
            {"group_key": "plave", "yt_subscribers": 1_000_000,
             "snapshot_at": "2026-06-07T00:00:00Z"},
            {"group_key": "miiwan", "yt_subscribers": 100_000,
             "snapshot_at": "2026-06-07T00:00:00Z"},
        ],
    )
    res = build_fan_loyalty(client)
    params_by_group = {st[1][0]: st[1] for st in res.statements[1:]}
    # INSERT 컬럼 끝 3개: conversion_rate_ceiling, score_ceiling, ccv_ceiling
    plave = params_by_group["plave"]
    assert plave[-1] == 150_000                      # ccv_ceiling
    assert plave[-2] == pytest.approx(100.0)         # score_ceiling (15% → 클램프)
    assert plave[-3] == pytest.approx(0.15)          # conversion_rate_ceiling
    miiwan = params_by_group["miiwan"]
    assert miiwan[-1] is None                        # 천장 미설정 → None
    assert miiwan[-2] is None
    assert miiwan[-3] is None
```

- [ ] **Step 2: 실패 확인**

Run: `cd worker && uv run pytest tests/unit/test_loyalty.py -k injects_ceiling -v`
Expected: FAIL — IndexError 또는 ceiling 값이 없음 (INSERT에 컬럼 미추가).

- [ ] **Step 3: 구현** — `loyalty.py`

3a. tracked 조회 SQL 에 ceiling 컬럼 추가 (line 182):

```python
_TRACKED_SQL = "SELECT key, ccv_ceiling_estimate FROM groups WHERE ccv_tracked=1"
```

3b. INSERT SQL 에 컬럼 3개 추가 (line 189-195):

```python
_INSERT_SQL = """
INSERT INTO agg_fan_loyalty
  (group_key, conversion_rate, peak_ccv_median, broadcast_count,
   subscribers, score, basis, ccv_trend_pct, trend_basis,
   window_days, snapshot_at,
   conversion_rate_ceiling, score_ceiling, ccv_ceiling)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""
```

3c. tracked 루프 — ceiling 주입 + INSERT 파라미터 (line 209, 231-244):

line 209 의 tracked 리스트를 dict 로 변경:

```python
    tracked = [
        (r["key"], r.get("ccv_ceiling_estimate"))
        for r in client.execute(_TRACKED_SQL)
    ]
```

line 232-244 의 루프 교체:

```python
    statements: list[tuple[str, list[Any]]] = [(_CLEAR_SQL, [])]
    for gk, ceiling in tracked:
        series = subs_series_by_group.get(gk, [])
        latest = series[-1][1] if series else None
        out = compute_loyalty(
            samples_by_group.get(gk, []), latest,
            subs_at=(lambda at, s=series: subscribers_at(s, at)) if series else None,
            ceiling_estimate=ceiling,
        )
        statements.append((_INSERT_SQL, [
            gk, out["conversion_rate"], out["peak_ccv_median"],
            out["broadcast_count"], out["subscribers"], out["score"],
            out["basis"], out["ccv_trend_pct"], out["trend_basis"],
            WINDOW_DAYS, now,
            out["conversion_rate_ceiling"], out["score_ceiling"],
            out["ccv_ceiling"],
        ]))
```

- [ ] **Step 4: 통과 + 전체 회귀 확인**

Run: `cd worker && uv run pytest tests/unit/test_loyalty.py -v`
Expected: PASS (신규 포함 전부). 기존 `test_build_fan_loyalty_*` 도 통과 — tracked 가 `r.get("ccv_ceiling_estimate")` 라 ceiling 키 없는 fixture 도 None 으로 안전.

- [ ] **Step 5: Commit**

```bash
git add worker/src/idol_sight/analysis/loyalty.py worker/tests/unit/test_loyalty.py
git commit -m "feat(loyalty): build_fan_loyalty 천장 추정치 주입 + INSERT 3컬럼"
```

---

## Task 4: Health Intimacy 가 ceiling 우선 사용

**Files:**
- Modify: `worker/src/idol_sight/cli.py:1483-1491`

- [ ] **Step 1: 조회 SQL 교체**

`cli.py` 의 `loyalty_rows` 블록(line 1483-1488)을 교체:

```python
    try:
        loyalty_rows = client.execute(
            "SELECT group_key, COALESCE(score_ceiling, score) AS score "
            "FROM agg_fan_loyalty "
            "WHERE basis='scored' AND COALESCE(score_ceiling, score) IS NOT NULL"
        )
        loyalty_by_key = {r["group_key"]: r["score"] for r in loyalty_rows}
    except Exception as exc:
        typer.echo(f"[warn] loyalty fallback (agg_fan_loyalty 조회 실패): {exc}", err=True)
        loyalty_by_key = {}
```

> PLAVE 는 ceiling, 나머지는 floor 폴백. 0095 미적용 시 컬럼 없어 throw →
> except → `loyalty_by_key={}` (기존 graceful 동작 유지).

- [ ] **Step 2: 주석 보강** (line 1479-1482 기존 주석 끝에 한 줄 추가)

기존 주석 블록 마지막 줄(`# 스코어링이 통째로 죽지 않게 빈 dict 로 폴백.`) 다음에:

```python
    # V2.52: PLAVE 는 COALESCE 로 score_ceiling(Weverse 포함 천장) 우선.
```

- [ ] **Step 3: worker 전체 테스트 회귀**

Run: `cd worker && uv run pytest -q`
Expected: PASS (Health 테스트 포함 — loyalty_by_key 구조 불변, SQL만 변경).

- [ ] **Step 4: Commit**

```bash
git add worker/src/idol_sight/cli.py
git commit -m "feat(loyalty): Health Intimacy 가 PLAVE 천장 score_ceiling 우선 사용"
```

---

## Task 5: Group API ceiling 분리 쿼리 + merge

**Files:**
- Modify: `frontend/functions/api/group/[key].ts:261-281,312-314`

- [ ] **Step 1: ceiling 분리 쿼리 추가**

`group/[key].ts` 의 `fanLoyalty`/`loyaltyBroadcasts` `Promise.all` 블록(line 262-281)에 세 번째 쿼리를 추가한다. `Promise.all` 배열 안 마지막(loyaltyBroadcasts 다음)에:

```typescript
  const [fanLoyalty, loyaltyBroadcasts, loyaltyCeiling] = await Promise.all([
    d1QueryOne<{
      conversion_rate: number | null; peak_ccv_median: number | null;
      broadcast_count: number; subscribers: number | null;
      score: number | null; basis: "scored" | "low_confidence" | "insufficient";
      ccv_trend_pct: number | null;
      trend_basis: "rising" | "falling" | "flat" | "unknown";
      window_days: number; snapshot_at: string;
    }>(env.DB,
      "SELECT conversion_rate, peak_ccv_median, broadcast_count, subscribers, "
      + "score, basis, ccv_trend_pct, trend_basis, window_days, snapshot_at "
      + "FROM agg_fan_loyalty WHERE group_key=?", [key])
      .catch(() => null),
    d1Query<{ video_id: string; peak: number; last_at: string }>(env.DB,
      "SELECT video_id, MAX(concurrent_viewers) AS peak, MAX(sampled_at) AS last_at "
      + "FROM live_ccv_samples WHERE group_key=? "
      + "AND sampled_at >= datetime('now','-56 days') "
      + "GROUP BY video_id ORDER BY last_at DESC LIMIT 12", [key])
      .catch(() => [] as { video_id: string; peak: number; last_at: string }[]),
    // V2.52: Weverse 천장 ceiling 컬럼 — 별도 쿼리로 분리. 0095 미적용 시
    // 이 쿼리만 실패(null)하고 floor 카드는 정상 렌더(회귀 방지).
    d1QueryOne<{
      conversion_rate_ceiling: number | null; score_ceiling: number | null;
      ccv_ceiling: number | null;
    }>(env.DB,
      "SELECT conversion_rate_ceiling, score_ceiling, ccv_ceiling "
      + "FROM agg_fan_loyalty WHERE group_key=?", [key])
      .catch(() => null),
  ]);
```

- [ ] **Step 2: 응답 merge 수정** (line 312-314)

```typescript
    fan_loyalty: fanLoyalty
      ? { ...fanLoyalty, ...(loyaltyCeiling ?? {}),
          broadcasts: [...loyaltyBroadcasts].reverse() }  // 오래된→최신
      : null,
```

- [ ] **Step 3: 타입체크**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 4: Commit**

```bash
git add frontend/functions/api/group/\[key\].ts
git commit -m "feat(loyalty): group API 가 Weverse 천장 ceiling 컬럼 분리 조회·merge"
```

---

## Task 6: 카드 인터페이스 + notes 맵 + ceiling 라인 (TDD 헬퍼)

**Files:**
- Test: `frontend/src/components/FanLoyaltyCard.test.ts`
- Modify: `frontend/src/components/FanLoyaltyCard.tsx`
- Modify: `frontend/src/views/GroupContent.tsx:244`

- [ ] **Step 1: 실패하는 헬퍼 테스트 작성** — `FanLoyaltyCard.test.ts` import 에 `ccvPlatformNote, fmtCeilingMan` 추가하고 맨 끝에 describe 추가

import 줄(line 2) 교체:

```typescript
import { trendLabel, fmtPct, barWidthPct, medianRowIndex,
         ccvPlatformNote, fmtCeilingMan } from "./FanLoyaltyCard";
```

파일 끝에 추가:

```typescript
describe("ccvPlatformNote", () => {
  it("plave 는 Weverse 노트, 그 외는 undefined", () => {
    const note = ccvPlatformNote("plave");
    expect(note?.platform).toBe("Weverse");
    expect(note?.bandText).toBe("10만~20만");
    expect(ccvPlatformNote("miiwan")).toBeUndefined();
  });
});

describe("fmtCeilingMan", () => {
  it("천장 추정치를 만 단위로", () => {
    expect(fmtCeilingMan(150000)).toBe("15만");
    expect(fmtCeilingMan(200000)).toBe("20만");
    expect(fmtCeilingMan(null)).toBe("—");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm vitest run src/components/FanLoyaltyCard.test.ts`
Expected: FAIL — `ccvPlatformNote`/`fmtCeilingMan` not exported.

- [ ] **Step 3: 구현** — `FanLoyaltyCard.tsx`

3a. `FanLoyalty` 인터페이스(line 4-15)에 ceiling 필드 추가 — `broadcasts` 앞에:

```typescript
export interface FanLoyalty {
  conversion_rate: number | null;
  peak_ccv_median: number | null;
  broadcast_count: number;
  subscribers: number | null;
  score: number | null;
  basis: "scored" | "low_confidence" | "insufficient";
  ccv_trend_pct: number | null;
  trend_basis: "rising" | "falling" | "flat" | "unknown";
  window_days: number;
  conversion_rate_ceiling?: number | null;
  score_ceiling?: number | null;
  ccv_ceiling?: number | null;
  broadcasts: Broadcast[];
}
```

3b. notes 맵 + 헬퍼 export — `fmtPct`(line 17) 위에 추가:

```typescript
/** 그룹별 외부 플랫폼 CCV 주석. YouTube CCV 만 수집하므로, 다른 플랫폼
 *  동시 송출 비중이 큰 그룹은 floor(YouTube)임을 명시한다. 현재 PLAVE
 *  (Weverse)만. 후속으로 ISEDOL/STELLIVE(SOOP/치지직) 확장 가능. */
const CCV_PLATFORM_NOTES: Record<string, { platform: string; bandText: string }> = {
  plave: { platform: "Weverse", bandText: "10만~20만" },
};

export function ccvPlatformNote(groupKey: string | undefined):
  { platform: string; bandText: string } | undefined {
  if (!groupKey) return undefined;
  return CCV_PLATFORM_NOTES[groupKey];
}

/** 천장 CCV 추정치를 "N만" 으로. null → "—". */
export function fmtCeilingMan(ccv: number | null | undefined): string {
  if (ccv == null) return "—";
  return `${Math.round(ccv / 10000)}만`;
}
```

3c. 컴포넌트 시그니처에 `groupKey` 추가 (line 70):

```typescript
export function FanLoyaltyCard(
  { loyalty, groupKey }: { loyalty: FanLoyalty; groupKey?: string },
) {
  const { basis, score, conversion_rate, trend_basis, ccv_trend_pct,
          broadcast_count, window_days, broadcasts, peak_ccv_median,
          score_ceiling, conversion_rate_ceiling, ccv_ceiling } = loyalty;
  const platformNote = ccvPlatformNote(groupKey);
```

3d. ceiling 비교 라인 — score 행 `<div class="flex items-center gap-4">...</div>`(line 90-106) 닫힘 직후에 추가:

```tsx
          {score_ceiling != null && (
            <div class="mt-1 text-data text-zinc-400">
              그룹 간 비교 기준
              {platformNote ? ` (${platformNote.platform} 포함 천장 ~${fmtCeilingMan(ccv_ceiling)})` : ""}
              : <span class="font-semibold text-zinc-200">{Math.round(score_ceiling)}점</span>
              {" · "}{fmtPct(conversion_rate_ceiling ?? null)}
            </div>
          )}
```

3e. Weverse 주석 — 카드 하단 기존 캡션(line 157-159 `충성도 = ...`) **위에** 추가:

```tsx
      {platformNote && ccv_ceiling != null && (
        <div class="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-hint text-amber-200/90">
          ⚠ CCV는 YouTube 동시 시청자만 수집(하한). {groupKey?.toUpperCase()}는 {platformNote.platform} 동시
          송출 비중이 커 실제 동시 시청자 {platformNote.bandText} 추정. 그룹 간 충성도
          비교에는 {platformNote.platform} 포함 추정 천장(평균 {fmtCeilingMan(ccv_ceiling)}) 사용.
          {platformNote.platform} 수치는 미수집 운영자 추정치.
        </div>
      )}
```

- [ ] **Step 4: GroupContent 가 groupKey 전달** (`GroupContent.tsx:244`)

```tsx
          {data.fan_loyalty && <FanLoyaltyCard loyalty={data.fan_loyalty} groupKey={groupKey!} />}
```

- [ ] **Step 5: 헬퍼 테스트 통과 확인**

Run: `cd frontend && pnpm vitest run src/components/FanLoyaltyCard.test.ts`
Expected: PASS (기존 + 신규 2 describe).

- [ ] **Step 6: 타입체크**

Run: `cd frontend && pnpm tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/FanLoyaltyCard.tsx frontend/src/components/FanLoyaltyCard.test.ts frontend/src/views/GroupContent.tsx
git commit -m "feat(loyalty): PLAVE 카드 Weverse 천장 비교 라인 + 주석 (frontend)"
```

---

## Task 7: 전체 회귀 + CLAUDE.md 로그

**Files:**
- Modify: `CLAUDE.md` (V2.51 항목 다음에 V2.52 추가)

- [ ] **Step 1: worker 전체 테스트**

Run: `cd worker && uv run pytest -q`
Expected: PASS (전부).

- [ ] **Step 2: frontend 전체 테스트 + 타입체크**

Run: `cd frontend && pnpm vitest run && pnpm tsc --noEmit`
Expected: PASS, 타입 에러 없음.

- [ ] **Step 3: ruff (worker 변경 파일)**

Run: `cd worker && uv run ruff check src/idol_sight/analysis/loyalty.py src/idol_sight/cli.py tests/unit/test_loyalty.py`
Expected: All checks passed.

- [ ] **Step 4: CLAUDE.md V2.52 항목 추가** — V2.51 불릿 다음에:

```markdown
- **V2.52 (2026-06-23)**: PLAVE **Weverse 천장 CCV** — 충성도 floor/ceiling 모델. `live_ccv_samples`는 YouTube concurrentViewers만 수집해 PLAVE 동시 시청자를 구조적 과소집계(Weverse로 빠짐). 운영자 추정 10만~20만. floor(YouTube 실측)=카드 1차 표시·사다리, ceiling(Weverse 포함 단일 추정치=10~20만 평균 150,000)=그룹 간 비교(Health Intimacy)+카드 "비교 기준" 라인. migration 0095: `groups.ccv_ceiling_estimate`(plave=150000) + `agg_fan_loyalty` ceiling 3컬럼(conversion_rate_ceiling/score_ceiling/ccv_ceiling). `loyalty.py compute_loyalty(..., ceiling_estimate)`가 floor 산식 불변 유지하며 ceiling=estimate/최신구독자 1회 산출(방송≥1일 때만, 순수 날조 방지). `build_fan_loyalty`가 `ccv_ceiling_estimate` 주입. Health(`cli.py`)는 `COALESCE(score_ceiling, score)`로 PLAVE만 ceiling 우선. group API는 ceiling 분리 `.catch(()=>null)` 쿼리(0095 미적용 시 floor 카드 정상). `FanLoyaltyCard`는 floor score 1차 + `CCV_PLATFORM_NOTES`(plave: Weverse, 10만~20만) amber 주석 + ceiling 비교 라인. ceiling은 운영자 추정치라 "추정·천장" 명시([[project_organicity_heuristic_only]] 정직성 정합). 스펙/플랜 `docs/superpowers/{specs,plans}/2026-06-23-plave-weverse-ccv-ceiling*`. worker N + frontend N 통과. **migration 0095 운영자 원격 apply 필요**(`gh workflow run migrate.yml`) — worker/frontend가 새 컬럼 읽고/쓰므로 다음 aggregate cron 전 적용. 범위 밖: 실제 Weverse CCV 수집(불가), 방송별 분해, 타 그룹 천장값(운영자 후속).
```

> N 자리는 Step 1/2 의 실제 통과 수로 채운다.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(loyalty): V2.52 PLAVE Weverse 천장 CCV 변경 로그"
```

- [ ] **Step 6: SecondBrain 로그 1줄** (전역 규칙)

```bash
printf -- '- (%s · idol-sight) PLAVE Weverse 천장 CCV — 충성도 floor/ceiling 모델 (V2.52)\n' "$(date +%H:%M)" >> "$HOME/SecondBrain/00_Inbox/작업로그 $(date +%F).md"
```

> 그날 파일이 없으면 전역 규칙의 frontmatter로 생성 후 append.

---

## 배포 후 운영자 액션 (코드 외)

- `gh workflow run migrate.yml` 로 0095 원격 apply (worker/frontend가 새 컬럼 읽고 쓰므로 다음 aggregate cron 전 필요).
- 적용 후 다음 aggregate cron(21:30 KST)이 `agg_fan_loyalty` ceiling 채움 → PLAVE 카드 비교 라인·Health 반영.
