# 라이브 CCV 기반 팬 충성도 점수화 설계

- 날짜: 2026-06-08
- 상태: 설계 승인 (구현 대기)
- 선행: V2.38 라이브 CCV collector (`live_ccv_samples`, `groups.ccv_tracked`), V2.40~2.43 organicity/growth "규모와 직교한 진정성" 철학
- 관련 메모리: `project_organicity_heuristic_only`, `project_miiwan_exec_organic_vs_paid`

## 1. 배경 / 문제

V2.38에서 라이브 동시 시청자(CCV)를 수집하기 시작했으나, 데이터가 **MiiWAN 브리핑 페이지의 `LiveCcvCard` 한 곳에서만** 노출되고 평가 점수에는 전혀 반영되지 않는다. 또한 수집 대상이 4개 그룹(`miiwan/plave/owis/wegosix`)으로 제한되어 있다.

운영자 제안: ① CCV를 각 그룹 상세페이지에도 기록, ② CCV로 **충성 팬층을 점수화**하여 평가에 반영, ③ 추적 그룹 확대.

핵심 통찰 — **CCV 절대값은 충성도가 아니라 "규모" 신호다**. 구독자가 많은 그룹이 당연히 CCV도 높다. 충성도의 올바른 프록시는 **CCV/구독자 전환율** = "구독자 중 몇 %가 실제로 라이브에 들어오는가". 이는 organicity 점수가 "규모와 직교한 진정성"을 강조해온 프로젝트 철학(V2.40~2.43)과 일관된다.

## 2. 결정 사항 (운영자 확정)

| 항목 | 결정 |
|---|---|
| **추적 확대 범위** | `skinz, myrakl, bdawn, bthd` 추가 → 결과적으로 `group_model='corporate'` 8개 전부. 버튜버 출신 segmentary(ISEDOL/STELLIVE/UR:L)는 **제외** (운영자가 "K-POP 분류 그룹만"으로 한정). |
| **충성도 정의** | peak CCV / 구독자 = **전환율**. 규모와 직교. |
| **정규화 방식** | **고정 벤치마크 임계값** (first-pass, 라이브 데이터로 보정). percentile rank 아님 — CCV 데이터 있는 그룹이 적어 상대순위 불안정 + 절대 해석 필요. |
| **평가 반영** | **둘 다** — 상세페이지 별도 카드 + Health Score Intimacy factor 통합. |
| **Intimacy 통합 결측 처리** | loyalty 데이터 있는 그룹만 3신호로 확장, 없으면 기존 2신호 재정규화 → 라이브 안 한 그룹 **페널티 0**. |

## 3. 데이터 & 수집 (Part A)

### 3.1 migration 0084 — 추적 확대 + 충성도 테이블

```sql
-- ccv_tracked 확대 (corporate 8개 전부)
UPDATE groups SET ccv_tracked=1 WHERE key IN ('skinz','myrakl','bdawn','bthd');

-- 충성도 점수 스냅샷 (그룹당 1행, 전체 DELETE+rebuild)
CREATE TABLE IF NOT EXISTS agg_fan_loyalty (
  group_key        TEXT NOT NULL PRIMARY KEY REFERENCES groups(key),
  conversion_rate  REAL,            -- median peak CCV / subscribers (0~1)
  peak_ccv_median  REAL,            -- 최근 윈도우 방송별 peak CCV 의 중앙값
  broadcast_count  INTEGER NOT NULL DEFAULT 0,  -- 윈도우 내 distinct 라이브 방송 수
  subscribers      INTEGER,         -- 산정 시점 분모 (감사용)
  score            REAL,            -- 0~100, basis=insufficient 면 NULL
  basis            TEXT NOT NULL,   -- 'scored' | 'low_confidence' | 'insufficient'
  ccv_trend_pct    REAL,            -- 시청자 증감율: 전반부→후반부 median peak 변화율 (표시용, score 미반영)
  trend_basis      TEXT NOT NULL DEFAULT 'unknown',  -- 'rising' | 'falling' | 'flat' | 'unknown'
  window_days      INTEGER NOT NULL DEFAULT 56,
  snapshot_at      TEXT NOT NULL
);
```

수집 인프라(`collectors/live_ccv.py`, `cli.py collect-ccv`, `collect-ccv.yml`, `_load_ccv_targets`)는 V2.38 그대로 — `_load_ccv_targets`가 `ccv_tracked=1`을 자동 fetch하므로 4→8개로 자연 확대된다. **collector 코드 변경 없음.**

