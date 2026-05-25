# Debut Window Expansion + 전체 기간 View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Debut Window Video Organicity 카드의 D-60/D+60 회귀 fix + 그룹의 모든 영상을 페이지 단위로 보는 "전체 기간" view 추가. 사용자가 그룹 상세 페이지에서 [Debut Window] / [전체 기간] 상단 탭으로 두 뷰를 전환.

**Architecture:** Worker `WINDOW_BUCKETS` 를 9 bucket (D-60..D+60) 으로 확장하되 V2.22 의 10일 정밀도 (D-20/D-10/D+10/D+20) 는 유지 — `CompetitorOrganicityBar` 호환. API 가 frontend 5 탭 라벨을 worker 9 bucket 으로 *server-side union mapping* 한다. 신규 `videos-all` endpoint 가 `youtube_videos LEFT JOIN debut_window_video_organicity` 로 그룹의 모든 영상을 published_at DESC + 페이지네이션으로 반환. Frontend `DebutWindowVideoTable` 에 view tab + 전체 기간 view 추가.

**Tech Stack:** Python 3.12 (worker `WINDOW_BUCKETS` + test), TypeScript (Cloudflare Pages Functions), Preact (frontend component), Cloudflare D1 (SQLite), pytest, vitest.

**Spec:** `docs/superpowers/specs/2026-05-25-debut-window-expansion-and-all-time-view-design.md`.

---

## File Structure

**Modify:**
- `worker/src/idol_sight/analysis/debut_window.py` — `WINDOW_BUCKETS` 9 bucket 으로 확장 (D-60, D+60 추가).
- `worker/tests/unit/test_debut_window.py` — `test_window_buckets_are_7_non_overlapping_ranges` → `_9_non_overlapping_ranges` 로 갱신 + 경계 케이스 5개 추가.
- `frontend/functions/api/debut-window/videos.ts` — `VALID_BUCKETS` 그대로 5개, SQL 의 `WHERE window_bucket = ?` 를 5→9 union 매핑 후 `IN (?, ?, ?)` 로.
- `frontend/src/api.ts` — `debutWindowVideosAll` client 함수 추가.
- `frontend/src/components/DebutWindowVideoTable.tsx` — view tab 상단 + 전체 기간 view (페이지네이션) + organicity 없는 row 의 "Insufficient" 표시 + 행 클릭 가드.

**Create:**
- `frontend/functions/api/debut-window/videos-all.ts` — 신규 페이지네이션 endpoint.

**No change (verified):**
- `frontend/src/components/CompetitorOrganicityBar.tsx` — worker 9 bucket 정밀도 그대로 사용.
- `frontend/src/components/DebutWindowKPI.tsx` — 회귀 상태 유지 (별도 후속 spec).
- `worker/src/idol_sight/cli.py` — `build_video_organicity` 호출 패턴 그대로.
- migration 없음 — worker 재실행 시 `_UPSERT_VIDEO_SQL` 이 idempotent 라 자동 backfill.

---

## Server-side 5 → 9 bucket union 매핑

전 task 에서 *동일한* 매핑 사용:

| Frontend bucket (UI) | Worker bucket(s) (DB) |
|---|---|
| `D-60`  | `('D-60',)`                |
| `D-30`  | `('D-30','D-20','D-10')`   |
| `D-Day` | `('D-Day',)`               |
| `D+30`  | `('D+10','D+20','D+30')`   |
| `D+60`  | `('D+60',)`                |

이 매핑은 `frontend/functions/api/debut-window/videos.ts` 안의 const 로 정의 (각 task 의 구현 단계에서 그대로 인용).

---

## Task 1: Worker WINDOW_BUCKETS 9 bucket 확장

**Files:**
- Modify: `worker/src/idol_sight/analysis/debut_window.py` (line 36-44 의 `WINDOW_BUCKETS` 리스트)
- Modify: `worker/tests/unit/test_debut_window.py` (line 21-29 의 `test_window_buckets_are_7_non_overlapping_ranges`)

- [ ] **Step 1: 기존 test 가 어떻게 실패하는지 먼저 확인**

```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_window_buckets_are_7_non_overlapping_ranges -v
```

Expected: PASS (현재 7 bucket 으로 통과 중). 이 task 가 끝나면 같은 test 가 9 bucket 으로 바뀌어야 한다.

- [ ] **Step 2: 기존 test 를 9 bucket assertion 으로 업데이트 (failing test)**

`worker/tests/unit/test_debut_window.py` 의 `test_window_buckets_are_7_non_overlapping_ranges` 함수를 통째로 다음으로 교체:

```python
def test_window_buckets_are_9_non_overlapping_ranges():
    """V3 (2026-05-25): 9 buckets, D-60 ~ D+60. V2.22 의 ±30 10일 정밀도
    (D-30/D-20/D-10/D+10/D+20/D+30) 유지 + D-60(-60,-31), D+60(31,60)
    두 개 추가. ±30~60 영상도 organicity 데이터에 포함되도록.

    Frontend (DebutWindowVideoTable.tsx) 의 5 탭 UI 는 server-side 에서
    이 9 bucket 을 union 매핑한다 — 자세한 매핑은 spec rev 의 §3.3 표.
    """
    assert len(WINDOW_BUCKETS) == 9
    labels = [b[0] for b in WINDOW_BUCKETS]
    assert labels == [
        "D-60", "D-30", "D-20", "D-10", "D-Day",
        "D+10", "D+20", "D+30", "D+60",
    ]
    flat = [(lo, hi) for _, lo, hi in WINDOW_BUCKETS]
    assert flat == [
        (-60, -31),
        (-30, -21),
        (-20, -11),
        (-10,  -2),
        ( -1,   1),
        (  2,  10),
        ( 11,  20),
        ( 21,  30),
        ( 31,  60),
    ]
```

- [ ] **Step 3: test 실행 — fail 확인**

```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_window_buckets_are_9_non_overlapping_ranges -v
```

Expected: FAIL with `AssertionError: assert 7 == 9` (또는 비슷한 assertion 실패).

- [ ] **Step 4: `WINDOW_BUCKETS` 9 bucket 으로 확장**

