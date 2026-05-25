# Debut Window Video Organicity 확장 + 전체 기간 View 설계

- **상태**: 설계 완료, 사용자 검토 대기 (2026-05-25)
- **선행 작업**: V2.21 (5-tier verdict), V2.22 (worker 9 bucket 정밀도), Causal Diagnosis rev 3
- **후속 작업**: writing-plans → 구현 plan → 구현 사이클

---

## 1. 동기

그룹 상세 페이지의 `Debut Window Video Organicity` 카드는 데뷔 D-60 ~ D+60 범위의 영상별 organicity (자연 노출 vs 광고 의심) 를 5 탭 (`D-60 / D-30 / D-Day / D+30 / D+60`) 으로 분류해 보여준다. 그러나 **현재 회귀 상태**가 있다:

- Worker `WINDOW_BUCKETS` (V2.22, 2026-05-14) 는 7 bucket 으로 분류: `D-30 / D-20 / D-10 / D-Day / D+10 / D+20 / D+30`. **±30일 밖 영상은 skip**.
- Frontend `DebutWindowVideoTable.tsx` 의 5 탭 UI 는 V2.21 layout 그대로 — `D-60 / D+60` 탭은 worker 가 row 안 쓰므로 **빈 결과**, `D-30 / D+30` 탭은 worker bucket 의 10일치만 보임 (라벨과 의미 mismatch).

또한 운영자는 데뷔 윈도우 밖의 *전체 영상 히스토리* 도 organicity 와 함께 페이지 단위로 보고 싶어한다 (예: 데뷔 후 6개월 시점의 영상이 paid 의심인지).

목표:
1. **Debut Window view 회귀 fix** — D-60 ~ D+60 전 구간이 5 탭에서 정확히 보임.
2. **전체 기간 view 신규** — 그룹의 모든 영상, 최신순, 페이지네이션, organicity 가 있는 영상은 score/판정 동반.
3. **두 view 를 상단 탭으로 분리**.

---

## 2. 비목표

- `DebutWindowKPI` 의 5 bucket aggregate 회귀 fix — 같은 회귀 패턴이지만 *카드 상단 요약* 영역이라 우선순위 낮음. 후속 spec 으로 분리.
- `CompetitorOrganicityBar` 변경 — V2.22 의 9 bucket 정밀도 유지가 의도. 영향 없도록 설계.
- worker `WINDOW_BUCKETS` 의 V2.22 정밀도 (D-30/D-20/D-10/D+10/D+20/D+30) 변경 — 그대로 유지.
- 영상 organicity 점수 산정 로직 변경 — 그대로 유지.

---

## 3. 컴포넌트 분리

### 3.1 신규 view tab (상단 2 탭)

```
┌─ DebutWindowVideoTable component ─────────────────────┐
│ [Debut Window] [전체 기간]                          ⓘ │
│ ╰─ [D-60][D-30][D-Day][D+30][D+60]                    │
│    Filter: All | Long-form | Shorts                   │
│    ┌─────────────────────────────────────────────┐    │
│    │ D-DAY  TITLE              TYPE  VIEWS ...   │    │
│    │ ...                                         │    │
│    └─────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────┘
```

전체 기간 view 활성 시:

```
[Debut Window] [전체 기간]                            ⓘ
                ╰─ (active)
Filter: All | Long-form | Shorts
┌────────────────────────────────────────────────────┐
│ PUBLISHED   TITLE         TYPE  VIEWS ER SCORE 판정 │
│ 2026-05-23  ...           ...                       │
│ ...                                                 │
└────────────────────────────────────────────────────┘
  ← 이전   1 / 24   다음 →
```

### 3.2 Worker 변경

`worker/src/idol_sight/analysis/debut_window.py`:

`WINDOW_BUCKETS` 에 2개 bucket 추가 (총 9개):

