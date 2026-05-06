# Historical Pre-Debut Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PLAVE / OWIS / SKINZ / MYRAKL 4그룹의 데뷔 D-180 ~ D+90 구간에 대한 YouTube 구독자 / 네이버 뉴스 시계열을 백필하고, DebutCurve와 MiiWANBriefing D-30 벤치마크 표가 두 그룹의 같은 시점을 비교 가능하게 만든다.

**Architecture:** D1 단일 테이블 `agg_summary`에 `data_source` 컬럼을 추가해 백필 행과 라이브 행을 구분, 동일 (group_key, snapshot_at)에 대해 컬럼별 UPSERT 머지로 yt_history_backfill 출력과 신규 백필을 통합한다. UI는 `data_source` 값에 따라 segment.borderDash + opacity 분기.

**Tech Stack:** Cloudflare D1 (SQLite) + Wrangler migrations / Python 3.12 (worker) / Preact + Vite + TypeScript + Chart.js v4 (frontend)

**Spec:** `docs/superpowers/specs/2026-05-06-historical-debut-backfill-design.md`

---

## File Structure

**Create**:
- `migrations/0018_data_source.sql` — ALTER + 회고 UPDATE + 4그룹 백필 INSERTs
- `migrations/0019_pre_debut_events.sql` — PLAVE 멤버 공개 + MYRAKL D-30 buildup
- `scripts/historical_backfill/SOURCES.md` — 출처/방법론/검증 노트

**Modify**:
- `worker/src/idol_sight/analysis/yt_history_backfill.py` — INSERT에 data_source 컬럼 추가
- `frontend/functions/api/debut-curve.ts` — SELECT/Row/버킷팅/output에 source 추가
- `frontend/functions/api/miiwan.ts` — benchmarks 항목에 data_source 추가
- `frontend/src/components/DebutCurve.tsx` — Series 타입 확장 + segment.borderDash + 범례
- `frontend/src/views/MiiWANBriefing.tsx` — Benchmark 타입 확장 + est 배지 + 툴팁

---

## Phase A — 스키마 + 코드 레일 (데이터 없이)

이 단계의 목표는 `data_source` 컬럼이 D1에 들어가고 모든 코드 경로가 그 값을 정확히 통과시키는 것. 백필 데이터는 Phase B에서. Phase A 끝나면 모든 행은 `data_source='live'` 로만 마킹돼 있고 (yt_history_backfill 회고 UPDATE 행은 'backfill_estimate'), 차트는 평소처럼 그려져야 함.

---

### Task 1: Migration 0018 스키마 부분 (백필 INSERTs 제외)

**Files:**
- Create: `migrations/0018_data_source.sql`

- [ ] **Step 1: Create migration file with schema-only changes**

```sql
-- migrations/0018_data_source.sql
-- agg_summary.data_source: 행 출처 분류
--   live              = collector 실측
--   backfill_exact    = 검증 가능한 백필 (네이버 뉴스 키워드 카운트 등)
--   backfill_estimate = 본질적 추정 (Social Blade 구독자, cumulative views)
--
-- weakest-link 룰: 한 행에 estimate 컬럼이 하나라도 있으면 행 전체를
-- backfill_estimate로 표시. UI는 보수적으로 "추정"으로 렌더 — false
-- positive 방향(살짝 더 조심)으로만 동작.
ALTER TABLE agg_summary
  ADD COLUMN data_source TEXT NOT NULL DEFAULT 'live'
  CHECK(data_source IN ('live', 'backfill_exact', 'backfill_estimate'));

CREATE INDEX idx_agg_summary_source
  ON agg_summary(group_key, data_source, snapshot_at);

-- 회고 분류: 기존 yt_history_backfill 행 시그니처는
-- yt_subscribers IS NULL + 비-YT 컬럼 모두 0 + cumulative views가
-- over-estimate. 따라서 backfill_estimate로 마킹.
UPDATE agg_summary
   SET data_source = 'backfill_estimate'
 WHERE yt_subscribers IS NULL
   AND dc_total_posts = 0 AND theqoo_posts = 0 AND instiz_posts = 0
   AND naver_total_news = 0 AND twitter_posts = 0
   AND controversy_count = 0;

-- 백필 INSERT은 후속 Task에서 이 파일에 append.
```

- [ ] **Step 2: Apply locally**

```bash
cd /Users/user/Desktop/idol-sight/frontend
wrangler d1 migrations apply idol-sight --local
```

Expected: `🚣 0018_data_source.sql 🚣 successfully applied`

- [ ] **Step 3: Verify schema**

```bash
cd /Users/user/Desktop/idol-sight/frontend
wrangler d1 execute idol-sight --local --command="SELECT name, type FROM pragma_table_info('agg_summary') WHERE name='data_source';"
```

Expected output: `data_source | TEXT`

- [ ] **Step 4: Verify retroactive UPDATE**

```bash
wrangler d1 execute idol-sight --local --command="SELECT data_source, COUNT(*) FROM agg_summary GROUP BY data_source;"
```

Expected: 두 행 (`live` 와 `backfill_estimate`). yt_history_backfill 출력 행 수만큼 backfill_estimate, 나머지 라이브 행은 live.

- [ ] **Step 5: Commit**

```bash
cd /Users/user/Desktop/idol-sight
git add migrations/0018_data_source.sql
git commit -m "feat: add agg_summary.data_source column with retro classification"
```