`worker/src/idol_sight/analysis/debut_window.py` 의 line 36-44 를 다음으로 교체:

```python
# (label, days_lo_inclusive, days_hi_inclusive). Ranges are non-overlapping
# and contiguous across the ±60 day debut window. V3 (2026-05-25): D-60/D+60
# 두 개 추가해 ±30~60 영상도 분류 (V2.22 의 ±30 10일 정밀도 유지). frontend
# 의 5 탭 UI (D-60/D-30/D-Day/D+30/D+60) 는 server-side 에서 이 9 bucket 을
# union 으로 매핑한다 — 자세한 매핑은 frontend/functions/api/debut-window/
# videos.ts 의 FRONTEND_BUCKET_MAP 참조.
WINDOW_BUCKETS: list[tuple[str, int, int]] = [
    ("D-60", -60, -31),
    ("D-30", -30, -21),
    ("D-20", -20, -11),
    ("D-10", -10,  -2),
    ("D-Day", -1,   1),
    ("D+10",   2,  10),
    ("D+20",  11,  20),
    ("D+30",  21,  30),
    ("D+60",  31,  60),
]
```

- [ ] **Step 5: target test PASS 확인**

```bash
cd worker && uv run pytest tests/unit/test_debut_window.py::test_window_buckets_are_9_non_overlapping_ranges -v
```

Expected: PASS.

- [ ] **Step 6: 경계 케이스 5개 추가 (failing tests)**

`worker/tests/unit/test_debut_window.py` 의 끝(파일 마지막)에 추가:

```python
def test_bucket_for_d_minus_60_range():
    """V3: -60 ~ -31 사이 영상은 D-60 bucket."""
    assert bucket_for(-60) == "D-60"
    assert bucket_for(-45) == "D-60"
    assert bucket_for(-31) == "D-60"


def test_bucket_for_d_plus_60_range():
    """V3: +31 ~ +60 사이 영상은 D+60 bucket."""
    assert bucket_for(31) == "D+60"
    assert bucket_for(45) == "D+60"
    assert bucket_for(60) == "D+60"


def test_bucket_for_d_minus_30_d_minus_60_boundary():
    """V3: -31 → D-60, -30 → D-30. 두 bucket 경계 정확."""
    assert bucket_for(-31) == "D-60"
    assert bucket_for(-30) == "D-30"


def test_bucket_for_d_plus_30_d_plus_60_boundary():
    """V3: +30 → D+30, +31 → D+60. 두 bucket 경계 정확."""
    assert bucket_for(30) == "D+30"
    assert bucket_for(31) == "D+60"


def test_bucket_for_outside_pm_60_returns_none():
    """V3: ±60 밖은 None (즉 -61, +61 영상은 organicity 분류 안 됨)."""
    assert bucket_for(-61) is None
    assert bucket_for(61) is None
    assert bucket_for(-100) is None
    assert bucket_for(100) is None
```

- [ ] **Step 7: 5 신규 test PASS 확인**

```bash
cd worker && uv run pytest tests/unit/test_debut_window.py -v 2>&1 | tail -20
```

Expected: 5 신규 test 모두 PASS + 기존 `test_bucket_for_returns_none_outside_window` 같이 ±30 밖 None 단정 test 가 *있다면 그건 fail* 할 수 있음. 그 경우 본문 확인 후 ±60 밖 단정으로 갱신.

다음 명령으로 빠른 사전 grep:
```bash
grep -n "test_bucket_for_returns_none_outside_window\|bucket_for(-31)\|bucket_for(31)" worker/tests/unit/test_debut_window.py
```

만약 `bucket_for(-31) is None` 또는 `bucket_for(31) is None` 같은 가정 test 가 있으면 그 단정도 새 9-bucket 기준으로 수정. (현재 V2.22 의 test 가 ±30 밖을 None 으로 단정했을 수 있음.)

- [ ] **Step 8: 전체 worker test 회귀 확인**

```bash
cd worker && uv run pytest 2>&1 | tail -3
```

Expected: 모든 test PASS (총 500+ 개).

- [ ] **Step 9: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add worker/src/idol_sight/analysis/debut_window.py worker/tests/unit/test_debut_window.py
git commit -m "feat(worker): debut_window — V3 WINDOW_BUCKETS 9 bucket (D-60~D+60)

V2.22 의 ±30 10일 정밀도 유지 + D-60(-60~-31), D+60(31~60) 두 bucket
추가. _FETCH_VIDEOS_SQL 은 이미 ±60 range 라 변경 불필요. build_video_
organicity 가 idempotent UPSERT 라 worker 재실행 시 기존 ±31~60 영상에
새 bucket 라벨이 자동 채워짐 (migration SQL 불필요).

기존 7-bucket assertion test 를 9-bucket 으로 갱신 + 경계 케이스 5개
신규. CompetitorOrganicityBar (V2.22 정밀도 의존) 영향 없음.

