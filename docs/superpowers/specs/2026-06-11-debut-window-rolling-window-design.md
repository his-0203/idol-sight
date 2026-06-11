# Debut Window 롤링 윈도우 설계

- **날짜**: 2026-06-11
- **상태**: 설계 승인 (운영자)
- **선행**: V2.34 (균등 20일 7버킷), V2.42 (Undated 버킷)

## 문제

현행 Debut Window 는 데뷔일 고정 앵커의 정적 스냅샷이다 — 7 named bucket
(`D-60 … D+60`, 각 20일) + `Pre`/`Post` catch-all. MiiWAN (데뷔 2026-06-16)
이 데뷔 후 시간이 흘러도 화면은 영원히 ±60일 창에 머물고, D+70 이후 영상은
전부 `Post` 한 덩어리로 뭉개져 20일 단위 organicity 추적이 불가능하다.

## 결정 (운영자 확인 완료)

1. **롤링 윈도우**: 시간이 흐르면 오른쪽에 새 20일 버킷(D+80, D+100, …)이
   추가되고 왼쪽 가장 오래된 버킷이 하나씩 퇴장한다. 창 크기는 **7버킷
   (140일) 고정**. 결국 `D-Day` 버킷 자체도 자연스럽게 창 밖으로 밀려난다.
2. **슬라이드 기준 = MiiWAN 나이, 전 그룹 공통**: 오늘이 MiiWAN 기준 어느
   버킷인지가 창 위치를 결정하고, 모든 그룹 탭이 같은 버킷 범위를 표시한다.
   버킷 라벨은 여전히 각 그룹 *자기* 데뷔일 기준 D±N 이므로 "같은
   라이프스테이지" 코호트 비교가 유지된다.
3. **창 위치 계산 = 서버 (Pages Functions)**: API 가 D1 의 MiiWAN
   `debut_date` 로 창을 계산해 응답에 버킷 리스트를 포함한다. 데뷔일 단일
   진실원천(DB) 유지, 프런트 하드코딩 없음.
4. **미데뷔 그룹**: wegosix (debut_date 2026-08-31 placeholder) 는 자기
   D±N 그대로 — 미도래 버킷은 빈 칸("—"), 최신 데이터는 데뷔 시차(76일) <
   창 좌측 마진(120일) 이라 영원히 창 안. BTHD (debut_date NULL) 는 현행
   V2.42 Undated 처리 무변경. 추가 표시 장치 없음 (운영자 결정).

## §1. 버킷 산술 (worker — `analysis/debut_window.py`)

`Post` catch-all 폐기, 양수 측은 산술 생성:

```
d ≤ -71          → "Pre"               (유지 — 창이 과거로 안 밀리므로 음수 확장 불필요)
-70 ≤ d ≤ -51    → "D-60"  ┐
-50 ≤ d ≤ -31    → "D-40"  │ 현행 그대로
-30 ≤ d ≤ -11    → "D-20"  │
-10 ≤ d ≤ 9      → "D-Day" ┘
d ≥ 10           → "D+{20k}"  (k = (d-10)//20 + 1)   ← 무한: D+20, D+40, …, D+80, D+100, …
```

- D+20/D+40/D+60 은 산술 경계가 현행 `WINDOW_BUCKETS` 와 완전 동일 →
  기존 행 재배치는 `Post` 행에만 발생.
- 경쟁사 오래된 영상은 D+400 같은 먼 버킷을 만들지만 (group, bucket) 행일
  뿐 — `build_summary` 는 제너릭이라 자동 수용, row 비용 무시 가능.
- `WINDOW_BUCKETS` 상수는 named 음수 4종(Pre/D-60/D-40/D-20)+D-Day 목록 +
  양수 산술 함수 구조로 재편 (`bucket_for` 시그니처 유지).
- `UNDATED_BUCKET` (V2.42) 무변경.

## §2. 표시 창 규칙 (canonical: `frontend/functions/lib/debutWindowBuckets.ts`)

`displayBuckets(ageDays)` — MiiWAN 데뷔 경과일(KST 기준 오늘 − debut_date)
을 받아 **연속 7버킷 라벨**을 반환:

- 오른쪽 끝 = 오늘이 속한 버킷, 단 **최소 `D+60`**. 즉 `ageDays < 70` 이면
  현행 `[D-60, D-40, D-20, D-Day, D+20, D+40, D+60]` 그대로 (현재 화면
  무변화, MiiWAN D+70 = 2026-08-25 에 첫 슬라이드).
- 개념적 무한 시퀀스 `[D-60, D-40, D-20, D-Day, D+20, D+40, D+60, D+80, …]`
  위에서 오른쪽 끝 포함 7개를 자른다. 슬라이드는 20일에 한 칸.