---

### Task 2: yt_history_backfill.py — data_source 컬럼 출력

**Files:**
- Modify: `worker/src/idol_sight/analysis/yt_history_backfill.py:50-58`

- [ ] **Step 1: Update _INSERT_SQL to include data_source**

Edit lines 50-58 (the `_INSERT_SQL` constant):

```python
_INSERT_SQL = """
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES (?, ?, ?, ?, NULL, 0, 0, 0, 0, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO NOTHING
""".strip()
```

Single change: add `data_source` to the column list and `'backfill_estimate'` literal at end of VALUES.

- [ ] **Step 2: Verify by dry-running cli.py if available, otherwise inspect output**

```bash
cd /Users/user/Desktop/idol-sight/worker
uv run python -c "
from idol_sight.analysis.yt_history_backfill import _INSERT_SQL
assert 'data_source' in _INSERT_SQL
assert \"'backfill_estimate'\" in _INSERT_SQL
print('OK')
"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add worker/src/idol_sight/analysis/yt_history_backfill.py
git commit -m "feat: yt_history_backfill writes data_source=backfill_estimate"
```

---

### Task 3: API — debut-curve.ts에 source 동봉

**Files:**
- Modify: `frontend/functions/api/debut-curve.ts:36-103`

- [ ] **Step 1: Update Row interface (line 36-39)**

Replace:

```ts
interface Row {
  group_key: string; name: string; debut_date: string | null; group_model: string | null;
  snapshot_at: string; value: number | null;
}
```

With:

```ts
interface Row {
  group_key: string; name: string; debut_date: string | null; group_model: string | null;
  snapshot_at: string; value: number | null;
  source: 'live' | 'backfill_exact' | 'backfill_estimate';
}
```

- [ ] **Step 2: Update SELECT (line 58-67)**

Replace the SELECT statement:

```ts
const rows = await d1Query<Row>(env.DB,
  `SELECT g.key AS group_key, g.name, g.debut_date, g.group_model,
          s.snapshot_at, s.${metric} AS value, s.data_source AS source
     FROM agg_summary s
     JOIN groups g ON g.key = s.group_key
    WHERE g.is_active = 1
      AND g.debut_date IS NOT NULL
      AND CAST(julianday(date(s.snapshot_at)) - julianday(g.debut_date) AS INTEGER) BETWEEN ? AND ?
    ORDER BY g.key, s.snapshot_at ASC`,
  [from, to]);
```

Single change: add `s.data_source AS source` to SELECT list.

- [ ] **Step 3: Update bucket type (line 72-91)**

Replace:

```ts
const byGroup: Record<string, {
  name: string; debut_date: string; group_model: string;
  points: Map<number, number>;
}> = {};
```

With:

```ts
const byGroup: Record<string, {
  name: string; debut_date: string; group_model: string;
  points: Map<number, { value: number; source: string }>;
}> = {};
```

And update the `slot.points.set` call:

```ts
slot.points.set(offset, { value: Number(r.value), source: r.source });
```

(Replaces the existing `slot.points.set(offset, Number(r.value));`)

The `slot = byGroup[r.group_key] ?? { ..., points: new Map<number, number>() }` line also needs the type update — change to `new Map<number, { value: number; source: string }>()`.

- [ ] **Step 4: Update output mapping (line 93-101)**

Replace:

```ts
points: [...v.points.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([day, value]) => ({ day_offset: day, value })),
```

With:

```ts
points: [...v.points.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([day, p]) => ({ day_offset: day, value: p.value, source: p.source })),
```

- [ ] **Step 5: Local sanity test**

```bash
cd /Users/user/Desktop/idol-sight/frontend
pnpm dev &
sleep 4
curl -s "http://localhost:8788/api/debut-curve?metric=yt_subscribers&from=-30&to=30" | head -c 500
kill %1
```

Expected: JSON에 `"source": "live"` 또는 `"source": "backfill_estimate"` 포함된 points 배열.

- [ ] **Step 6: Commit**

```bash
git add frontend/functions/api/debut-curve.ts
git commit -m "feat: debut-curve API returns data_source per point"
```

---

### Task 4: API — miiwan.ts 벤치마크에 data_source 동봉

**Files:**
- Modify: `frontend/functions/api/miiwan.ts:177-200`

- [ ] **Step 1: Update benchmarks 타입 선언 (line 177-181)**

Replace:

```ts
const benchmarks: Array<{
  group_key: string; name: string; debut_date: string | null;
  snapshot_at: string | null;
  summary: Omit<SummaryRow, "group_key" | "snapshot_at"> | null;
}> = [];
```

With:

```ts
const benchmarks: Array<{
  group_key: string; name: string; debut_date: string | null;
  snapshot_at: string | null;
  data_source: string | null;
  summary: Omit<SummaryRow, "group_key" | "snapshot_at"> | null;
}> = [];
```

- [ ] **Step 2: Update SELECT *to include data_source* (around line 186-194)**

The SELECT in miiwan.ts uses `SELECT *` already, so `data_source` column will be auto-included after migration 0018. Confirm by reading file. The `SummaryRow` type elsewhere in the file may need to include `data_source` if it's exhaustively typed.

```bash
grep -n "type SummaryRow" /Users/user/Desktop/idol-sight/frontend/functions/api/miiwan.ts
```

