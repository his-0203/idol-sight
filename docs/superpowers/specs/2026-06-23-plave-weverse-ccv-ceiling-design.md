# PLAVE Weverse 천장 CCV — 충성도 floor/ceiling 모델

- 작성일: 2026-06-23
- 상태: 설계 승인 (구현 대기)
- 영향: worker(loyalty), migration, Pages Functions API, frontend(FanLoyaltyCard)

## 문제

PLAVE 충성도 점수(`agg_fan_loyalty.score`)는 `median(peak CCV) / subscribers` 전환율을
고정 anchor로 0~100 환산한 값이다. 그런데 peak CCV는 `live_ccv_samples`,
즉 **YouTube `concurrentViewers`만** 수집한 값이다(collector는 YouTube RSS +
`videos.list`만 읽음). PLAVE는 라이브 동시 시청자의 상당 비중이 Weverse로
빠지므로, YouTube-only CCV는 PLAVE의 실제 동시 시청자를 **구조적으로 과소집계**한다.

이 충성도 score는 그 자체로 그룹 공통 척도이며 **Health Intimacy**
(`cli.py`의 `loyalty_by_key`, `basis='scored'`만)로 들어가 그룹 간 Health
비교에 반영된다. 따라서 YouTube-only floor만 쓰면 PLAVE가 그룹 간 비교에서
부당하게 낮게 평가된다.

운영자 도메인 지식: Weverse 포함 시 PLAVE 라이브 동시 시청자는 **10만~20만 추정**.
이 수치는 수집된 데이터가 아니라 운영자 추정치다.

## 결정 (floor/ceiling 밴드)

- **floor** = YouTube 실측 CCV. PLAVE 자기 페이지의 1차 표시값·실데이터.
  기존 산식·표시 전부 불변.
- **ceiling** = Weverse 포함 단일 추정치(10만~20만의 평균 = **150,000**).
  그룹 간 비교(Health) + 카드의 "비교 기준" 라인에만 사용. 운영자 설정값.

핵심 원칙:
- ceiling은 flat 추정이라 방송별로 분해하지 않는다(어차피 Weverse는 미수집).
- floor 필드(`conversion_rate`, `peak_ccv_median`, `score`, CCV 사다리, trend)는
  전부 YouTube 실측 그대로 유지 — 정직성 보존([[project_organicity_heuristic_only]]
  의 "추정치를 실측처럼 보이게 하지 않는다" 원칙과 정합. ceiling은 별도 필드 +
  명시적 "천장/추정" 라벨로 분리해 혼동 차단).
- ceiling은 실제 라이브 활동이 있을 때만(broadcast_count ≥ 1) 산출 —
  순수 날조 방지(라이브를 안 한 그룹에 추정치만으로 점수 부여 금지).

## 변경 상세

### 1) 설정: `groups.ccv_ceiling_estimate INTEGER` (nullable)

- `plave = 150000`, 나머지 NULL.
- migration 0095에서 ALTER + UPDATE. 운영자가 후속으로 ISEDOL/STELLIVE
  (SOOP/치지직 동시송출) 등으로 확장 가능.

### 2) 스키마: `agg_fan_loyalty` 컬럼 3개 추가 (migration 0095, 같은 파일)

- `conversion_rate_ceiling REAL` — 150000 / 구독자 (0~1), ceiling 없으면 NULL
- `score_ceiling REAL` — ceiling 전환율의 0~100 점수, 없으면 NULL
- `ccv_ceiling INTEGER` — 산정에 쓴 천장 추정치(감사·표시용), 없으면 NULL
- 기존 floor 컬럼 전부 불변.

migration은 `ALTER TABLE groups ADD ...` + `UPDATE groups ... plave` +
`ALTER TABLE agg_fan_loyalty ADD ...` ×3을 한 파일에 담는다.

### 3) 산식: `worker/src/idol_sight/analysis/loyalty.py`

- `compute_loyalty(samples, subscribers, subs_at=None, ceiling_estimate=None)`:
  - base dict에 `conversion_rate_ceiling=None, score_ceiling=None, ccv_ceiling=None` 추가.
  - 기존 floor 계산은 전부 그대로.
  - floor가 산정된 경우(broadcast_count ≥ 1, subscribers 유효) +
    `ceiling_estimate`가 양수면:
    - `conv_ceil = ceiling_estimate / subscribers` (최신 구독자 = 분모,
      flat 추정이라 subs_at 시점 매칭 안 함)
    - `score_ceiling = round(score_from_conversion(conv_ceil), 2)`
    - `conversion_rate_ceiling = conv_ceil`
    - `ccv_ceiling = ceiling_estimate`
  - broadcast_count == 0(insufficient)면 ceiling 필드도 None 유지.