## 4. 충성도 산식 (Part B) — `worker/src/idol_sight/analysis/loyalty.py`

organicity/growth 패턴: 순수함수 분해 + `build_fan_loyalty(db, now_iso)` (full DELETE+rebuild), `cli.py aggregate`에 등록.

### 4.1 전환율 계산

1. 그룹의 `live_ccv_samples`에서 최근 `WINDOW_DAYS=56`일(`sampled_at >= now-56d`) 행을 fetch. (라이브 빈도가 낮은 corporate 그룹은 28일에 방송이 1~2개뿐일 수 있어 56일로 표본 확보.)
2. `video_id`별로 그룹핑 → 각 방송의 `peak_ccv = MAX(concurrent_viewers)`. (distinct video_id = distinct 방송)
3. `peak_ccv_median = median(방송별 peak_ccv 리스트)`. **중앙값** 사용 — 데뷔 특집 등 단발 outlier에 강건, 충성도는 안정적 신호여야 함.
4. `subscribers` = 그룹의 최신 `agg_summary.subscribers` (또는 최신 youtube stat).
5. `conversion_rate = peak_ccv_median / subscribers`.

### 4.2 점수화 (고정 벤치마크, 구간 선형보간)

전환율 → 0~100 점수. 구간 내 선형보간으로 연속화 (organicity 스타일):

| 전환율 구간 | 점수 구간 | 해석 |
|---|---|---|
| < 0.5% | ~20 (하한 클램프) | 매우 낮음 |
| 0.5% – 1.5% | 20 → 50 | 낮음 |
| 1.5% – 3% | 50 → 70 | 보통 |
| 3% – 6% | 70 → 88 | 높음 |
| 6%+ | 88 → 100 (상한 클램프) | 매우 높음 |

임계값 상수(`LOYALTY_BANDS`)는 모듈 상단에 명시하고 **first-pass임을 주석으로 표기** — 라이브 데이터 축적 후 실측 분포로 보정한다.

### 4.3 결측·희소 가드 (growth 철학)

| 조건 | basis | score | 비고 |
|---|---|---|---|
| 윈도우 내 라이브 방송 0개 | `insufficient` | NULL | "데이터 축적 중" |
| 방송 1개뿐 (`broadcast_count==1`) | `low_confidence` | 산정함 | "단발 방송 기준" 신뢰도 낮음 표시 |
| 방송 2개 이상 | `scored` | 산정함 | 정상 |
| subscribers 0/NULL/비정상 | `insufficient` | NULL | V2.43.3 구독자 동결/이상치 분모 방어 (sanity 체크) |

> **분모 주의**: YouTube 구독자는 대형 채널에서 반올림·동결된다(V2.43.3). 전환율 분모로 쓰되, subscribers가 0이거나 결측이면 산정 보류. 반올림 자체는 전환율 용도에 충분한 정밀도(분자 CCV가 지배적 변동).

### 4.4 시청자 증감율 (표시용, score 미반영)

충성도 score는 전환율 **레벨**을 재므로, 별도로 "팬층이 늘고 있나"의 **모멘텀**을 보여준다 (growth 철학: 레벨과 추세 분리).

- 윈도우 내 방송을 `published`/`sampled_at` 시간순 정렬 → 전반부/후반부 절반으로 분할.
- `ccv_trend_pct = (후반부 median peak − 전반부 median peak) / 전반부 median peak`.
- `trend_basis`:
  - 방송 수 < 4 (전·후 각 2개 미만) → `unknown` (추세 보류)
  - |ccv_trend_pct| < `TREND_FLAT_BAND`(예 ±10%) → `flat`
  - 그 외 부호에 따라 `rising` / `falling`
- **score 미반영** — 충성도 점수는 전환율 레벨로 유지, 증감율은 카드에 화살표+%로 표시만 한다.

## 5. Health Score Intimacy 통합 (Part C) — `analysis/health_score.py`

현재 Intimacy:
```
intimacy = (eng_n × 0.55 + comm_n × 0.45) × (1 − neg_ratio)
```

충성도 데이터가 있는 그룹만 3신호로 확장, 없으면 기존 2신호 그대로:

```
if loyalty 있음 (basis != insufficient, score not NULL):
    loyalty_n = score / 100
    intimacy = (eng_n × 0.40 + comm_n × 0.30 + loyalty_n × 0.30) × (1 − neg_ratio)
else:
    intimacy = (eng_n × 0.55 + comm_n × 0.45) × (1 − neg_ratio)   # 기존과 완전 동일
```