If found, add `data_source: string;` to that type definition.

- [ ] **Step 3: Update benchmarks.push (line 199)**

Locate the `benchmarks.push({ ... })` call. Add `data_source: row?.data_source ?? null,` to the pushed object:

```ts
benchmarks.push({
  group_key: gk,
  name: g.name,
  debut_date: g.debut_date,
  snapshot_at: row?.snapshot_at ?? null,
  data_source: row?.data_source ?? null,  // 신규
  summary: row ? { ... } : null,
});
```

- [ ] **Step 4: Local sanity test**

```bash
cd /Users/user/Desktop/idol-sight/frontend
pnpm dev &
sleep 4
curl -s "http://localhost:8788/api/miiwan" | python3 -c "import json,sys; d=json.load(sys.stdin); print([{k:v for k,v in b.items() if k in ('group_key','data_source')} for b in d.get('benchmarks',[])])"
kill %1
```

Expected: 각 벤치마크 항목에 `data_source` 키 존재 (현재는 모두 'live' 또는 NULL).

- [ ] **Step 5: Commit**

```bash
git add frontend/functions/api/miiwan.ts
git commit -m "feat: miiwan benchmark API includes data_source per group"
```

---

### Task 5: DebutCurve.tsx — Series 타입 + segment.borderDash + 범례

**Files:**
- Modify: `frontend/src/components/DebutCurve.tsx:31-37,178-200,343-355`

- [ ] **Step 1: Extend Series type (line 31-37)**

Replace:

```ts
type Series = {
  group_key: string;
  name: string;
  debut_date: string;
  group_model: string;
  points: Array<{ day_offset: number; value: number }>;
};
```

With:

```ts
type Series = {
  group_key: string;
  name: string;
  debut_date: string;
  group_model: string;
  points: Array<{
    day_offset: number;
    value: number;
    source: 'live' | 'backfill_exact' | 'backfill_estimate';
  }>;
};
```

- [ ] **Step 2: Update dataset build to include source per point (line 178-200)**

The current code maps points to `{x, y}` for Chart.js. Change to include source so segment callbacks can read it:

Replace the inner `data: xs.map(...)` line:

```ts
data: xs.map((d) => {
  const p = s.points.find((q) => q.day_offset === d);
  return p ? { x: d, y: p.value, source: p.source } : { x: d, y: null, source: 'live' as const };
}),
```

(Original used a Map-based lookup — the code currently is `const map = new Map(s.points.map((p) => [p.day_offset, p.value]));` which strips source. Replace that Map-based lookup entirely with the find above, OR change the Map to store the full point: `new Map(s.points.map((p) => [p.day_offset, p]))` then `map.get(d)?.value` and `map.get(d)?.source`.)

For clarity, use the Map-with-full-point variant:

```ts
const map = new Map(s.points.map((p) => [p.day_offset, p]));
const isMiiwan = s.group_key === "miiwan";
return {
  label: s.name,
  data: xs.map((d) => {
    const p = map.get(d);
    return p
      ? { x: d, y: p.value, source: p.source }
      : { x: d, y: null, source: 'live' as const };
  }),
  borderColor: colorOf(s.group_key),
  backgroundColor: fillOf(s.group_key, 0.1),
  borderWidth: isMiiwan ? 3 : 2,
  hoverBorderWidth: isMiiwan ? 4 : 3,
  borderDash: isMiiwan ? [] : (cohortOf(s.group_model) === "subculture" ? [4, 3] : []),
  pointRadius: 0,
  pointHoverRadius: 5,
  pointHitRadius: 12,
  spanGaps: true,
  tension: 0.25,
  fill: false,
  // segment 콜백: 두 인접 포인트 사이의 라인 세그먼트의 source 기준 분기.
  // backfill_estimate가 한쪽이라도 있으면 굵은 점선, backfill_exact만이면
  // 가는 점선, 둘 다 live이면 실선(undefined로 기본 borderDash 사용).
  segment: {
    borderDash: (ctx: any) => {
      const a = ctx.p0?.raw?.source;
      const b = ctx.p1?.raw?.source;
      if (a === 'backfill_estimate' || b === 'backfill_estimate') return [6, 4];
      if (a === 'backfill_exact'    || b === 'backfill_exact')    return [2, 2];
      return undefined;
    },
    borderColor: (ctx: any) => {
      const b = ctx.p1?.raw?.source;
      return b && b !== 'live'
        ? fillOf(s.group_key, 0.55)
        : colorOf(s.group_key);
    },
  },
};
```

- [ ] **Step 3: Add 범례 (line 343 직전 또는 chart 위 메타 영역)**

After the existing `<h3 class="section-title">데뷔 정렬 곡선</h3>` 영역 (line 337-341), add a small legend for the source dash patterns. Locate the meta `<span class="text-hint text-zinc-500">` (line 339-340) and append after the closing `</span>`:

```tsx
<span class="ml-auto text-[11px] text-zinc-500">
  <span class="mr-2"><span class="inline-block w-4 border-t-2 border-zinc-400 align-middle"></span> 실측</span>
  <span class="mr-2"><span class="inline-block w-4 border-t-2 border-dashed border-zinc-400 align-middle"></span> 백필 추정</span>
  <span><span class="inline-block w-4 border-t border-dotted border-zinc-400 align-middle"></span> 백필 검증</span>
</span>
```