spec docs/superpowers/specs/2026-05-25-debut-window-expansion-and-all-
time-view-design.md §3.2."
```

---

## Task 2: API videos.ts 의 5 → 9 bucket union 매핑

**Files:**
- Modify: `frontend/functions/api/debut-window/videos.ts`

목적: frontend 가 `?bucket=D-30` 으로 호출했을 때 server 가 worker 의 D-30+D-20+D-10 row 를 union 으로 반환.

- [ ] **Step 1: 현재 videos.ts 의 구조 확인**

```bash
cat frontend/functions/api/debut-window/videos.ts
```

기존 SQL (line 44-53):
```typescript
let sql = `
  SELECT o.video_id, v.title, o.is_short, o.published_at,
         o.days_relative_to_debut,
         o.view_count, o.like_count, o.comment_count,
         o.engagement_rate, o.like_comment_ratio, o.velocity_ratio,
         o.organic_score, o.verdict, o.causes, o.signal_breakdown
  FROM debut_window_video_organicity o
  LEFT JOIN youtube_videos v ON v.video_id = o.video_id
  WHERE o.group_key = ? AND o.window_bucket = ?
`;
const params: (string | number)[] = [group, bucket];
```

- [ ] **Step 2: `FRONTEND_BUCKET_MAP` 상수 추가 + SQL 을 `IN (...)` 으로**

`frontend/functions/api/debut-window/videos.ts` 의 line 28 (`VALID_BUCKETS` 정의 직후) 에 다음 추가:

```typescript
// V3 (2026-05-25): frontend 5 탭 ↔ worker 9 bucket union 매핑.
// Worker 의 WINDOW_BUCKETS 가 V2.22 의 ±30 10일 정밀도 (D-30/D-20/D-10/
// D+10/D+20/D+30) 를 유지하면서 ±60 까지 확장됐다. frontend UI 는 5 탭
// (D-60/D-30/D-Day/D+30/D+60) 만 노출하므로, 이 endpoint 가 frontend
// bucket 을 받아 worker bucket(s) 의 union 으로 SQL IN 쿼리한다.
// spec docs/.../2026-05-25-debut-window-expansion-and-all-time-view-design.md §3.3.
const FRONTEND_BUCKET_MAP: Record<string, string[]> = {
  "D-60":  ["D-60"],
  "D-30":  ["D-30", "D-20", "D-10"],
  "D-Day": ["D-Day"],
  "D+30":  ["D+10", "D+20", "D+30"],
  "D+60":  ["D+60"],
};
```

그리고 line 44-54 의 SQL 빌드 부분을 다음으로 교체:

```typescript
  const workerBuckets = FRONTEND_BUCKET_MAP[bucket]!;   // VALID_BUCKETS 통과 보장
  const bucketPlaceholders = workerBuckets.map(() => "?").join(",");
  let sql = `
    SELECT o.video_id, v.title, o.is_short, o.published_at,
           o.days_relative_to_debut,
           o.view_count, o.like_count, o.comment_count,
           o.engagement_rate, o.like_comment_ratio, o.velocity_ratio,
           o.organic_score, o.verdict, o.causes, o.signal_breakdown
    FROM debut_window_video_organicity o
    LEFT JOIN youtube_videos v ON v.video_id = o.video_id
    WHERE o.group_key = ? AND o.window_bucket IN (${bucketPlaceholders})
  `;
  const params: (string | number)[] = [group, ...workerBuckets];
```

`ORDER BY` 절은 그대로 유지 (`days_relative_to_debut ASC, published_at ASC`).

- [ ] **Step 3: typecheck + 빌드 검증**

```bash
cd frontend && npm run typecheck 2>&1 | tail -5
```

Expected: 출력 없음 (성공).

- [ ] **Step 4: 로컬 wrangler 로 동작 확인 (선택)**

만약 D1 로컬 DB 가 있다면:
```bash
cd frontend && wrangler d1 execute idol-sight --local --command "SELECT COUNT(*) FROM debut_window_video_organicity WHERE group_key='plave' AND window_bucket IN ('D-30','D-20','D-10');"
```

Expected: 양수 (D-30 frontend 탭이 union 으로 받을 row 수).

- [ ] **Step 5: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add frontend/functions/api/debut-window/videos.ts
git commit -m "feat(api): debut-window/videos — frontend 5 탭 → worker 9 bucket union 매핑

V3 회귀 fix: frontend 의 D-30/D+30 탭이 worker 의 10일 정밀 bucket 들
(D-30+D-20+D-10 / D+10+D+20+D+30) 를 union 으로 받아 ±30일 전 구간을
보여줌. D-60/D+60 도 worker 의 신규 bucket (Task 1) 그대로 매핑.

VALID_BUCKETS 5개 그대로 유지 — frontend UI 호환. 새 FRONTEND_BUCKET_MAP
상수가 union 변환. SQL 이 'window_bucket = ?' → 'IN (?, ?, ?)' 로 변경.

spec §3.3."
```

---

## Task 3: 새 API videos-all.ts (페이지네이션 endpoint)

**Files:**
- Create: `frontend/functions/api/debut-window/videos-all.ts`

목적: 그룹의 *모든* 영상 (organicity 유무 무관) 을 published_at DESC 정렬 + 페이지네이션으로 반환.

- [ ] **Step 1: 새 파일 작성**

`frontend/functions/api/debut-window/videos-all.ts`:

```typescript
// frontend/functions/api/debut-window/videos-all.ts
//
// V3 (2026-05-25): 그룹의 *모든* 영상을 published_at DESC + 페이지네이션
// 으로 반환한다. organicity 가 없는 ±60d 밖 영상도 포함 (LEFT JOIN, NULL
// 컬럼). DebutWindowVideoTable 의 [전체 기간] view 가 이 endpoint 사용.
//
// 기존 /api/debut-window/videos 는 (group, bucket) 페어 조회 전용 그대로.
//
// Query params:
//   group  (required): group_key
//   offset (optional, default 0):  페이지 시작 row index
//   limit  (optional, default 30): 페이지 크기 (max 100)
//   type   (optional, default 'all'): all|long|short — Long-form/Shorts 필터
//
// Response: { group, type, total, offset, limit, rows }

import { d1Query, type D1Database } from "../../lib/d1";
import { jsonResponse } from "../../lib/jsonResponse";

interface VideoRowAll {
  video_id: string;
  title: string | null;
  is_short: number;
  published_at: string;
  // organicity LEFT JOIN — ±60d 밖 영상은 모두 null.
  days_relative_to_debut: number | null;
  window_bucket: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  engagement_rate: number | null;
  like_comment_ratio: number | null;
  velocity_ratio: number | null;
  organic_score: number | null;
  verdict: string | null;
  causes: string | null;
  signal_breakdown: string | null;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export const onRequestGet: PagesFunction<{ DB: D1Database }> = async ({ env, request }) => {
  const url = new URL(request.url);
  const group = url.searchParams.get("group");
  const offsetRaw = url.searchParams.get("offset");
  const limitRaw = url.searchParams.get("limit");
  const type = url.searchParams.get("type") ?? "all";

  if (!group) return jsonResponse({ error: "group required" }, 400);
  if (!["all", "long", "short"].includes(type)) {
    return jsonResponse({ error: "type must be all|long|short" }, 400);
  }

  let offset = offsetRaw === null ? 0 : parseInt(offsetRaw, 10);
  let limit  = limitRaw  === null ? DEFAULT_LIMIT : parseInt(limitRaw, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const typeFilter =
    type === "long"  ? " AND v.is_short = 0"
    : type === "short" ? " AND v.is_short = 1"
    : "";

  // 영상 stats 는 organicity 가 없을 수도 있는 영상의 view/like/comment 를
  // 컬럼에 채우기 위해 별도 LEFT JOIN. organicity 가 있는 경우는 o.view_count
  // 등이 채워져 있어 stats LEFT JOIN 의 동일 컬럼을 덮어쓰지 않도록 COALESCE.
  const rowsSql = `
    SELECT v.video_id, v.title, v.is_short, v.published_at,
           o.days_relative_to_debut, o.window_bucket,
           COALESCE(o.view_count,    s.views)    AS view_count,
           COALESCE(o.like_count,    s.likes)    AS like_count,
           COALESCE(o.comment_count, s.comments) AS comment_count,
           o.engagement_rate, o.like_comment_ratio, o.velocity_ratio,
           o.organic_score, o.verdict, o.causes, o.signal_breakdown
    FROM youtube_videos v
    LEFT JOIN debut_window_video_organicity o ON o.video_id = v.video_id
    LEFT JOIN youtube_video_stats s
      ON s.video_id = v.video_id
     AND s.snapshot_at = (
       SELECT MAX(snapshot_at) FROM youtube_video_stats WHERE video_id = v.video_id
     )
    WHERE v.group_key = ?${typeFilter}
    ORDER BY v.published_at DESC
    LIMIT ? OFFSET ?
  `;

  const countSql = `
    SELECT COUNT(*) AS n
    FROM youtube_videos v
    WHERE v.group_key = ?${typeFilter}
  `;

  const rows = await d1Query<VideoRowAll>(env.DB, rowsSql, [group, limit, offset]);
  const countRow = await d1Query<{ n: number }>(env.DB, countSql, [group]);
  const total = countRow[0]?.n ?? 0;

  return jsonResponse({ group, type, total, offset, limit, rows }, 200);
};
```

- [ ] **Step 2: typecheck**

```bash
cd frontend && npm run typecheck 2>&1 | tail -5
```

Expected: 출력 없음 (성공).

- [ ] **Step 3: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add frontend/functions/api/debut-window/videos-all.ts
git commit -m "feat(api): debut-window/videos-all — 전체 영상 페이지네이션 endpoint

DebutWindowVideoTable 의 [전체 기간] view 가 호출. 그룹의 모든 영상을
published_at DESC + offset/limit 페이지네이션 + Long/Shorts 필터로 반환.

organicity 가 없는 ±60d 밖 영상은 LEFT JOIN — score/verdict 컬럼 NULL.
view/like/comment 는 organicity 의 캐시 값을 우선, 없으면 youtube_video_
stats 최신 snapshot 사용 (COALESCE).

limit default 30, max 100. total count 별도 query 로 페이지 합계 계산.

spec §3.3."
```

---

## Task 4: Frontend api.ts 의 debutWindowVideosAll client 함수

**Files:**
- Modify: `frontend/src/api.ts` (line 47-48 의 `debutWindowVideos` 직후)

- [ ] **Step 1: client 함수 추가**

`frontend/src/api.ts` 의 line 48 (`debutWindowVideos` 정의 끝) 직후에 다음 추가:

```typescript
  debutWindowVideosAll: (
    group: string,
    offset: number,
    limit: number,
    type: "all" | "long" | "short" = "all",
  ) =>
    getJson<any>(
      `/api/debut-window/videos-all?group=${encodeURIComponent(group)}`
      + `&offset=${offset}&limit=${limit}&type=${type}`,
    ),
```

- [ ] **Step 2: typecheck**

```bash
cd frontend && npm run typecheck 2>&1 | tail -5
```

Expected: 출력 없음.

- [ ] **Step 3: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add frontend/src/api.ts
git commit -m "feat(frontend): api — debutWindowVideosAll client 함수

DebutWindowVideoTable 의 [전체 기간] view 가 호출하는 client. 신규
/api/debut-window/videos-all endpoint 와 1:1 매칭.

spec §3.5."
```

---

## Task 5: Frontend DebutWindowVideoTable view tab + 전체 기간 view

**Files:**
- Modify: `frontend/src/components/DebutWindowVideoTable.tsx` (전체 컴포넌트 변경)

가장 큰 task. 핵심 변화:
1. `viewMode` 상태 (`debut` | `all`) 추가.
2. 상단 view tab UI 추가.
3. `viewMode === "all"` 일 때:
   - 5 bucket 탭 hide
   - PUBLISHED 컬럼 (D-DAY 대신)
   - 페이지네이션 컨트롤
   - organicity NULL row 의 "Insufficient" 표시

- [ ] **Step 1: 컴포넌트 전체 교체**

`frontend/src/components/DebutWindowVideoTable.tsx` 전체를 다음으로 교체:

```typescript
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { DebutWindowSignalPanel } from "./DebutWindowSignalPanel";

const BUCKETS = ["D-60", "D-30", "D-Day", "D+30", "D+60"] as const;
type Bucket = typeof BUCKETS[number];
type FilterType = "all" | "long" | "short";
type ViewMode = "debut" | "all";

const PAGE_SIZE = 30;

// VideoRow 는 두 view 가 공유 (전체 기간 view 는 score/verdict null 가능).
interface VideoRow {
  video_id: string;
  title: string | null;
  is_short: number;
  published_at?: string;                         // all view 에서만 사용
  days_relative_to_debut: number | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  engagement_rate: number | null;
  organic_score: number | null;
  verdict: string | null;
  causes: string | null;
  signal_breakdown: string | null;
}

interface Props {
  groupKey: string;
}

// V2.21 5-tier color scale.
function verdictColor(v: string | null): string {
  if (v === "organic_strong") return "#16a34a";
  if (v === "organic")        return "#22c55e";
  if (v === "borderline")     return "#eab308";
  if (v === "suspect")        return "#f97316";
  if (v === "likely_paid")    return "#ef4444";
  return "#6b7280";  // insufficient_data / null
}

function verdictLabelShort(v: string | null): string {
  if (v === "organic_strong") return "Strong";
  if (v === "organic")        return "Organic";
  if (v === "borderline")     return "Border";
  if (v === "suspect")        return "Suspect";
  if (v === "likely_paid")    return "Paid";
  if (v === "insufficient_data") return "Insufficient";
  if (v === null)                return "Insufficient";   // V3: organicity 없음
  return v;
}

const CAUSE_LABEL: Record<string, string> = {
  viral_real:      "viral",
  engagement_weak: "engagement↓",
  comment_farm:    "comment-farm",
  like_farm:       "like-farm",
  paid_burst:      "paid-burst",
};

function parseCauses(causes: string | null): string[] {
  if (!causes) return [];
  try {
    const parsed = JSON.parse(causes);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function fmtViews(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtPublishedDate(iso: string | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 10);   // 'YYYY-MM-DD'
}

export function DebutWindowVideoTable({ groupKey }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("debut");
  const [bucket, setBucket] = useState<Bucket>("D-30");
  const [filterType, setFilterType] = useState<FilterType>("all");
  // Debut Window view rows
  const [rows, setRows] = useState<VideoRow[] | null>(null);
  // 전체 기간 view state
  const [allRows, setAllRows] = useState<VideoRow[] | null>(null);
  const [allTotal, setAllTotal] = useState(0);
  const [page, setPage] = useState(0);

  const [selected, setSelected] = useState<VideoRow | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // Debut Window view 데이터 fetch
  useEffect(() => {
    if (viewMode !== "debut") return;
    setRows(null);
    setSelected(null);
    let cancelled = false;
    api.debutWindowVideos(groupKey, bucket, filterType).then((r: { rows: VideoRow[] }) => {
      if (!cancelled) setRows(r.rows);
    }).catch(() => {
      if (!cancelled) setRows([]);
    });
    return () => { cancelled = true; };
  }, [viewMode, groupKey, bucket, filterType]);

  // 전체 기간 view 데이터 fetch
  useEffect(() => {
    if (viewMode !== "all") return;
    setAllRows(null);
    setSelected(null);
    let cancelled = false;
    api.debutWindowVideosAll(groupKey, page * PAGE_SIZE, PAGE_SIZE, filterType).then(
      (r: { rows: VideoRow[]; total: number }) => {
        if (cancelled) return;
        setAllRows(r.rows);
        setAllTotal(r.total);
      },
    ).catch(() => {
      if (!cancelled) { setAllRows([]); setAllTotal(0); }
    });
    return () => { cancelled = true; };
  }, [viewMode, groupKey, page, filterType]);

  // viewMode / filterType 변경 시 페이지 0 으로 reset
  useEffect(() => { setPage(0); }, [viewMode, filterType, groupKey]);

  const currentRows = viewMode === "debut" ? rows : allRows;
  const totalPages = Math.max(1, Math.ceil(allTotal / PAGE_SIZE));

  return (
    <>
      <section class={"dw-video-section" + (selected ? " with-panel" : "")}>
        <div class="dw-video-main">
          {/* 상단 view tab — Debut Window / 전체 기간 */}
          <div class="mb-1 flex items-center justify-between gap-2">
            <nav class="dw-view-tabs">
              <button type="button"
                      class={viewMode === "debut" ? "active" : ""}
                      onClick={() => setViewMode("debut")}>Debut Window</button>
              <button type="button"
                      class={viewMode === "all" ? "active" : ""}
                      onClick={() => setViewMode("all")}>전체 기간</button>
            </nav>
            <button
              type="button"
              class="dw-help-icon"
              onClick={() => setHelpOpen(true)}
              aria-label="Show score formula"
              title="Score 산정 방식 보기"
            >ⓘ</button>
          </div>

          {/* Debut Window view 의 5 bucket 탭 */}
          {viewMode === "debut" && (
            <nav class="dw-bucket-tabs">
              {BUCKETS.map((b) => (
                <button type="button"
                        key={b}
                        class={b === bucket ? "active" : ""}
                        onClick={() => setBucket(b)}>{b}</button>
              ))}
            </nav>
          )}

          {/* Long/Shorts 필터 — 두 view 공통 */}
          <div class="dw-type-filter">
            <span class="dw-type-filter-label">Filter:</span>
            {(["all", "long", "short"] as const).map((t) => (
              <button type="button"
                      key={t}
                      class={filterType === t ? "active" : ""}
                      onClick={() => setFilterType(t)}>
                {t === "all" ? "All" : t === "long" ? "Long-form" : "Shorts"}
              </button>
            ))}
          </div>

          <div class="dw-table-wrap">
            <table class="dw-video-table">
              <thead>
                <tr>
                  {viewMode === "debut"
                    ? <th class="dw-num">D-day</th>
                    : <th>Published</th>}
                  <th>Title</th>
                  <th>Type</th>
                  <th class="dw-num">Views</th>
                  <th class="dw-num">ER</th>
                  <th class="dw-num">Score</th>
                  <th>판정</th>
                </tr>
              </thead>
              <tbody>
                {currentRows === null && (
                  <tr><td class="dw-empty-cell" colSpan={7}>Loading…</td></tr>
                )}
                {currentRows !== null && currentRows.length === 0 && (
                  <tr><td class="dw-empty-cell" colSpan={7}>
                    {viewMode === "debut" ? "No videos in this bucket" : "No videos"}
                  </td></tr>
                )}
                {currentRows !== null && currentRows.map((r) => {
                  const dayLabel = r.days_relative_to_debut === null
                    ? "—"
                    : r.days_relative_to_debut >= 0
                      ? `+${r.days_relative_to_debut}`
                      : `${r.days_relative_to_debut}`;
                  const firstColumn = viewMode === "debut"
                    ? dayLabel
                    : fmtPublishedDate(r.published_at);
                  const isSelected = selected?.video_id === r.video_id;
                  const canSelect = r.signal_breakdown !== null && r.signal_breakdown !== undefined;
                  return (
                    <tr key={r.video_id}
                        onClick={() => {
                          if (!canSelect) return;
                          setSelected(isSelected ? null : r);
                        }}
                        class={(canSelect ? "dw-row-clickable" : "")
                              + (isSelected ? " selected" : "")}>
                      <td class={viewMode === "debut" ? "dw-num" : ""}>{firstColumn}</td>
                      <td class="dw-title-cell" title={r.title ?? ""}>
                        {r.title ?? r.video_id}
                      </td>
                      <td>{r.is_short ? "Shorts" : "Long"}</td>
                      <td class="dw-num">{fmtViews(r.view_count)}</td>
                      <td class="dw-num">
                        {r.engagement_rate === null
                          ? "—"
                          : `${(r.engagement_rate * 100).toFixed(2)}%`}
                      </td>
                      <td class="dw-num">{r.organic_score ?? "—"}</td>
                      <td>
                        <span class="dw-verdict-pill"
                              style={{ background: verdictColor(r.verdict) }}>
                          {verdictLabelShort(r.verdict)}
                        </span>
                        {parseCauses(r.causes).map((c) => (
                          <span class={"dw-cause-chip dw-cause-" + c} key={c} title={c}>
                            {CAUSE_LABEL[c] ?? c}
                          </span>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 전체 기간 view 의 페이지네이션 컨트롤 */}
          {viewMode === "all" && allRows !== null && allTotal > 0 && (
            <div class="dw-pagination">
              <button type="button"
                      disabled={page === 0}
                      onClick={() => setPage(page - 1)}>← 이전</button>
              <span class="dw-pagination-info">
                {page + 1} / {totalPages}
                <span class="dw-pagination-total"> (총 {allTotal}개)</span>
              </span>
              <button type="button"
                      disabled={(page + 1) >= totalPages}
                      onClick={() => setPage(page + 1)}>다음 →</button>
            </div>
          )}
        </div>

        {selected && selected.signal_breakdown && (
          <DebutWindowSignalPanel
            videoId={selected.video_id}
            title={selected.title}
            signalBreakdown={selected.signal_breakdown}
            onClose={() => setSelected(null)}
          />
        )}
      </section>

      {helpOpen && <DebutWindowHelpModal onClose={() => setHelpOpen(false)} />}
    </>
  );
}

/* ------------------------------------------------------------------ *\
 * Help modal: Score 산정 방식 + verdict thresholds + ER 의미.
 * (변경 없음 — 기존 코드 그대로)
\* ------------------------------------------------------------------ */
function DebutWindowHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
         onClick={onClose}>
      <div class="max-h-[90vh] w-full max-w-2xl overflow-y-auto
                  rounded-lg border border-zinc-800 bg-zinc-900 p-4 text-sm"
           onClick={(e) => e.stopPropagation()}>
        <div class="mb-3 flex items-center justify-between">
          <h3 class="font-semibold text-zinc-100">
            Debut Window Organicity 점수 산정 방식
          </h3>
          <button class="text-zinc-500 hover:text-zinc-300"
                  onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div class="space-y-3 text-zinc-300 text-xs leading-relaxed">
          <p>
            영상 1개당 <strong class="text-zinc-100">0–100점</strong> +
            verdict (organic / suspect / likely_paid / insufficient_data).
            <br />
            3개 신호의 가중 평균.
          </p>

          <div class="overflow-x-auto rounded border border-zinc-800">
            <table class="w-full min-w-[560px] tabular-nums text-[11px]">
              <thead class="bg-zinc-900/60 text-zinc-500">
                <tr>
                  <th class="px-2 py-1.5 text-left">신호</th>
                  <th class="px-2 py-1.5 text-left">입력</th>
                  <th class="px-2 py-1.5 text-right">가중치</th>
                  <th class="px-2 py-1.5 text-left">100점 기준</th>
                  <th class="px-2 py-1.5 text-left">0점 기준</th>
                </tr>
              </thead>
              <tbody class="text-zinc-300">
                <tr class="border-t border-zinc-800/60">
                  <td class="px-2 py-1.5">engagement_score</td>
                  <td class="px-2 py-1.5">(likes+comments)/views</td>
                  <td class="px-2 py-1.5 text-right">0.5</td>
                  <td class="px-2 py-1.5">≥6.0% (Long) / 8.0% (Shorts)</td>
                  <td class="px-2 py-1.5">≤1.0% / 1.5%</td>
                </tr>
                <tr class="border-t border-zinc-800/60">
                  <td class="px-2 py-1.5">balance_score</td>
                  <td class="px-2 py-1.5">likes/comments 비율</td>
                  <td class="px-2 py-1.5 text-right">0.3</td>
                  <td class="px-2 py-1.5">Long 10~50 / Shorts 20~150</td>
                  <td class="px-2 py-1.5">미만 댓글농장 / 초과 좋아요농장</td>
                </tr>
                <tr class="border-t border-zinc-800/60">
                  <td class="px-2 py-1.5">velocity_coherence</td>
                  <td class="px-2 py-1.5">viral_velocity × ER</td>
                  <td class="px-2 py-1.5 text-right">0.2 *</td>
                  <td class="px-2 py-1.5">폭발 + 정상 engagement</td>
                  <td class="px-2 py-1.5">폭발인데 engagement 죽음</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2">
            <div class="mb-1 font-semibold text-zinc-200">Verdict 임계값 (V2.21 5-tier)</div>
            <ul class="ml-3 list-disc space-y-0.5 text-zinc-400">
              <li><span style={{ color: "#16a34a" }}>≥85</span> organic_strong (확신, viral 케이스 자주 동반)</li>
              <li><span style={{ color: "#22c55e" }}>70–84</span> organic (자연 호응)</li>
              <li><span style={{ color: "#eab308" }}>55–69</span> borderline (검토 필요)</li>
              <li><span style={{ color: "#f97316" }}>40–54</span> suspect (의심)</li>
              <li><span style={{ color: "#ef4444" }}>&lt;40</span> likely_paid (강한 의심)</li>
              <li><span class="text-zinc-500">insufficient_data</span>
                (view &lt; 1000 AND likes+comments &lt; 10)
              </li>
            </ul>
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2">
            <div class="mb-1 font-semibold text-zinc-200">Cause tags (자동 부착)</div>
            <ul class="ml-3 list-disc space-y-0.5 text-zinc-400">
              <li><strong>viral</strong> — velocity ≥1.5 + ER ≥3% (진짜 viral, organic에도 부착)</li>
              <li><strong>engagement↓</strong> — engagement_score &lt; 40 (ER 자체 낮음)</li>
              <li><strong>comment-farm</strong> — balance &lt; 60 + ratio &lt; normal_lo</li>
              <li><strong>like-farm</strong> — balance &lt; 60 + ratio &gt; normal_hi</li>
              <li><strong>paid-burst</strong> — velocity coherence ≤ 20 (view 폭발 vs engagement 빈약)</li>
            </ul>
            <p class="mt-1 text-[10px] text-zinc-500">
              의심 cause는 borderline 이하 verdict 에만 부착. viral 은 verdict 무관.
            </p>
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2 text-zinc-400">
            <span class="font-semibold text-zinc-200">ER 열의 의미</span>:{" "}
            Engagement Rate = (좋아요 + 댓글) / 조회수 (좋아요 단독 수치 아님)
          </div>

          <div class="rounded border border-zinc-800/60 bg-zinc-900/40 p-2 text-zinc-400 text-[11px]">
            <span class="font-semibold text-zinc-200">* velocity_coherence</span>{" "}
            데이터(viral_velocity_ratio)는 현재 약 91%의 영상에서 NULL.
            NULL인 경우 weight 0.2가 engagement(0.625)/balance(0.375)로 재분배됨.
          </div>

          <p class="text-zinc-500 italic text-[11px]">
            v2 calibration (2026-05-13, 9그룹 1125영상 분포 기반). verify manually before external use.
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: CSS 클래스 추가 (`dw-view-tabs`, `dw-pagination`)**

`frontend/src/styles.css` 끝에 추가:

```css
/* V3: Debut Window view tab (상위 [Debut Window] [전체 기간]) */
.dw-view-tabs {
  display: inline-flex;
  gap: 0.25rem;
  padding: 0.125rem;
  border-radius: 0.375rem;
  background: rgb(24 24 27 / 0.6);   /* zinc-900/60 */
  border: 1px solid rgb(39 39 42);   /* zinc-800 */
}
.dw-view-tabs > button {
  padding: 0.25rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: rgb(161 161 170);           /* zinc-400 */
  background: transparent;
  border-radius: 0.25rem;
  transition: color 120ms, background 120ms;
}
.dw-view-tabs > button:hover {
  color: rgb(228 228 231);           /* zinc-200 */
}
.dw-view-tabs > button.active {
  color: rgb(244 244 245);           /* zinc-100 */
  background: rgb(63 63 70);         /* zinc-700 */
}