```python
WINDOW_BUCKETS: list[tuple[str, int, int]] = [
    ("D-60",  -60, -31),    # 신규
    ("D-30",  -30, -21),
    ("D-20",  -20, -11),
    ("D-10",  -10,  -2),
    ("D-Day",  -1,   1),
    ("D+10",   2,  10),
    ("D+20",  11,  20),
    ("D+30",  21,  30),
    ("D+60",  31,  60),     # 신규
]
```

`_FETCH_VIDEOS_SQL` 의 `julianday` 범위 ±60 은 이미 그대로 (변경 불필요).

`bucket_for(days)` 는 위 9 bucket 에서 매칭 — 자동으로 D-60/D+60 도 분류.

**데이터 마이그레이션**: migration SQL 불필요. `build_video_organicity` 가 idempotent UPSERT 라 worker 재실행만으로 기존 ±31~60d 영상에 새 bucket 라벨이 채워진다. ±30 안 영상은 변동 없음.

### 3.3 API 변경

**기존**: `/api/debut-window/videos?group=<key>&bucket=<bucket>&type=<all|long|short>`

- `VALID_BUCKETS` 가 현재 5개 (`D-60/D-30/D-Day/D+30/D+60`) — 그대로 유지 (UI 호환).
- SQL 의 `WHERE o.window_bucket = ?` 를 **frontend 5 탭 → worker 9 bucket union** 매핑으로 변경:

  | frontend bucket | worker bucket union |
  |---|---|
  | `D-60`  | `('D-60')`                |
  | `D-30`  | `('D-30','D-20','D-10')`  |
  | `D-Day` | `('D-Day')`               |
  | `D+30`  | `('D+10','D+20','D+30')`  |
  | `D+60`  | `('D+60')`                |

  SQL: `WHERE o.window_bucket IN (?, ?, ?)` (가변 placeholder, 매핑 결과 length 만큼).

**신규**: `/api/debut-window/videos-all?group=<key>&offset=<n>&limit=<n>&type=<all|long|short>`

- `limit` default 30, max 100.
- 응답: `{ group, type, total, offset, limit, rows: VideoRowAll[] }`.
- `VideoRowAll` = 기존 `VideoRow` + `published_at` 컬럼 (D-day 대신).
- SQL:
  ```sql
  SELECT v.video_id, v.title, v.is_short, v.published_at,
         o.days_relative_to_debut, o.window_bucket,
         s.views AS view_count, s.likes AS like_count, s.comments AS comment_count,
         o.engagement_rate, o.like_comment_ratio, o.velocity_ratio,
         o.organic_score, o.verdict, o.causes, o.signal_breakdown
  FROM youtube_videos v
  LEFT JOIN debut_window_video_organicity o ON o.video_id = v.video_id
  LEFT JOIN youtube_video_stats s
    ON s.video_id = v.video_id
   AND s.snapshot_at = (SELECT MAX(snapshot_at) FROM youtube_video_stats
                        WHERE video_id = v.video_id)
  WHERE v.group_key = ?
    [AND v.is_short = ? -- if type filter]
  ORDER BY v.published_at DESC
  LIMIT ? OFFSET ?
  ```
- `total`: 같은 WHERE 의 `SELECT COUNT(*) FROM youtube_videos v WHERE ...` (별도 query).
- ±60d 밖 영상은 organicity row 없으므로 `organic_score=null`, `verdict=null` → frontend 에서 "—" / "Insufficient" 표시.

### 3.4 Frontend 변경

`frontend/src/components/DebutWindowVideoTable.tsx`:

신규 상태:
```ts
type ViewMode = "debut" | "all";
const [viewMode, setViewMode] = useState<ViewMode>("debut");
const [page, setPage] = useState(0);   // 0-indexed
const [allRows, setAllRows] = useState<VideoRow[] | null>(null);
const [allTotal, setAllTotal] = useState(0);
```

상단 view tab:
```tsx
<nav class="dw-view-tabs">
  <button class={viewMode === "debut" ? "active" : ""}
          onClick={() => setViewMode("debut")}>Debut Window</button>
  <button class={viewMode === "all" ? "active" : ""}
          onClick={() => setViewMode("all")}>전체 기간</button>
</nav>
```