- [ ] **Step 4: Local sanity test**

```bash
cd /Users/user/Desktop/idol-sight/frontend
pnpm dev
```

Open `http://localhost:8788`, navigate to the page hosting DebutCurve. Verify:
- 차트가 정상 렌더 (현재는 백필 추정 데이터 없어서 모든 라인이 실선)
- 범례 3개 (실측/백필 추정/백필 검증)이 차트 위에 표시
- 콘솔 에러 없음

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/DebutCurve.tsx
git commit -m "feat: DebutCurve renders source-aware segment dashes + legend"
```

---

### Task 6: MiiWANBriefing.tsx — Benchmark 타입 + est 배지 + 툴팁

**Files:**
- Modify: `frontend/src/views/MiiWANBriefing.tsx:35-37,343-380`

- [ ] **Step 1: Extend Benchmark type (line 35-37)**

Locate the `type Benchmark = { ... }` block:

```ts
type Benchmark = {
  group_key: string; name: string; debut_date: string | null;
  snapshot_at: string | null; summary: SummaryShape | null;
};
```

Add `data_source: string | null;`:

```ts
type Benchmark = {
  group_key: string; name: string; debut_date: string | null;
  snapshot_at: string | null;
  data_source: string | null;
  summary: SummaryShape | null;
};
```

- [ ] **Step 2: Add EstBadge helper component**

In the same file, near the top (after existing helper components), add:

```tsx
function EstBadge({ source }: { source: string | null | undefined }) {
  if (!source || source === 'live') return null;
  const tip = source === 'backfill_estimate'
    ? 'Social Blade 추정 (±5%) — 곡선 모양 신뢰, 절대값은 참고만'
    : '네이버 뉴스 검색 키워드 카운트 — 검증값';
  const label = source === 'backfill_estimate' ? 'est' : 'bf';
  return (
    <span
      title={tip}
      class="ml-1 rounded bg-zinc-800/60 px-1 py-[1px] text-[10px] text-zinc-500"
    >{label}</span>
  );
}
```

- [ ] **Step 3: Use EstBadge in benchmark cells**

Locate the benchmark table (around line 343-380) where each `data.benchmarks.map((b) => ...)` renders a row of cells. The current cell pattern is something like:

```tsx
<td>{fmt(b.summary?.yt_subscribers)}</td>
```

Wrap each metric cell with `<EstBadge>`:

```tsx
<td>
  {fmt(b.summary?.yt_subscribers)}
  <EstBadge source={b.data_source} />
</td>
```

Apply this to every numeric cell in the benchmark table (yt_subscribers / yt_total_views / yt_total_videos / dc_total_posts / naver_total_news / twitter_posts — whichever are present). Read the actual lines first to get the exact JSX.

- [ ] **Step 4: Local sanity test**

```bash
cd /Users/user/Desktop/idol-sight/frontend
pnpm dev
```

Navigate to MiiWAN Briefing. Verify:
- 벤치마크 표가 정상 렌더 (Phase A 끝점에서는 PLAVE/SKINZ/MYRAKL/OWIS 셀에 라이브 데이터만 있어 'est' 배지가 yt_history_backfill 회고 분류된 행 외에는 거의 안 보임. 정상.)
- 회고 분류로 backfill_estimate 마킹된 행이 있으면 거기에 'est' 배지 표시.
- 호버 시 툴팁 노출.
- 콘솔 에러 없음.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/MiiWANBriefing.tsx
git commit -m "feat: MiiWANBriefing benchmark cells show est badge for non-live data"
```

---

### Task 7: Phase A 종합 스모크 테스트

**Files:** none (검증만)

- [ ] **Step 1: Migrations remote dry-run (적용 전 점검)**

```bash
cd /Users/user/Desktop/idol-sight/frontend
wrangler d1 migrations list idol-sight --remote
```

Expected: `0018_data_source.sql` 가 `pending` 상태로 표시.

- [ ] **Step 2: 사용자 확인 후 원격 적용**

⚠️ **사용자에게 확인 받은 후만 실행**:

```bash
wrangler d1 migrations apply idol-sight --remote
```

Expected: `🚣 0018_data_source.sql 🚣 successfully applied`

- [ ] **Step 3: 원격 D1 분포 확인**

```bash
wrangler d1 execute idol-sight --remote --command="SELECT data_source, COUNT(*) FROM agg_summary GROUP BY data_source;"
```

Expected: live + backfill_estimate 두 행.

- [ ] **Step 4: 프론트 production 배포 점검**

GitHub Actions가 자동 배포한 후 production URL에서:
- DebutCurve 페이지가 에러 없이 렌더
- MiiWANBriefing의 D-30 벤치마크 표가 정상 노출
- 콘솔 에러 없음
- 범례 3개 노출

- [ ] **Step 5: Phase A 마무리 커밋 없음 (이미 task별 커밋 완료)**

Phase A 완료. 이 시점에서 Phase B 시작 전에 스펙 §8.2의 수동 검증 항목 일부를 미리 통과시킨 셈.

---

## Phase B — 백필 데이터 (그룹별 1개씩)

각 그룹 백필은 동일 패턴이라 Task 9 (PLAVE)을 자세히 쓰고 Task 10/11/12는 동일 패턴 + 그룹별 출처 변경. **각 Task 코드/단계는 그대로 반복하되 그룹 키와 데뷔일과 출처 URL만 교체**.