- `build_fan_loyalty`:
  - tracked 조회 SQL을 `SELECT key, ccv_ceiling_estimate FROM groups WHERE ccv_tracked=1`로
    확장(또는 별도 dict 조회 후 매핑).
  - `compute_loyalty(..., ceiling_estimate=<그룹값>)` 호출.
  - `_INSERT_SQL` + INSERT 파라미터에 새 컬럼 3개 추가.

### 4) Health: `worker/src/idol_sight/cli.py`

- `loyalty_by_key` 조회 SQL:
  ```sql
  SELECT group_key, COALESCE(score_ceiling, score) AS score
  FROM agg_fan_loyalty
  WHERE basis='scored' AND COALESCE(score_ceiling, score) IS NOT NULL
  ```
- PLAVE는 ceiling, 나머지는 floor 폴백. 기존 try/except graceful 유지
  (0095 미적용 시 컬럼 없어 throw → except → `loyalty_by_key={}` 폴백,
  Health가 통째로 죽지 않음).

### 5) API: `frontend/functions/api/group/[key].ts`

- 기존 floor loyalty 쿼리는 **불변**.
- ceiling 3컬럼은 **별도 `.catch(()=>null)` 쿼리**로 분리 조회:
  ```sql
  SELECT conversion_rate_ceiling, score_ceiling, ccv_ceiling
  FROM agg_fan_loyalty WHERE group_key=?
  ```
- merge: `fan_loyalty: { ...fanLoyalty, ...(ceiling ?? {}), broadcasts }`.
- 분리 이유: 0095 미적용 시 ceiling 쿼리만 실패하고 floor 카드는 정상 렌더
  (단일 쿼리로 합치면 컬럼 없을 때 전체 null → 카드 사라지는 회귀).
  배포↔마이그레이션 graceful degradation 규칙.

### 6) 카드: `frontend/src/components/FanLoyaltyCard.tsx` + `GroupContent.tsx`

- `FanLoyalty` 인터페이스에 `conversion_rate_ceiling`, `score_ceiling`,
  `ccv_ceiling` (전부 nullable) 추가.
- 1차 score = floor `score` (현행 그대로, 정직한 자기 실측).
- `score_ceiling != null`이면 score 행 아래 라인 추가:
  > 그룹 간 비교 기준(Weverse 포함 천장 ~15만): {round(score_ceiling)}점 · {fmtPct(conversion_rate_ceiling)}
  - "15만"은 `ccv_ceiling`에서 파생(`{Math.round(ccv_ceiling/10000)}만`).
- `GroupContent`가 `groupKey`를 카드에 전달. 카드에 `CCV_PLATFORM_NOTES:
  Record<string, { platform: string; bandText: string }>` 맵 추가
  (`plave: { platform: "Weverse", bandText: "10만~20만" }`).
- `groupKey`가 맵에 있고 `ccv_ceiling != null`이면 amber 주석 블록:
  > ⚠ CCV는 YouTube 동시 시청자만 수집(하한). PLAVE는 Weverse 동시 송출 비중이
  > 커 실제 동시 시청자 10만~20만 추정. 그룹 간 충성도 비교에는 Weverse 포함
  > 추정 천장(평균 15만) 사용. Weverse 수치는 미수집 운영자 추정치.

### 7) 테스트

- `worker/tests/unit/test_loyalty.py`:
  - ceiling_estimate + 구독자 + 방송 ≥1 → conversion_rate_ceiling/score_ceiling/
    ccv_ceiling 산출, floor 필드 불변.
  - ceiling_estimate=None → ceiling 필드 전부 None, floor 불변(하위호환).
  - broadcast_count==0(insufficient) → ceiling 필드 None.
  - score_from_conversion 경계(150000/구독자가 anchor 구간에 맞는지 1건).
- `frontend/src/components/FanLoyaltyCard.test.ts`:
  - `CCV_PLATFORM_NOTES` lookup(plave→객체, 그 외→undefined).
  - ceiling 라인 파생값(`ccv_ceiling/10000` → "15만") 헬퍼.

## 범위 밖

- 실제 Weverse CCV 수집(3자 API 불가/미요청).
- 방송별 Weverse CCV 분해.
- PLAVE 외 그룹의 천장값(운영자 후속 설정).
- ceiling을 weekly LLM 컨텍스트에 주입.

## 배포 순서

migration 0095는 worker(loyalty build)와 frontend(group API)가 새 컬럼을
**읽고 쓴다**. 따라서:
1. 코드 push 후 운영자가 즉시 `gh workflow run migrate.yml`로 0095 원격 apply.
2. 미적용 구간은 graceful degradation으로 방어(Health loyalty 폴백 {},
   group API ceiling 쿼리 `.catch(()=>null)` → floor 카드 정상).
3. 적용 후 다음 aggregate cron(21:30 KST)이 `agg_fan_loyalty`에 ceiling 채움.