`viewMode === "debut"` 일 때:
- 기존 5 탭 + 테이블 그대로 (코드 변경 없음).

`viewMode === "all"` 일 때:
- 5 탭 hide.
- Filter (Long-form/Shorts) 그대로.
- 컬럼 PUBLISHED (YYYY-MM-DD) / TITLE / TYPE / VIEWS / ER / SCORE / 판정.
- 페이지네이션 컨트롤 하단:
  ```tsx
  <div class="dw-pagination">
    <button disabled={page === 0} onClick={() => setPage(page - 1)}>← 이전</button>
    <span>{page + 1} / {Math.ceil(allTotal / PAGE_SIZE)}</span>
    <button disabled={(page + 1) * PAGE_SIZE >= allTotal}
            onClick={() => setPage(page + 1)}>다음 →</button>
  </div>
  ```
- 상수 `PAGE_SIZE = 30`.

데이터 fetch:
- `viewMode === "debut"`: 기존 `api.debutWindowVideos(groupKey, bucket, filterType)` 호출.
- `viewMode === "all"`: 새 `api.debutWindowVideosAll(groupKey, page * PAGE_SIZE, PAGE_SIZE, filterType)` 호출. 응답에서 `total` 도 받아 `setAllTotal`.

URL state: 명시 안 함 (이번 spec). 페이지 새로고침 시 첫 페이지로 초기화. 후속 V2 에서 router param 추가 가능.

`signal_breakdown` 사이드 패널 (`DebutWindowSignalPanel`) 동작 그대로 — 전체 기간 view 에서도 organicity 가 있는 row 클릭 시 패널 열림. organicity 없는 (±60d 밖) row 는 패널 안 열거나 "no signal data" 표시.

### 3.5 API client 확장

`frontend/src/api.ts` 에 새 함수:
```ts
debutWindowVideosAll(
  groupKey: string, offset: number, limit: number, type: "all" | "long" | "short"
): Promise<{ rows: VideoRowAll[]; total: number; offset: number; limit: number }>
```

기존 `debutWindowVideos` 그대로 유지.

---

## 4. 영향 받지 않는 컴포넌트 (회귀 안전)

- `CompetitorOrganicityBar.tsx` — worker 9 bucket 의 V2.22 정밀도 그대로 사용. D-60/D+60 LEGACY_BUCKETS 도 fallback 동작 유지. **영향 0**.
- `DebutWindowKPI.tsx` — 5 bucket 라벨 사용하지만 summary API 가 worker bucket 그대로 반환. 회귀 상태 유지 (이번 spec 의 비목표). **영향 0**.
- `MarketOverview.tsx` 의 KPI 호출 — KPI 변경 없으니 영향 없음.

---

## 5. 데이터 표시 정합성

### 5.1 organicity 없는 영상 (전체 기간 view 의 ±60d 밖)

| 컬럼 | 표시 |
|---|---|
| PUBLISHED | YYYY-MM-DD |
| TITLE | 영상 제목 |
| TYPE | Long / Shorts |
| VIEWS | 최신 stats (있으면) 또는 "—" |
| ER | "—" (organicity 가 계산 안 함) |
| SCORE | "—" |
| 판정 | `Insufficient` (회색 pill) — `verdictLabelShort("insufficient_data")` 와 동일 |

### 5.2 organicity 있는 영상 (±60d 안)

기존 동일.

### 5.3 정렬

- Debut Window view: `days_relative_to_debut ASC, published_at ASC` (기존).
- 전체 기간 view: `published_at DESC`.

---

## 6. 테스트

### 6.1 Worker unit test 보강

`worker/tests/unit/test_debut_window.py` (이미 있다면) 또는 신규 파일에:

- `test_bucket_for_d_minus_60`: `bucket_for(-45)` → `"D-60"`.
- `test_bucket_for_d_plus_60`: `bucket_for(45)` → `"D+60"`.
- `test_bucket_for_d_minus_31_boundary`: `bucket_for(-31)` → `"D-60"`, `bucket_for(-30)` → `"D-30"`.
- `test_bucket_for_d_plus_31_boundary`: `bucket_for(31)` → `"D+60"`, `bucket_for(30)` → `"D+30"`.
- `test_bucket_for_outside_window`: `bucket_for(-61)` → `None`, `bucket_for(61)` → `None`.

### 6.2 Frontend unit test (vitest)

`frontend/src/lib/` 에 새 helper 가 추가되지는 않으나, 만약 5 탭 → 9 bucket 매핑 함수가 server-side 가 아닌 frontend 에 들어가면 test 추가 (현 설계에서는 server-side 이므로 frontend test 불필요).

### 6.3 API 통합 검증

`/api/debut-window/videos?group=plave&bucket=D-30` 호출 시:
- 응답 rows 가 `days_relative_to_debut` 가 -30 ~ -2 범위 안 영상 모두 포함 (이전엔 -30~-21 만 보였음).

`/api/debut-window/videos-all?group=plave&offset=0&limit=30` 호출 시:
- 응답 rows 가 PLAVE 의 최신 30개 영상.
- 응답 `total` 이 실제 PLAVE 영상 총 수와 일치.
- `organic_score === null` 인 row 가 있어야 (오래된 영상).

### 6.4 e2e 운영 검증

- worker `python -m idol_sight ... build-debut-window-organicity` (또는 daily aggregate 안에서 호출되는 흐름) 재실행.
- D1 query: `SELECT window_bucket, COUNT(*) FROM debut_window_video_organicity WHERE group_key='plave' GROUP BY window_bucket` — D-60/D+60 row 가 신규로 채워짐을 확인.
- Frontend dashboard: PLAVE 그룹 → Debut Window 카드 → D-60 클릭 → row 가 표시됨. 전체 기간 탭 → 페이지네이션 동작.

---

## 7. 점진 도입

V1 (이번 spec):
- worker `WINDOW_BUCKETS` 9 bucket 으로 확장.
- API `/api/debut-window/videos` 의 frontend 5 탭 → worker 9 bucket union 매핑.
- 새 API `/api/debut-window/videos-all` (페이지네이션).
- Frontend `DebutWindowVideoTable` 에 view tab + 전체 기간 view 추가.
- worker 재실행으로 D-60/D+60 영상 organicity 데이터 채우기.

V2 (후속 spec, 분리):
- `DebutWindowKPI` 의 5 bucket aggregate 회귀 fix (same union mapping pattern).
- 전체 기간 view 의 URL state (router param) 으로 페이지/필터 보존.
- 영상 검색 (제목 keyword filter) 추가.
- organicity 가 없는 영상에 *주문형 계산* (사용자가 클릭하면 worker 가 그 영상만 추가 계산).

---

## 8. 회귀 방지

- 기존 `DebutWindowVideoTable` 의 Debut Window view 동작은 그대로 — 5 탭 + Filter + 행 클릭 → signal_breakdown 패널 모두 유지.
- `CompetitorOrganicityBar` 가 worker 9 bucket 그대로 사용 — 변경 없음.
- 신규 view tab 은 *기존 view 의 상위에 layer 추가* — 기본 활성 = Debut Window (legacy 동작).
- 새 API `videos-all` 은 별도 endpoint — 기존 `videos` 무영향.
- worker bucket 확장은 *idempotent UPSERT* — 기존 row 변경 없음.

---

## 9. 후속 (writing-plans 단계로 위임)

이 spec 승인되면 `superpowers:writing-plans` 호출:
1. worker `WINDOW_BUCKETS` 확장 + test.
2. API `videos` 의 5 탭 → 9 bucket 매핑.
3. API `videos-all` 신규 (페이지네이션 + LEFT JOIN).
4. Frontend `DebutWindowVideoTable` view tab + 전체 기간 view + 페이지네이션.
5. Frontend `api.ts` 확장.
6. e2e 운영 검증 (worker 재실행 + D1 query + dashboard).