/* V3: 전체 기간 view 페이지네이션 컨트롤 */
.dw-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
  padding: 0.375rem 0;
  font-size: 0.75rem;
  color: rgb(161 161 170);
}
.dw-pagination > button {
  padding: 0.25rem 0.625rem;
  font-weight: 500;
  color: rgb(228 228 231);
  background: rgb(39 39 42);
  border-radius: 0.25rem;
  transition: background 120ms;
}
.dw-pagination > button:hover:not(:disabled) {
  background: rgb(63 63 70);
}
.dw-pagination > button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.dw-pagination-info { white-space: nowrap; }
.dw-pagination-total {
  color: rgb(113 113 122);           /* zinc-500 */
}
```

- [ ] **Step 3: typecheck + 빌드**

```bash
cd frontend && npm run typecheck 2>&1 | tail -5
```

Expected: 출력 없음.

```bash
cd frontend && npm test 2>&1 | tail -5
```

Expected: 95 passed (회귀 없음).

- [ ] **Step 4: 로컬 dev 서버로 빌드 검증 (선택, 가능 시)**

```bash
cd frontend && npm run build 2>&1 | tail -10
```

Expected: `vite build` 가 성공적으로 완료 (rollup output).

- [ ] **Step 5: Commit**

```bash
cd /Users/user/Desktop/idol-sight && git add frontend/src/components/DebutWindowVideoTable.tsx frontend/src/styles.css
git commit -m "feat(frontend): DebutWindowVideoTable — view tab + 전체 기간 페이지네이션