---

### Task 8: SOURCES.md 스켈레톤

**Files:**
- Create: `scripts/historical_backfill/SOURCES.md`

- [ ] **Step 1: Create directory and skeleton**

```bash
mkdir -p /Users/user/Desktop/idol-sight/scripts/historical_backfill
```

Then create `scripts/historical_backfill/SOURCES.md`:

```markdown
# Historical Pre-Debut Backfill — 출처 및 검증 노트

대상: PLAVE / OWIS / SKINZ / MYRAKL의 데뷔 D-180 ~ D+90 구간 yt_subscribers + naver_total_news 백필.

방법론과 검증은 `docs/superpowers/specs/2026-05-06-historical-debut-backfill-design.md` §5 참조.

## 공통 검증 룰
- 주 1회 (월요일 00:00 KST) + 핵심 마일스톤 일자 일별 추가
- Cross-source 스폿체크: Social Blade vs Playboard 같은 날짜 ±10%
- Naver 뉴스 동명이인/무관 검색결과 30 샘플 수동 점검

---

## PLAVE (데뷔 2023-03-12, 백필창 2022-09-13 ~ 2023-06-10)
TBD — Task 9에서 채움

## SKINZ (데뷔 2025-04-10, 백필창 2024-10-12 ~ 2025-07-09)
TBD — Task 10에서 채움

## MYRAKL (데뷔 2026-01-26, 백필창 2025-07-30 ~ 2026-04-26)
TBD — Task 11에서 채움

## OWIS (데뷔 2026-03-23, 백필창 2025-09-24 ~ 현재)
TBD — Task 12에서 채움
```

- [ ] **Step 2: Commit**

```bash
git add scripts/historical_backfill/SOURCES.md
git commit -m "docs: scaffold historical backfill SOURCES.md"
```

---

### Task 9: PLAVE 백필

**Files:**
- Append: `migrations/0018_data_source.sql`
- Modify: `scripts/historical_backfill/SOURCES.md`

- [ ] **Step 1: Locate PLAVE YouTube channel and Social Blade page**

웹 리서치:
- 검색: `site:youtube.com PLAVE 공식 채널` → 채널 핸들 확보
- Social Blade URL 패턴: `https://socialblade.com/youtube/c/<handle>` 또는 `/channel/<channel_id>`
- Playboard fallback: `https://playboard.co/ko/channel/<channel_id>`

확보한 핸들/URL을 메모.

- [ ] **Step 2: Extract weekly subscriber counts D-180 ~ D+90**

Social Blade의 "Detailed Statistics" 표에서 일별 subscriber count를 본다. 백필 창 (2022-09-13 ~ 2023-06-10) 내 매주 월요일 (KST) + 마일스톤 일자(2023-03-12 데뷔, 2023-08-19 KCON 출연 — D+90 밖이므로 제외) 의 구독자 수치를 추출. ~40 샘플 + 마일스톤 ~3 = ~43 행.

기록 형식 (CSV로 임시):
```
date,subscribers
2022-09-19,5000
2022-09-26,7500
...
```

- [ ] **Step 3: Extract Naver News daily counts D-180 ~ D+90**

Naver News 검색 (`https://search.naver.com/search.naver?where=news&query=...&ds=YYYY.MM.DD&de=YYYY.MM.DD`):
- 쿼리: `"플레이브" OR "PLAVE"`
- 일자 필터: 각 백필 일자 단위로 검색, 결과 count 기록.

같은 ~43 일자에 대해 naver_total_news 카운트 회수.

- [ ] **Step 4: Validate**

검증 룰:
- Social Blade vs Playboard 동일 일자 ±10% 비교 — 5개 샘플
- 데뷔일 ±7일 트래픽 폭증 visible 확인
- Naver 뉴스 30개 샘플 수동 점검 (관련 없는 결과 비율 < 5%)

문제 발견 시 SOURCES.md에 노트.

- [ ] **Step 5: Append INSERTs to migration 0018**

`migrations/0018_data_source.sql` 파일 끝에 다음 패턴 추가:

```sql
-- ============================================================
-- PLAVE backfill (debut 2023-03-12, window 2022-09-13 ~ 2023-06-10)
-- Source: Social Blade @<handle> + Naver News keyword search
-- ============================================================
INSERT INTO agg_summary
  (group_key, snapshot_at,
   yt_total_videos, yt_total_views, yt_subscribers,
   dc_total_posts, theqoo_posts, instiz_posts,
   naver_total_news, twitter_posts, controversy_count, data_source)
VALUES
  ('plave', '2022-09-19T00:00:00Z', NULL, NULL, 5000, 0, 0, 0, 2, 0, 0, 'backfill_estimate'),
  ('plave', '2022-09-26T00:00:00Z', NULL, NULL, 7500, 0, 0, 0, 5, 0, 0, 'backfill_estimate'),
  -- ... ~43 rows total
  ('plave', '2023-06-05T00:00:00Z', NULL, NULL, 850000, 0, 0, 0, 18, 0, 0, 'backfill_estimate')
ON CONFLICT(group_key, snapshot_at) DO UPDATE SET
  yt_subscribers   = COALESCE(excluded.yt_subscribers, agg_summary.yt_subscribers),
  naver_total_news = CASE
    WHEN agg_summary.naver_total_news = 0 THEN excluded.naver_total_news
    ELSE agg_summary.naver_total_news
  END,
  data_source = excluded.data_source;
```

