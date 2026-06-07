# 데뷔일 없는 그룹 organicity 채점 (V2.42)

날짜: 2026-06-08
범위: worker + summary API + KPI 카드. **migration 불필요** (스키마 변경 없음, 새 bucket 라벨은 `window_bucket TEXT NOT NULL`에 CHECK 제약 없어 그냥 삽입 가능).

## 배경

운영자 점검 — BTHD(비더후드, 경쟁사 벤치마크)가 Debut Window Organicity 카드에서 전부 "—". 원인: `groups.debut_date IS NULL`. 빌더 `build_video_organicity`가 `WHERE g.debut_date IS NOT NULL`로 데뷔일 없는 그룹을 통째로 스킵. BTHD는 채널·영상 5개 정상 수집되나 organicity 행 0.

핵심 통찰: **organic 점수(`compute_organic_score`)는 데뷔일을 전혀 안 쓴다** (조회/좋아요/댓글/ER/balance/velocity 만). 데뷔일은 ① 게이트 ② 버킷 배치(`days_relative_to_debut` → `bucket_for`)에만 쓰임. 따라서 앵커 없이도 점수는 산정 가능하고, 버킷만 배치 못 함.

D1 확인: NULL-debut 그룹은 **BTHD 단 하나**. 5개 영상 전부 stats 존재(insufficient_data 게이트 통과) → 실제 점수 산출됨. (특히 `k3_qxUaax3w` 106K뷰 short, ER 0.15% → paid 시그니처 예상.)

## 설계

### 핵심 결정 — 센티넬 + Undated 버킷 (migration 0)
- 새 합성 버킷 라벨 `"Undated"`. `days_relative_to_debut`는 앵커 없으니 센티넬 `0` 저장.
- `window_bucket TEXT NOT NULL`엔 CHECK 없음 → 새 라벨 삽입 가능. `days_relative` 센티넬 0은 **어디에도 렌더되지 않음**(아래 참조) → 오해 없음.

### Worker (`debut_window.py`)
- `UNDATED_BUCKET = "Undated"` 상수 신설.
- `_FETCH_VIDEOS_SQL`: 게이트 `WHERE g.debut_date IS NOT NULL` 제거 → `WHERE v.published_at IS NOT NULL`만.
- `build_video_organicity` 루프: `debut_date` 있으면 기존대로(`_days_between`→`bucket_for`, None이면 skip). **없으면** `days_rel=0`, `bucket="Undated"`로 채점.
- `build_summary`: (group, bucket) 제너릭 집계라 **무변경** — `(bthd,"Undated")` 요약 row 자동 생성.

### Summary API (`functions/api/debut-window/summary.ts`)
- 현재 `WHERE window_bucket IN (7 named)`으로 Undated/Pre/Post 제외.
- `buildBucketCase`에 `WHEN window_bucket='Undated' THEN 'Undated'` 추가.
- **bucket 필터 없을 때만**(카드 fetch 경로) IN 목록에 `'Undated'` 포함 → 카드용 Undated 요약 row 반환. `?bucket=X`(posture bar/특정 버킷) 경로는 미포함.
- `FRONTEND_BUCKET_MAP`은 **무변경**(탭 single-source) — Undated를 탭으로 노출하지 않기 위함.

### Frontend (`DebutWindowKPI.tsx`)
- `byBucket` 맵에 `"Undated"` 키 있으면, 7-버킷 행 아래 **pre-debut 배지** 1줄: `pre-debut · {video_count}개 영상 · 평균 {headlineOrganicScore}점` (앵커 무관, 색은 점수 기반 `scoreColor`). insufficient만 있으면 평균 NULL → "판정 보류" 문구.
- 데뷔일 있는 그룹은 Undated row 없음 → 미표시.

### 변경 불필요 (확인 완료)
- **`videos-all.ts`**: bucket 필터 없이 LEFT JOIN으로 전 영상 반환 → Undated organicity 행이 "전체 기간" 탭에 자동 노출. 무변경.
- **`DebutWindowVideoTable`**: "전체 기간" 뷰는 Published 날짜 표시(D-day 센티넬 미렌더), bucket 컬럼 없음 → "Undated"/days=0 안 보임. 무변경.
- **`CompetitorOrganicityBar`**: 클라이언트가 `DISPLAY_BUCKETS`로 필터 → Undated 자동 제외. 경쟁 bar는 데뷔 윈도 기준 유지. 무변경.

## 데이터 윤리
BTHD는 경쟁사(외형 트래킹). organicity는 공개 engagement 외형 지표라 §4 "경쟁사는 외형만" 범위 내. 다른 경쟁사 이미 채점 중이라 일관.

## 테스트 (TDD)
- worker `test_debut_window.py`: ① NULL-debut 그룹 → `Undated` 버킷·days 0 채점 ② `_FETCH_VIDEOS_SQL`에 `debut_date IS NOT NULL` 부재 회귀 가드. 기존 데뷔일 그룹 케이스 불변.
- frontend: `tsc` clean + 기존 174 불변. (component test 하네스 부재 — 카드 배지는 tsc + 로직 단순성으로 커버.)

## 검증
- `cd worker && uv run pytest` 전체 통과.
- `cd frontend && tsc -b --noEmit` + `vitest run` 통과.
- 다음 organicity cron(21:30 KST)이 BTHD 5영상 자동 채점 → 카드 배지 + 전체기간 탭 노출.
