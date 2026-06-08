# Weekly 분석 보고 주 2회 (수=중간점검 / 일=결산) — 설계

- 작성일: 2026-06-08
- 상태: 설계 확정 (구현 대기)
- 관련: `analyze-weekly.yml`, `worker/src/idol_sight/cli.py`, `worker/src/idol_sight/llm/weekly.py`, `worker/src/idol_sight/llm/prompts.py`, `migrations/`, `frontend/functions/api/insights.ts`, `frontend/functions/api/market-share.ts`, `frontend/src/views/Insights.tsx`
- 윤리/산식: V2.31 (analysis-depth / 환각 가드) 연장

## 1. 배경 / 문제

현재 weekly 분석 보고(`analyze-weekly`)는 **월요일 09:00 KST 주 1회**(`cron 0 0 * * 1`)만 실행되고, "오늘 이전의 가장 최근 **일~토 완결 주**"를 분석한다. 운영자는 주 1회로는 한 주의 흐름을 너무 늦게 본다고 판단해, **주 2회**(주중 중간점검 + 주말 결산)로 보고 빈도를 높이고자 한다.

단순 cron 변경만으로는 두 가지 문제가 생긴다.

1. **윈도잉**: 현행 `bounds` 로직은 어느 요일에 실행돼도 "직전 완결 일~토 주"를 잡는다. 그대로 두면 수요일·일요일이 **동일한 지난주**를 분석한다(내용 중복).
2. **부분 주 프레이밍**: 수요일 중간점검은 4일치(일~수) 미완결 주인데, 현 프롬프트는 "이번 주" 완결로 서술 → V2.31 환각 가드(부분 베이스라인을 확정 총량으로 단정 금지) 위배.

## 2. 목표 / 비목표

**목표**
- 수요일·일요일 주 2회 보고. 각 보고가 서로 다른 기간을 분석.
- 수요일 = 이번 주 일~수(진행 중). 일요일 = 직전 완결 일~토.
- 수요일도 전체 파이프라인(hanteo·SOV·health·멤버·감성·LLM) 실행 — 스냅샷 기반 스코어 최신 유지.
- 중간점검/결산을 DB에 영구 보존하되 구분 가능하게. 중간점검은 오래되면 피드에서 자동 숨김.

**비목표**
- Discord 발송 변경 없음 — `analyze-weekly`는 인사이트를 `insights` 테이블에만 쓰고 Discord 요약을 보내지 않는다(notify-fail 만). 보고는 대시보드 렌더링으로 전달. 따라서 주 2회로 늘려도 Discord 중복 핑 없음.
- 수동 dispatch 동작 변경 없음 — 기본 `final` 유지.
- `agg_market_share` 스키마 변경 없음(가드는 프런트 쿼리에서 처리).

## 3. 핵심 동작

### 3.1 실행 시각 / 모드 결정

- cron `0 14 * * 0,3` (일·수 14:00 UTC = **23:00 KST**).
  - 23:00 KST 는 14:00 UTC 와 같은 캘린더 날짜 → 요일 분기 롤오버 없음. 그날 낮(UTC 기준 같은 날) 수집분까지 윈도에 포함되는 이점.
- 모드는 실행 요일로 결정:
  - **일요일**(UTC weekday 6) → `final`: `ws=직전 일`, `we=직전 토` (현행 로직 유지).
  - **그 외(수요일)** → `interim`: `ws=이번 주 일`(`today−3일`), `we=today`(수).
- 날짜 검산:
  - 수요일 06-10 실행 → `ws=06-07`(일), `we=06-10`(수), 4일.
  - 그 주 일요일 06-14 실행 → `ws=06-07`, `we=06-13`, 완결주.
  - → 두 보고의 `week_start` 가 `06-07` 로 **동일**. `report_kind` 로 공존시킨다(§3.4).

### 3.2 전주 대비 비교 (왜곡 방지)

`build_context`는 `week_start`/`week_end`를 각각 −7일 시프트해 비교군을 잡는다(span 보존). 따라서 4일치 interim 은 **전주의 같은 4일**(일~수)과 비교 → apples-to-apples. 추가 로직 불필요.

### 3.3 LLM 프레이밍

`report_kind` 를 프롬프트 컨텍스트에 주입한다.
- `interim`: "주중 중간 스냅샷(일~수, 미완결)"으로 명시. 주간 총량을 확정으로 단정 금지. 한터 등 주간 차트 데이터가 mid-week 에 부재할 수 있음 명시(interim 실행 시 `hanteo_weekly WHERE week_end=수요일` → 행 없음 → 빈 배열).
- `final`: 현행 그대로.

### 3.4 저장 / 보존