- 가중치 0.40/0.30/0.30은 제안값 (loyalty 데이터 축적 후 재검토 가능).
- **재정규화로 페널티 0**: loyalty 결측 그룹은 기존 경로를 그대로 타므로 점수 불변. 라이브를 "안 해서" 손해 보는 일 없음.
- **build 순서**: `build_fan_loyalty`가 health_score build보다 먼저 실행 → health_score가 `agg_fan_loyalty`를 읽어 입력 주입. (`cli.py aggregate`의 호출 순서에 loyalty를 health_score 앞에 등록.)

### 5.1 회귀 가드 (⚠️ Health Score 산식 변경)

- 기존 health_score fixture는 모두 loyalty 없는 케이스 → **2신호 경로로 점수 불변**이어야 한다. 이를 명시적 회귀 테스트로 고정.
- loyalty 있는 신규 fixture 추가: 3신호 경로 검증 + 가중치 합 sanity.

## 6. API & 프런트 (Part D)

### 6.1 API
- `frontend/functions/api/group/[key].ts` 응답에 `fan_loyalty` 객체 추가 (`agg_fan_loyalty` 최신 1행 또는 null). 상세페이지가 이미 이 엔드포인트를 1회 호출하므로 **별도 fetch 불필요**.
- 테이블 미존재 시 graceful `null` (배포↔마이그레이션 순서 규칙, try/catch).

### 6.2 상세페이지 카드 — `frontend/src/components/FanLoyaltyCard.tsx`
- 배치: **content 탭(GroupContent) 내** (별도 탭 신설 안 함).
- 표시:
  - 전환율 % (큰 글씨) + 점수(0~100)/등급색
  - **시청자 증감율** (↑↓% + 색) — `trend_basis`가 unknown이면 "추세 보류"
  - 최근 방송 peak CCV 스파크라인 (방송별 peak 시계열)
  - 동일 코호트(corporate) 벤치마크 비교 막대/순위
  - `insufficient` → "라이브 데이터 축적 중", `low_confidence` → "단발 방송 기준" 배지
- 카피 (organicity 교훈): **"충성도 = 구독자 중 라이브 전환율(규모 무관). 절대 시청자 수와 별개"** 1줄.

### 6.3 기존 자산
- MiiWANBriefing의 `LiveCcvCard`는 **유지** — 실시간 라이브 반응(peak/avg/sparkline)과 충성도 점수는 역할이 다르다.

## 7. 윤리

CCV·구독자·전환율은 모두 **공개 외형 지표**다. growth 탭(V2.43)이 전 그룹에 외형 지표를 노출한 것과 동일 논리 → v2-roadmap §4(자사 깊이/경쟁사 외형) 위배 없음. 전 그룹 카드 노출 OK.

## 8. 범위 밖 (후속)

- 고정 임계값 실측 보정 (라이브 데이터 축적 후 — first-pass calibration)
- segmentary(ISEDOL/STELLIVE/UR:L) CCV 추적 — 정작 라이브가 핵심이나 운영자가 이번 범위에서 제외
- 재시청/지속력 기반 충성도 (한 방송 내 avg/peak 유지율, 방송간 재방문 — V2 산식)
- weekly LLM 컨텍스트에 충성도 주입
- 슈퍼챗/도네이션 금액 (3자 API 불가 — V2.38부터 알려진 한계)

## 9. 테스트

- `worker/tests/unit/test_loyalty.py` 신규: median/전환율/구간보간 경계값/가드(0방송·1방송·subscribers 결측)/basis 라벨/증감율(전후 분할·flat band·<4방송 unknown).
- `test_health_score` 회귀: loyalty 없는 기존 fixture 점수 불변 + loyalty 있는 신규 fixture 3신호 경로.
- `test_migrations_groups_json.py`는 JSON 컬럼 가드라 무관 (이번 migration은 JSON 컬럼 미변경).

## 10. 배포 / 운영

- **migration 0084 운영자 원격 apply 필요** (`gh workflow run migrate.yml`). `group/[key].ts`가 `fan_loyalty` SELECT하므로 graceful null로 적용 전 갭 방어.
- 적용 후 다음 `aggregate` cron(21:30 KST) 또는 수동 실행이 `agg_fan_loyalty` 채움.
- collect-ccv cron이 다음 윈도우부터 8개 그룹 수집 → 56일 축적되며 점수 안정화.