- [ ] **Step 6: Apply locally and verify**

```bash
cd /Users/user/Desktop/idol-sight/frontend
# Migration이 이미 적용된 상태일 수 있으므로 새 행만 직접 실행
wrangler d1 execute idol-sight --local --file=../migrations/0018_data_source.sql
wrangler d1 execute idol-sight --local --command="SELECT COUNT(*), MIN(snapshot_at), MAX(snapshot_at), MIN(yt_subscribers), MAX(yt_subscribers) FROM agg_summary WHERE group_key='plave' AND data_source='backfill_estimate';"
```

Expected: ~43 행, snapshot_at 범위 2022-09-19 ~ 2023-06-05, subscribers monotonic increase 일반적.

⚠️ **재실행 안전성**: ON CONFLICT DO UPDATE라 멱등. 같은 일자로 두 번 실행해도 데이터 안정.

- [ ] **Step 7: Verify chart**

```bash
pnpm dev
```

DebutCurve에서 메트릭=구독자, 코호트=K-POP, 범위=D-60~D+90 → PLAVE 라인이 D-60부터 D+90까지 점선으로 그려져야 함.

- [ ] **Step 8: Update SOURCES.md**

`scripts/historical_backfill/SOURCES.md`의 PLAVE 섹션을 채움:

```markdown
## PLAVE (데뷔 2023-03-12, 백필창 2022-09-13 ~ 2023-06-10)
- 채널 핸들: @<...>
- Social Blade: https://socialblade.com/youtube/c/<handle>
- Playboard fallback: https://playboard.co/ko/channel/<id>
- Naver News 쿼리: `"플레이브" OR "PLAVE"`
- 회수 일자 수: 43 (주간 40 + 마일스톤 3)
- Cross-source 검증: 5/5 일자에서 Social Blade vs Playboard ±X% 일치
- Naver 30 샘플 점검: 무관 결과 X건 (=Y%)
- 비고: <누락 일자 / 의심 데이터 / fallback 사용 일자>
```

- [ ] **Step 9: Commit**

```bash
git add migrations/0018_data_source.sql scripts/historical_backfill/SOURCES.md
git commit -m "feat: backfill PLAVE D-180~D+90 subscribers + naver news"
```

---

### Task 10: SKINZ 백필

**Files:**
- Append: `migrations/0018_data_source.sql`
- Modify: `scripts/historical_backfill/SOURCES.md`

Task 9와 동일 패턴. 차이만:
- group_key: `skinz`
- 데뷔: `2025-04-10`
- 백필창: `2024-10-12 ~ 2025-07-09`
- Naver 쿼리: `"SKINZ" OR "스킨즈"`
- 마일스톤 일자: 2024-12-23 (Bridge 공식 론칭), 2025-03-24 ~ 2025-03-27 (멤버 공개), 2025-04-10 (데뷔), 2025-11-29 — D+90 안만 (즉 2025-04-10 + 90일 = 2025-07-09까지)

- [ ] **Step 1**: Task 9 Step 1 동일 패턴, SKINZ 채널 핸들 확보
- [ ] **Step 2**: Task 9 Step 2 동일 패턴, SKINZ 구독자 추출 (~40 + 마일스톤 ~5)
- [ ] **Step 3**: Task 9 Step 3 동일 패턴, Naver News `"SKINZ" OR "스킨즈"`
- [ ] **Step 4**: Task 9 Step 4 동일 검증
- [ ] **Step 5**: 0018에 SKINZ INSERTs 블록 append (PLAVE 블록 아래)
- [ ] **Step 6**: 로컬 적용 + 행 수/범위 확인 (`group_key='skinz'`)
- [ ] **Step 7**: DebutCurve에서 SKINZ 라인 확인
- [ ] **Step 8**: SOURCES.md SKINZ 섹션 채움
- [ ] **Step 9**: Commit `feat: backfill SKINZ D-180~D+90 subscribers + naver news`

---

### Task 11: MYRAKL 백필

**Files:**
- Append: `migrations/0018_data_source.sql`
- Modify: `scripts/historical_backfill/SOURCES.md`

Task 9 동일 패턴. 차이만:
- group_key: `myrakl`
- 데뷔: `2026-01-26`
- 백필창: `2025-07-30 ~ 2026-04-26`
- Naver 쿼리: `"MY:RAKL" OR "마이라클"` — 콜론 이스케이프 주의
- 마일스톤 일자: ACCORD 공식 발표일 (Task 14에서 보충될 예정), 멤버 공개일들, 2026-01-26 데뷔
- ⚠️ 데뷔가 최근(2026-01)이라 D+90이 2026-04-26 → 현 시점(2026-05-06)에서 회수 가능

- [ ] **Step 1~9**: Task 9 패턴, MYRAKL 출처/일자로 교체
- [ ] **Commit**: `feat: backfill MYRAKL D-180~D+90 subscribers + naver news`

---

### Task 12: OWIS 백필

**Files:**
- Append: `migrations/0018_data_source.sql`
- Modify: `scripts/historical_backfill/SOURCES.md`

