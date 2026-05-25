# Organicity 전 영상 적용 — 설계 (짧은 amendment)

- **상태**: 설계 완료 (2026-05-25)
- **선행 작업**: V3 Debut Window 9 bucket (커밋 `ca708b0` ~ `abeadde`)
- **후속 작업**: writing-plans 생략 — 이 문서 안에 task 분해 통합.

---

## 1. 동기

`Debut Window Video Organicity` 의 [전체 기간] view 가 그룹의 모든 영상을 보여주지만, **91% 영상이 organicity 데이터 없음** (`ER/Score/판정` 모두 "—" / "Insufficient"). 운영 cohort 13,990 중 12,759개가 ±60d 윈도우 밖이라 worker 가 skip 했기 때문.

데뷔 후 시간이 지난 그룹 (ISEDOL 99%, STELLIVE 99%, PLAVE 95%) 의 모든 영상이 *분석 가치 손실* 상태. 모든 영상에 organicity 계산을 적용하면 전체 기간 view 의 의미가 살아난다.

## 2. 변경 사항

### 2.1 Worker (`worker/src/idol_sight/analysis/debut_window.py`)

**A. `_FETCH_VIDEOS_SQL` 의 `BETWEEN ±60` 절 제거** — 모든 영상 fetch.

기존:
```sql
WHERE g.debut_date IS NOT NULL
  AND v.published_at IS NOT NULL
  AND julianday(v.published_at)
        BETWEEN julianday(g.debut_date) - 60
            AND julianday(g.debut_date) + 60
```

변경:
```sql
WHERE g.debut_date IS NOT NULL
  AND v.published_at IS NOT NULL
```

**B. `WINDOW_BUCKETS` 에 Pre/Post 2개 bucket 추가** — 총 11 bucket.

```python
WINDOW_BUCKETS: list[tuple[str, int, int]] = [
    ("Pre",   -999999, -61),     # 신규 — 데뷔 60일 이전
    ("D-60",     -60,  -31),
    ("D-30",     -30,  -21),
    ("D-20",     -20,  -11),
    ("D-10",     -10,   -2),
    ("D-Day",     -1,    1),
    ("D+10",       2,   10),
    ("D+20",      11,   20),
    ("D+30",      21,   30),
    ("D+60",      31,   60),
    ("Post",      61, 999999),   # 신규 — 데뷔 60일 이후
]
```

`bucket_for(days)` 가 모든 영상에 라벨 매핑 (Pre/Post 가 ±무한대 catch).

### 2.2 비목표 (변경 없음)

- migration SQL — `window_bucket TEXT NOT NULL` 가 새 라벨 자유.
- `frontend/functions/api/debut-window/videos.ts` — `FRONTEND_BUCKET_MAP` 그대로. Pre/Post 는 5 탭 UI 매핑 안 함 (전체 기간 view 에서만 보임).
- `DebutWindowVideoTable.tsx` 의 5 탭 — Pre/Post 무관.
- `CompetitorOrganicityBar.tsx` / `DebutWindowKPI.tsx` — V2.22 bucket 기준 그대로, Pre/Post 무시.
- `build_summary` 의 aggregate — Pre/Post bucket 도 자동 집계됨 (영향은 frontend 가 V2.22 7 bucket 만 표시하니 무관).

### 2.3 운영 비용

- 처리 영상 수: 1,231 → 13,990 (×11)
- D1 UPSERT batch: ~12 → ~140 (각 100 statements)
- daily cron 시간: +1-2분 (현재 17분 → 19분)
- D1 write: +12,759 × 1회/일 ≈ 400K writes/월 (무료 tier 안)

## 3. 테스트

`worker/tests/unit/test_debut_window.py` 갱신:

- `test_window_buckets_are_9_non_overlapping_ranges` → `_11_non_overlapping_ranges`:
  - `len(WINDOW_BUCKETS) == 11`
  - labels 리스트가 `["Pre", "D-60", ..., "D+60", "Post"]`
  - flat range 가 명세대로 (Pre 의 -999999, Post 의 999999 포함)
- 신규 3 boundary test:
  - `test_bucket_for_pre_range`: bucket_for(-61) == "Pre", bucket_for(-1000) == "Pre"
  - `test_bucket_for_post_range`: bucket_for(61) == "Post", bucket_for(1000) == "Post"
  - `test_bucket_for_pre_post_boundary`: bucket_for(-61) == "Pre", bucket_for(-60) == "D-60", bucket_for(60) == "D+60", bucket_for(61) == "Post"
- 기존 `test_bucket_for_outside_pm_60_returns_none` **갱신 (Pre/Post 로 매핑되어 None 아님)** — bucket_for(-1000) == "Pre", bucket_for(1000) == "Post" 로 assertion 변경. 또는 test 자체 *제거* (이제 outside 가 없음).

## 4. e2e 검증

1. push commit → frontend 변경 없으니 frontend-deploy 비필요 (worker 코드만).
2. `gh workflow run collect-daily.yml` 수동 트리거 — worker 가 13,990개 organicity backfill.
3. D1 query:
   ```sql
   SELECT window_bucket, COUNT(*) FROM debut_window_video_organicity 
   WHERE group_key='plave' GROUP BY window_bucket;
   ```
   기대: Pre, Post bucket 에 row 다수 (PLAVE 1,500개 추가).
4. Dashboard:
   - PLAVE 전체 기간 탭 → 모든 영상에 ER/Score/판정 채워짐 (Insufficient 라벨이 사라지거나 *low view_count 인 진짜 insufficient_data* 만 남음).

## 5. 점진 도입

이 변경은 단일 worker 모듈 수정 + test. spec/plan 분리 없이 즉시 impl. 임시 작은 task 두 개:

**Task 7**: worker `debut_window.py` 변경 + test 갱신.
**Task 8**: push + worker 재실행 + D1 검증.

## 6. 회귀 안전

- `CompetitorOrganicityBar.tsx` (V2.22 7 bucket + 2 legacy fallback) — Pre/Post 라벨은 ALL_BUCKETS 에 없으므로 자동 ignore (row filter line 177).
- `DebutWindowKPI.tsx` (5 bucket 표시) — Pre/Post 라벨 무시.
- API `/api/debut-window/videos?bucket=D-30` — FRONTEND_BUCKET_MAP 그대로, Pre/Post 영향 0.
- 5 탭 UI 에 Pre/Post 보이지 않음 (의도).
- `build_summary` 가 Pre/Post 도 aggregate 하지만 *frontend 가 그 bucket 라벨 안 가져가니* 화면 영향 0.
