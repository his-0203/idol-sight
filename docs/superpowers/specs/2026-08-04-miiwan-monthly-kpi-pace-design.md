# MiiWAN 포지션 탭 — 월간 KPI 페이스 표 (설계)

2026-08-04 · 승인: 사용자 (대화에서 A안 확정)

## 목적

포지션 탭에 미완소년의 **월간 KPI 페이스 표**를 추가한다: 월별(6~12월) 목표 밴드(보수~낙관)
대비 실측을 병기해 "계획 페이스 안에 있는가"를 한눈에 답한다. 위버스 가입자·유료 멤버십은
지금까지 앱에 없던 데이터로, 운영 중인 구글 시트(공개 CSV)를 수집기로 편입해 자동화한다.

## 지표 4개와 실측 정의

| 지표 | 실측 정의 | 원천 |
|------|----------|------|
| YouTube 구독자 | 해당 월 **마지막** `agg_summary.yt_subscribers` 스냅샷 | 기존 |
| 평균 라이브 동접 | 그 달 **방송별 평균 CCV의 평균** (`live_ccv_samples`) — 먼슬리 보고 "평균 시청자"와 동일 정의 | 기존 |
| 위버스 가입자 | 해당 월 마지막 `weverse_stats.total_members` | **신규** |
| 유료 멤버십 | 해당 월 마지막 `weverse_stats.digital_membership` | **신규** |

목표 밴드·공식 KPI는 볼트 `미완소년 KPI·매출 가정치 레퍼런스` §5(월별 페이스 밴드)와
먼슬리 보고(8월 말 구독 30K+·동접 1,000 / 11월 구독 ~72K·동접 ~1,600)에서 옮긴다.
**금액(매출·원가 등) 수치는 포함하지 않는다.**

## 1. 수집 (worker)

- **마이그레이션 `0111_weverse_stats.sql`**:
  ```sql
  CREATE TABLE IF NOT EXISTS weverse_stats (
    group_key   TEXT NOT NULL REFERENCES groups(key),
    day         TEXT NOT NULL,   -- YYYY-MM-DD (시트의 KST 날짜)
    total_members       INTEGER,
    digital_membership  INTEGER,
    countries   TEXT,            -- JSON {"한국": n, ...} (시트 국가 열 그대로)
    collected_at TEXT NOT NULL,
    PRIMARY KEY (group_key, day)
  );
  ```
- **수집기 `collectors/weverse_sheet.py`** (`source = "weverse-sheet"`):
  - 구글 시트 공개 CSV export(`/export?format=csv&gid=0`)를 fetch. 시트 ID는
    `Settings.miiwan_weverse_sheet_id` (env `MIIWAN_WEVERSE_SHEET_ID`, 옵셔널) —
    기존 `miiwan_yt_oauth_*` 패턴과 동일하게 미설정 시 skip.
  - 파싱 규칙: 선행 빈 열/빈 행 무시, 헤더 행(`날짜,총 가입자수,증가수,디지털 멤버십 가입수,증감수,국가...`)
    탐지 후 데이터 행 파싱. 천단위 쉼표 제거. 날짜 `M/D` → 시작 연도 2026 부여,
    월이 직전 행보다 작아지면 연도 +1 (연말 롤오버).
  - `증가수`/`증감수` 열은 저장하지 않는다(전일 대비 파생 가능).
  - **전량 upsert(멱등)** — 시트에서 과거 값을 고치면 다음 수집 때 반영.
  - CLI `COLLECTORS` 등록, 수집 주기 24h, `crawl_meta` 헬스 추적 편입.

## 2. API (`frontend/functions/api/miiwan.ts`)

응답에 `monthlyKpi` 추가:

```ts
monthlyKpi: Array<{
  month: string;              // "2026-06"
  yt_subscribers: number | null;      // 월말 스냅샷
  avg_ccv: number | null;             // 방송별 평균 CCV의 평균
  weverse_members: number | null;     // 월말
  weverse_membership: number | null;  // 월말
  in_progress: boolean;       // 당월 여부 (월말 확정 전)
}>
```

- 데뷔 월(2026-06)부터 당월까지. 당월은 최신값 + `in_progress: true`.
- 평균 동접 집계: `live_ccv_samples`를 `video_id`별 AVG 후 월별 AVG (miiwan 한정).

## 3. 프론트

- **`lib/miiwanKpi.ts`** (순수 로직 — 테스트 대상):
  - `PACE_BANDS`: 2026-06~2026-12 × 4지표 × `[보수, 낙관]` 상수. 6월은 실측 기점(밴드 없음).
  - `OFFICIAL_KPI`: 8월 말·11월 말 공식 목표(구독·동접) 마커.
  - `MONTH_NOTES`: ◆ 의사결정 시점(8월 말 굿즈 참여·10월 말 제작 스케일) · ★ 9월 컴백.
  - `bandVerdict(actual, band)`: `below ⚠️ / within ✅ / above 🔵` (당월은 판정 대신 "진행 중").
- **`MiiWANPosition.tsx`**: "③ 방향과 속도" 섹션 뒤에 **"월간 KPI 페이스"** 섹션.
  - 표: 행 = 4지표, 열 = 6~12월. 과거 월 = 실측 + 판정 이모지, 당월 = 실측(진행) + 밴드,
    미래 월 = 밴드만. `overflow-x-auto` 가로 스크롤.
  - 하단: 공식 KPI 2시점(8월 말·11월 말) 달성률 하이라이트.
  - 출처 공시 한 줄: "목표 밴드 = 내부 계획 가정치 · 위버스 = 자사 시트 집계".
  - `monthlyKpi`는 부모(`/api/miiwan` fetch 주체)에서 prop으로 내려받는다(기존 패턴).

## 4. 테스트

- worker: CSV 파싱 단위 테스트(빈 열·천단위 쉼표·연도 롤오버·헤더 탐지).
- 프론트: `miiwanKpi` 판정·표 데이터 조립 테스트(기존 `*.test.ts` 패턴).

## 검증 기준 (완료 조건)

1. 수집기 실행 → D1 `weverse_stats`에 6/16 이후 일별 행 적재.
2. **7월 값이 먼슬리 보고와 일치**: 구독 28.6K · 위버스 가입 6,895 · 멤버십 69.
3. 포지션 탭에 표가 렌더되고 과거 월 판정·당월 진행 표시가 맞다.
4. 전체 테스트 통과.

## 하지 않는 것 (YAGNI)

- 국가별 분포의 UI 노출(데이터만 적재 — 기존 "주 시청 국가" 카드와 중복 회피).
- 목표 밴드의 DB화(고정 계획 수치라 상수로 충분).
- weverse.io 직접 스크래핑(시트가 SSOT).