Task 9 동일 패턴. 차이만:
- group_key: `owis`
- 데뷔: `2026-03-23`
- 백필창: `2025-09-24 ~ 2026-06-21` (D+90이 미래) → 현 시점(2026-05-06)까지 회수 가능한 일자만 (즉 ~D+44).
- Naver 쿼리: `"OWIS" OR "오위스"`
- 마일스톤: 0017 시드의 pre_debut/announcement/data 참조 (2026-01-10 골든디스크 트레일러, 2026-01-13 ama 발표, 2026-02-23 멤버 티징, 2026-03-23 데뷔)
- ⚠️ D+90이 미래 → 현 시점까지만 회수, 나머지는 라이브 collector가 자연 채움

- [ ] **Step 1~9**: Task 9 패턴, OWIS 출처/일자로 교체
- [ ] **Commit**: `feat: backfill OWIS D-180~current subscribers + naver news`

---

## Phase C — 이벤트 보충

---

### Task 13: Migration 0019 — PLAVE 멤버 공개 + MYRAKL D-30 빌드업

**Files:**
- Create: `migrations/0019_pre_debut_events.sql`

- [ ] **Step 1: PLAVE 멤버 4명 개별 공개 일자 리서치**

웹 리서치:
- PLAVE 공식 트위터/블로그 / VLAST 공지 / 한국 언론 보도 검색 (예준/노아/밤비/하민 개별 공개 일자)
- 출처 URL 확보 (없으면 confidence='medium')

- [ ] **Step 2: MYRAKL D-30 buildup 리서치**

ACCORD Entertainment 공식 채널/보도자료에서:
- 회사 공식 발표일 (announcement)
- 멤버 5명 공개일들 (member_reveal)
- 콘셉트/티저 공개일들 (pre_debut)
- 쇼케이스 일자 (showcase)

각각 출처 URL과 confidence 등급 확보. ~5~7건.

- [ ] **Step 3: Create migration 0019**

```sql
-- migrations/0019_pre_debut_events.sql
-- 0017의 historical event seed에서 빠진 항목 보충:
--   PLAVE  — 4명 멤버 개별 공개 (member_reveal)
--   MYRAKL — D-30 buildup 통째로 (announcement / member_reveal / pre_debut / showcase)

INSERT INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence)
VALUES
  -- PLAVE 멤버 공개
  ('plave', 'YYYY-MM-DD', 'member_reveal', '예준(Yejun) 공개', NULL, 'https://...', 'high'),
  ('plave', 'YYYY-MM-DD', 'member_reveal', '노아(Noah) 공개', NULL, 'https://...', 'high'),
  ('plave', 'YYYY-MM-DD', 'member_reveal', '밤비(Bamby) 공개', NULL, 'https://...', 'high'),
  ('plave', 'YYYY-MM-DD', 'member_reveal', '하민(Hamin) 공개', NULL, 'https://...', 'high'),
  -- MYRAKL D-30 buildup
  ('myrakl', 'YYYY-MM-DD', 'announcement', 'ACCORD Entertainment MY:RAKL 공식 발표', '...', 'https://...', 'high'),
  ('myrakl', 'YYYY-MM-DD', 'member_reveal', '<멤버1> 공개', NULL, 'https://...', 'high'),
  ('myrakl', 'YYYY-MM-DD', 'member_reveal', '<멤버2> 공개', NULL, 'https://...', 'high'),
  -- ... 나머지 멤버 공개
  ('myrakl', 'YYYY-MM-DD', 'pre_debut', '데뷔 콘셉트 티저', NULL, 'https://...', 'medium'),
  ('myrakl', 'YYYY-MM-DD', 'showcase', '데뷔 쇼케이스', NULL, 'https://...', 'high');
```

⚠️ Step 1, 2의 리서치 결과로 `YYYY-MM-DD`, 멤버명, 출처 URL을 모두 채움. 미확정 일자는 NULL/source_url 결손 + confidence='medium' 또는 'low'로 기록.

- [ ] **Step 4: Apply locally and verify**

```bash
cd /Users/user/Desktop/idol-sight/frontend
wrangler d1 migrations apply idol-sight --local
wrangler d1 execute idol-sight --local --command="SELECT group_key, event_date, event_type, title FROM group_events WHERE event_date >= '2022-12-01' AND group_key IN ('plave','myrakl') ORDER BY event_date;"
```

Expected: PLAVE 4건 + MYRAKL ~5~7건.

- [ ] **Step 5: Verify in DebutCurve**

```bash
pnpm dev
```

DebutCurve에서 PLAVE 또는 MYRAKL 단독 격리 → 이벤트 마커 (▲)가 추가된 일자에 출현.

- [ ] **Step 6: Commit**

```bash
git add migrations/0019_pre_debut_events.sql
git commit -m "feat: supplement PLAVE member reveals + MYRAKL pre-debut events"
```

---

## Phase D — 종합 검증

---

### Task 14: 종합 검증 (Spec §8.2)

**Files:** none

- [ ] **Step 1: Local migrations clean apply**

```bash
cd /Users/user/Desktop/idol-sight/frontend
# clean DB 재구축
wrangler d1 migrations apply idol-sight --local
```

Expected: 0001 ~ 0019 전체 적용, 에러 없음.

- [ ] **Step 2: 프론트 검증 1 — DebutCurve 구독자**

```bash
pnpm dev
```