- 예: D+70~89 → `[D-40 … D+80]`, D+130 → `[D+20 … D+140]` (D-Day 퇴장).
- 정적 `FRONTEND_BUCKET_MAP` identity 맵 폐기 → 라벨 검증은 산술 규칙
  (named 4종 + `D+N, N=20 의 배수 ≥ 20`) 의 동적 함수로. `VALID_BUCKETS`
  Set 도 함수형 검증으로 대체.
- worker `bucket_for` 와 경계 동일성은 양쪽 테스트의 공유 fixture 로 핀.

## §3. API (Pages Functions)

- **`api/debut-window/summary.ts`**:
  - D1 에서 MiiWAN `debut_date` 조회 → `displayBuckets()` 로 창 계산.
  - bucket IN 필터 = 창 7개 (+ 현행 규칙 유지: `?bucket=` 파라미터 없을
    때만 `Undated` 포함 — V2.42).
  - 응답에 `window: { buckets: string[] }` 메타 추가.
  - `?bucket=X` 검증을 동적 규칙으로 교체.
- **`api/debut-window/videos.ts`**: bucket 파라미터 검증만 동적 규칙으로.
- **`api/debut-window/videos-all.ts`**: 무변경 (bucket 필터 없는 전체 기간
  뷰 — D+80+ 점수도 LEFT JOIN 으로 자동 노출).

## §4. 프런트엔드 (lib + 3 컴포넌트)

- `src/lib/debutWindow.ts` 의 정적 `DISPLAY_BUCKETS` 폐기. 컴포넌트는
  summary 응답의 `window.buckets` 를 렌더. `type Bucket` 리터럴 타입은
  `string` 으로 완화.
- **DebutWindowKPI** (MarketOverview): 이미 `api.debutWindowSummary()`
  호출 — 응답 메타로 컬럼 렌더. Undated pre-debut 배지 (V2.42) 무변경.
- **CompetitorOrganicityBar** (MiiWANBriefing): 동일 — "최신 non-null
  버킷" 역순회 로직은 동적 배열 위에서 그대로 동작.
- **DebutWindowVideoTable** (GroupContent): 탭 목록 확보를 위해 mount 시
  summary 1회 호출 추가 (가벼운 집계 쿼리). [전체 기간] 탭 무변경.
- wegosix 미도래 버킷 = 데이터 없음 → 현행 "—" 표기 그대로.

## §5. Migration (1개, 0073 패턴)

- `debut_window_video_organicity` 의 `window_bucket='Post'` 행을
  `days_relative_to_debut` 기반 산술 라벨로 **UPDATE in-place**.
- `debut_window_organicity_summary` 전체 DELETE → 다음 organicity cron 의
  `build_summary` 가 재집계.
- `window_bucket` 컬럼은 CHECK 제약 없는 TEXT 라 새 라벨 삽입 자유 (V2.42
  에서 확인).

## §6. 테스트 / 무영향 확인 / 배포

**테스트**:
- worker: `bucket_for` 산술 경계 (d=9/10, 29/30, 69/70→`D+80` 신규 라벨,
  큰 값 d=400), `Post` 미생성 회귀, 기존 9-bucket parametrize 갱신.
- frontend: `displayBuckets` 경계 (age 69 = 고정창 / 70 = 첫 슬라이드 /
  130 = D-Day 퇴장 / 음수 = 고정창), 동적 라벨 검증, worker↔functions
  경계 동일성 fixture.

**무영향 확인**:
- MiiWANBriefing 7-anchor cohort 탭 — agg_summary 스냅샷 anchor 별개 개념
  (V2.34 때와 동일 논리).
- Undated 메커니즘 (V2.42) — 게이트·라벨 무변경.
- weekly_diagnosis `organicity_paid_ratio` — 소비 버킷 범위는 구현 플랜
  단계에서 재확인 (Post 폐기로 분모가 달라지는지 점검).

**배포 순서**: migration 은 라벨 UPDATE 뿐이라 구버전 코드와 호환 (`Post`
는 표시 창에 원래 없음) — graceful 리스크 낮음. 그래도 push 후 즉시
`gh workflow run migrate.yml` 권장 (CLAUDE.md 배포↔마이그레이션 규칙).

## 범위 밖

- wegosix 미도래 버킷의 "데뷔 전/미도래" 구분 라벨 (운영자가 현행 "—" 유지
  결정).
- BTHD 데뷔일 발표 시 편입 (자동 — 별도 작업 불필요).
- 창 크기(7버킷) 가변화, 사용자 지정 범위 조회 — YAGNI.