- migration: `insights.report_kind TEXT NOT NULL DEFAULT 'final'`. 기존 행 전부 'final' 백필(DEFAULT 로 자동).
- `generate_weekly` 의 per-week DELETE 를 **kind 스코프**로 변경:
  - 현행: `DELETE FROM insights WHERE week_start = ?`
  - 변경: `DELETE FROM insights WHERE week_start = ? AND report_kind = ?`
  - → 같은 `week_start` 의 수요일 interim 과 일요일 final 이 공존. 재-dispatch 멱등성은 kind별로 유지.
- INSERT 에 `report_kind` 컬럼 추가.

### 3.5 SOV 부분 주 가드

수요일 전체 파이프라인은 `agg_market_share` 에 `week_end=수요일` 부분 주 행을 쓴다. 트렌드 차트(`market-share.ts`)는 전 행을 시계열로 그리므로 토요일 완결주 사이에 중간 점이 찍혀 왜곡된다.

- 가드: `market-share.ts` 트렌드 쿼리에 `AND strftime('%w', week_end) = '6'`(토요일=완결주만) 추가.
  - 기존 데이터의 week_end 는 전부 토요일 → 무영향. 신규 수요일 행만 차트에서 제외. zero-migration.
- LLM 컨텍스트(`build_context`)는 `WHERE week_end = ?` 로 정확히 interim 행을 참조하므로 영향 없음.

### 3.6 프런트 노출 / 자동 숨김

- 카드에 **중간점검 / 결산 배지**(`report_kind` 기반).
- 기본 피드(`insights.ts`, `week` 파라미터 없음): 오래된 interim 숨김.
  - `WHERE report_kind = 'final' OR week_start >= date('now', '-21 days')` (final 영구 노출, interim 은 **최근 3주**만).
  - `?week=` 명시 조회 시엔 둘 다 노출(필터 미적용) — 특정 주를 직접 볼 땐 그 주의 중간점검도 보이게.

## 4. 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `.github/workflows/analyze-weekly.yml` | cron `0 14 * * 0,3`; `bounds` 스텝 요일 분기 + `kind` 산출; `--kind` 전달 |
| `worker/src/idol_sight/cli.py` | `analyze-weekly` 에 `--kind interim\|final`(default `final`); `generate_weekly` 로 전달 |
| `worker/src/idol_sight/llm/weekly.py` | `generate_weekly`/`build_context` 에 `report_kind` 파라미터; 컨텍스트 주입; INSERT 에 컬럼; DELETE kind 스코프화 |
| `worker/src/idol_sight/llm/prompts.py` | `PROMPT_WEEKLY` 에 interim 프레이밍 블록 |
| `migrations/0083_insights_report_kind.sql` | `insights.report_kind TEXT NOT NULL DEFAULT 'final'` (직전 적용 대기 0082 다음) |
| `frontend/functions/api/insights.ts` | 기본 피드 interim 3주 숨김 필터; `report_kind` 컬럼 SELECT |
| `frontend/functions/api/market-share.ts` | 트렌드 쿼리 토요일(`%w='6'`) 가드 |
| `frontend/src/views/Insights.tsx` | 중간점검/결산 배지 렌더 |

## 5. 테스트

- worker
  - `test_prompts.py`: interim 프레이밍 블록 포함 회귀.
  - `weekly.py`: `report_kind` 스레딩 + DELETE kind 스코프(interim/final 공존, 재실행 멱등) 단위.
  - bounds 분기 로직: shell 로 남기면 검증이 어려우므로, 가능하면 모드/날짜 계산을 작은 파이썬 헬퍼로 추출해 단위 테스트(일=final/직전주, 수=interim/이번주 일~수). 추출이 과하면 워크플로 주석으로 검산 사례 명시.
- frontend
  - `insights.ts`: interim 3주 경계 숨김 + final 영구 노출 + `?week=` passthrough.
  - 배지 렌더.

## 6. 마이그레이션 / 배포 순서 (CLAUDE.md 규칙)

- `insights.report_kind` 를 읽는 프런트/worker 코드가 배포되기 **전에** migration 이 원격 적용돼야 한다.
- 운영자가 `gh workflow run migrate.yml`(또는 `wrangler d1 migrations apply --remote`)로 스키마부터 적용.
- `insights.ts` 의 `report_kind` SELECT 는 컬럼 부재 시 500 위험 → DEFAULT 'final' 컬럼이라 적용 후엔 안전. 적용 전 배포 갭을 줄이려면 migration 우선.

## 7. 결정 기록 (브레인스토밍)

- 윈도우: 수=이번 주 일~수(진행), 일=직전 완결 일~토. (대안: 롤링 7일 / 동일 완결주 중복 → 기각.)
- 보존: `report_kind` 컬럼 영구 보존 + 중간점검 **3주** 후 피드 숨김. (대안: 덮어쓰기 무스키마 → 기각, 이력 보존 원함.)
- 중간 실행 범위: **전체 파이프라인**(현행과 동일). (대안: 보고용만(SOV+LLM) → 기각, 스냅샷 스코어 일관성 우선.)
- 시각: 양쪽 **23:00 KST** (`cron 0 14 * * 0,3`).