DebutCurve에서:
- 메트릭=구독자, 코호트=K-POP, 범위=D-60~D+90
- PLAVE/SKINZ/MYRAKL/OWIS 4개 라인이 **점선(estimate)** 으로 그려지는지
- MiiWAN 라인은 (라이브 데이터가 있다면) 실선
- 범례 3개 노출

- [ ] **Step 3: 프론트 검증 2 — DebutCurve 네이버 뉴스**

DebutCurve에서:
- 메트릭=네이버 뉴스
- 4그룹 라인이 **점선(estimate)** — naver_news는 exact이지만 같은 행에 estimate 컬럼(yt_subscribers)이 있어 행 전체 backfill_estimate
- (만약 naver_news만 있는 행이 있다면 가는 점선(exact)이 보일 수 있음)

- [ ] **Step 4: 프론트 검증 3 — MiiWANBriefing D-30 벤치마크**

MiiWANBriefing 진입:
- 코호트 비교 표에 PLAVE/SKINZ/MYRAKL/OWIS 4개 행 모두 데이터 채워짐
- 각 셀에 `est` 배지 (data_source != 'live'인 경우)
- 셀 hover 시 툴팁 "Social Blade 추정 (±5%)" 또는 "네이버 뉴스 검색 키워드 카운트"

- [ ] **Step 5: PLAVE Spot-check — 첫 음방 1위 inflection**

DebutCurve에서 PLAVE 단독 격리, 메트릭=구독자, 범위=D-60~D+365:
- 2024-03-06 (PLAVE 첫 음방 1위) 시점 ±7일에 구독자 곡선이 visible inflection
- 같은 시점 Social Blade에서 직접 본 그래프와 형태 일치

- [ ] **Step 6: 0017 이벤트 마커 점검**

DebutCurve에서 PLAVE 단독 격리:
- 2023-03-12 데뷔 마커 (🎬)
- 2024-03-06 첫 음방 1위 마커 (🏆)
- (Task 13의 멤버 공개 4건 마커도 보여야 함)

MYRAKL 단독 격리:
- 데뷔 마커 (2026-01-26)
- Task 13에서 보충된 announcement / member_reveal / showcase 마커들

- [ ] **Step 7: 원격 D1 적용 (사용자 명시 확인 필요)**

⚠️ **CLAUDE.md 룰: Cloudflare D1 원격 변경은 항상 사용자 확인 후 진행**

```bash
# 사용자 확인 후만:
wrangler d1 migrations apply idol-sight --remote
```

Expected: 0018 + 0019 successfully applied.

- [ ] **Step 8: production 검증**

GitHub Actions 자동 배포 대기 → 프로덕션 URL에서 Step 2~6 동일 검증.

- [ ] **Step 9: PR 생성 및 머지**

```bash
gh pr create --title "feat: historical pre-debut backfill for PLAVE/SKINZ/MYRAKL/OWIS" \
  --body "$(cat <<'EOF'
## Summary
- agg_summary.data_source 컬럼 도입 (live / backfill_exact / backfill_estimate)
- 4그룹 D-180 ~ D+90 yt_subscribers + naver_total_news 백필
- PLAVE 멤버 공개 + MYRAKL D-30 빌드업 group_events 보충
- DebutCurve segment.borderDash + MiiWANBriefing est 배지

## Test plan
- [x] 로컬 D1 migration 적용 OK
- [x] DebutCurve 구독자 / 네이버 뉴스 점선 렌더 OK
- [x] MiiWANBriefing D-30 벤치마크 표 채워짐 + est 배지 OK
- [x] PLAVE 첫 음방 1위 inflection 시각 일치
- [x] 원격 D1 적용 (사용자 확인 후)
- [x] production 검증

Spec: docs/superpowers/specs/2026-05-06-historical-debut-backfill-design.md
EOF
)"
```

---

## Self-Review (이 plan 자체)

**Spec 커버리지 점검**:
- §2 스코프 (4그룹, 2메트릭, D-180~D+90) → Phase B Task 9~12 ✓
- §4 스키마 (data_source 컬럼 + 회고 UPDATE + UPSERT 패턴) → Task 1, 2 ✓
- §5 출처/검증 → Task 8, 각 그룹 Task의 Step 4 ✓
- §6 UI → Task 3, 4, 5, 6 ✓
- §7 이벤트 보충 → Task 13 ✓
- §8 검증 → Task 7, 14 ✓

**Placeholder 점검**:
- Task 9~12에 INSERT VALUE의 실제 숫자는 비어있음 — 이는 의도적 (Phase B 실행 시점에 리서치하여 채움)
- Task 13의 `YYYY-MM-DD`, 멤버명, URL은 의도적 placeholder — 실행 시점 리서치
- 이외에는 모든 SQL/TS/Bash 코드가 완전한 형태

**타입 일관성**:
- `data_source: 'live' | 'backfill_exact' | 'backfill_estimate'` 가 Task 3 (debut-curve API), Task 5 (DebutCurve.tsx Series), Task 6 (MiiWANBriefing Benchmark)에서 일관됨 ✓
- `Map<number, { value: number; source: string }>` 가 Task 3 Step 3 일관됨 ✓
- ON CONFLICT pattern 이 Task 1 (스켈레톤), Task 9 Step 5 (실제 INSERT), Task 2 (yt_history_backfill UPDATE) 일관됨 ✓