상단 [Debut Window] [전체 기간] 2-탭 추가.
Debut Window view (기본 활성) 는 기존 5 bucket 탭 + 필터 + 시그널 패널
모두 유지.

전체 기간 view 신규:
- 5 bucket 탭 hide, Long/Shorts 필터 유지
- 컬럼 D-DAY → Published (YYYY-MM-DD)
- 페이지네이션 30개/페이지, 이전/다음 + 'N / 총 M' 표시
- organicity 가 없는 ±60d 밖 영상은 Score/ER '—', 판정 'Insufficient'
- signal_breakdown 가 없으면 행 클릭 비활성 (사이드 패널 안 열림)

styles.css 에 .dw-view-tabs / .dw-pagination 클래스 추가.

spec §3.1, §3.4."
```

---

## Task 6: e2e 운영 검증

**Files (no new):**
- 검증만 — code 변경 없음.

- [ ] **Step 1: 모든 새 commit push**

```bash
cd /Users/user/Desktop/idol-sight && git push origin main
```

Expected: 5 commits push 성공 (Task 1~5 의 commit 5개).

- [ ] **Step 2: Cloudflare Pages 자동 deploy 대기**

```bash
gh run list --workflow=frontend-deploy.yml --limit 1 2>&1 | head -3
```

Expected: 직전 push 가 트리거한 frontend-deploy workflow 실행 중 또는 완료.

```bash
gh run watch <run_id> --exit-status
```

Expected: deploy 성공.

- [ ] **Step 3: Worker 재실행으로 D-60/D+60 영상 organicity 데이터 채우기**

매일 자동 daily aggregate cron 이 `build_video_organicity` 를 호출하지만, 즉시 검증 위해 manual trigger:

```bash
gh workflow run collect-daily.yml 2>&1
```

또는 더 직접적으로 cli 명령으로 (만약 별도 서브커맨드 있다면):
```bash
# aggregate 안에 debut_window 빌드가 포함됨 (cli.py:382-404)
gh workflow run analyze-weekly.yml -f week_start=2026-05-17 -f week_end=2026-05-23
```

Expected: workflow 성공.

- [ ] **Step 4: D1 에서 D-60/D+60 bucket row 생성 확인**

```bash
cd /Users/user/Desktop/idol-sight/frontend && wrangler d1 execute idol-sight --remote --command "SELECT window_bucket, COUNT(*) AS n FROM debut_window_video_organicity WHERE group_key='plave' GROUP BY window_bucket ORDER BY window_bucket;" --json 2>&1 | grep -A30 '"results"' | head -30
```

Expected: 결과에 `D-60` 과 `D+60` row 가 등장 (n>0). 이전엔 둘 다 없거나 legacy.

- [ ] **Step 5: API endpoint 직접 검증**

`/api/debut-window/videos?group=plave&bucket=D-30` 응답이 worker 의 D-30/D-20/D-10 union 영상을 모두 반환하는지:

```bash
curl -s "https://idol-sight.pages.dev/api/debut-window/videos?group=plave&bucket=D-30" | head -100
```

(또는 production URL — `cat frontend/wrangler.toml` 으로 정확한 host 확인.)

Expected: `rows` 배열의 `days_relative_to_debut` 값들이 -30 ~ -2 범위 안 (이전엔 -30 ~ -21).

`/api/debut-window/videos-all?group=plave&offset=0&limit=30` 도:

```bash
curl -s "https://idol-sight.pages.dev/api/debut-window/videos-all?group=plave&offset=0&limit=30" | head -100
```

Expected: `total > 30`, `rows.length === 30`, 일부 row 는 `organic_score: null` (±60d 밖 영상).

- [ ] **Step 6: dashboard 시각 검증**

브라우저에서 production dashboard 의 PLAVE 그룹 상세 페이지 접속.

확인 사항:
1. `Debut Window Video Organicity` 카드 상단에 `[Debut Window] [전체 기간]` 2 탭 보임.
2. Debut Window 탭 (기본 활성) 의 D-60 클릭 → 영상 row 보임 (이전엔 빈 결과).
3. Debut Window 탭의 D-30 클릭 → -30 ~ -2 일 영상 모두 보임 (이전엔 -30 ~ -21 만).
4. 전체 기간 탭 클릭 → 영상 30개 published_at DESC 정렬 + 페이지네이션 컨트롤 보임.
5. 전체 기간 탭의 첫 row 가 가장 최근 영상.
6. 전체 기간 탭의 페이지 2 로 이동 → 다른 30개 영상.
7. 전체 기간 탭의 organicity 없는 영상 (오래된 영상) 은 Score/ER `—`, 판정 `Insufficient`.
8. Long-form / Shorts 필터가 두 view 모두 동작.

- [ ] **Step 7: 회귀 없음 검증 — CompetitorOrganicityBar**

같은 그룹 페이지에서 Competitive Debut Window Posture 카드 (CompetitorOrganicityBar) 확인.

Expected: V2.22 의 7 bucket (D-30/D-20/D-10/D-Day/D+10/D+20/D+30) UI 그대로. LEGACY_BUCKETS (D-60/D+60) fallback 도 정상 표시 — 이번 변경으로 *깨끗한 데이터* 가 그 fallback 에 들어감 (Task 1 의 worker `WINDOW_BUCKETS` 확장 후 D-60/D+60 row 가 신규 생성).

- [ ] **Step 8: 검증 완료 코멘트 (commit 안 함)**

검증 결과를 자유 형식으로 보고. 만약 6개 시각 검증 항목 중 어느 하나라도 실패하면 fix 사이클 (별도 commit) 진행 후 재검증.

---

## Self-Review

**1. Spec coverage**

| spec 섹션 | task | 비고 |
|---|---|---|
| §3.1 view tab UI | Task 5 | [Debut Window] [전체 기간] 2-탭 |
| §3.2 worker 9 bucket | Task 1 | WINDOW_BUCKETS 확장 + 5 신규 test |
| §3.3 server-side 5→9 union 매핑 | Task 2 | FRONTEND_BUCKET_MAP |
| §3.3 신규 videos-all endpoint | Task 3 | 페이지네이션 + LEFT JOIN |
| §3.4 frontend view + 페이지네이션 | Task 5 | viewMode 상태 + ←/→ 버튼 |
| §3.5 api.ts client | Task 4 | debutWindowVideosAll |
| §4 회귀 안전 (CompetitorOrganicityBar/KPI) | Task 6 Step 7 검증 |
| §5 organicity 없는 row 표시 | Task 5 | verdictLabelShort(null) → "Insufficient" |
| §6 테스트 | Task 1 (worker), Task 5 (frontend typecheck/test) |
| §7 e2e 검증 | Task 6 | worker 재실행 + dashboard |

**Coverage 갭**: 없음.

**2. Placeholder scan**: 없음. 모든 step 에 실제 코드/명령/기대 결과.

**3. Type consistency**:
- `FRONTEND_BUCKET_MAP` 키 = `VALID_BUCKETS` 값 = 5 frontend label 일치.
- `VideoRow` interface (Task 5) 가 `videos.ts` 의 `VideoRow` (Task 2 변경 후) 와 `videos-all.ts` 의 `VideoRowAll` (Task 3) 둘 다와 호환 — 즉 Task 5 의 단일 type 이 두 API 응답의 superset (`published_at?` optional, organicity 컬럼들이 nullable).
- `api.debutWindowVideosAll` 시그니처: `(group, offset, limit, type) => Promise<{rows, total, offset, limit}>` — Task 4 (client) 와 Task 5 (caller) 일치.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-25-debut-window-expansion-and-all-time-view.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Task 단위로 fresh subagent 실행 + 각 task 끝마다 spec+quality reviewer. 컨텍스트 분리.

**2. Inline Execution** — 같은 session 에서 batch 실행. 컨텍스트 비용 큼.

**Which approach?**
