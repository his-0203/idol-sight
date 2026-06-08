# weekly LLM 데뷔 D-N 환각 근본 해결 + 오염 카드 정리 — 설계

- 작성일: 2026-06-08
- 상태: 설계 확정 (구현 대기)
- 관련: `worker/src/idol_sight/llm/weekly.py`, `worker/src/idol_sight/llm/prompts.py`, `insights` 테이블(원격 D1 데이터 정리)
- 윤리/산식: V2.31 (analysis-depth / 환각 가드) 연장

## 1. 배경 / 진단

운영자가 MiiWAN 브리핑 페이지의 IPX 권고 카드에서 발견 — **"MiiWAN 데뷔 D-24 카운트다운 ... 오늘부터 데뷔 D-24 (6/30)까지 ..."**. MiiWAN 실제 데뷔는 **2026-06-16 (오늘 6/8 기준 D-8)** 인데 권고문은 D-24·6/30 으로 틀렸다.

**원인 확정** (코드·원격 D1 조사):
- 문제의 텍스트 = `insights` 테이블의 LLM 생성 `ipx_action` 카드 (week_start=`2026-05-31`, scope=`miiwan`, type=`ipx_action`).
- 주차별 miiwan ipx_action 의 데뷔 D-N 이 제멋대로 — `D-30`(05-10주) / `D-20`(05-24주) / `D-24·6-30`(05-31주) / "데뷔 후속"(05-03주, 이미 데뷔한 듯). 단조 감소도 아니고 날짜도 틀림 → **LLM 이 매주 환각**.
- 뿌리:
  1. `build_context`(`weekly.py`)가 LLM 컨텍스트에 **데뷔일·D-N 을 전혀 안 넘김** (weekly.py 에 "debut" 문자열 0건).
  2. `PROMPT_WEEKLY`(`prompts.py`) few-shot 예시·MiiWAN scope 규칙이 **`D-30`/`총 30건`/`6/30` 를 하드코딩** → ground-truth 가 없는 LLM 이 이 패턴을 모방해 숫자/날짜를 발명.
- **데이터·결정론 경로는 정확**: `groups.debut_date='2026-06-16'`(원격 D1 확인, migration 0031 보정값), `/api/miiwan` days_to_debut + `MiiWANBriefing.tsx` D-N 배지 = **D-8** 정확. 즉 같은 페이지에 정확한 구조적 D-8 배지와 환각된 LLM "D-24" 카드가 공존해 모순돼 보였다. **문제는 LLM ipx_action 카드뿐.**

## 2. 목표 / 비목표

**목표**
- 미래 weekly 실행에서 LLM 이 데뷔 D-N·데뷔일을 **ground-truth(groups.debut_date)** 로만 쓰게 한다 (환각 차단).
- 이미 DB 에 쌓인 데뷔일 환각 카드를 정리한다.
- 수정 후 올바른(D-8) 카드를 즉시 재생성한다.

**비목표**
- `debut_date` 자체는 정확하므로 변경하지 않는다.
- 결정론적 경로(`/api/miiwan`, `MiiWANBriefing` 배지)는 정확하므로 변경하지 않는다.
- 스키마 변경 없음 (순수 worker 코드 + 데이터 정리).

## 3. 설계

### 3.1 근본 해결 (worker)

**A. `build_context` 에 데뷔 카운트다운 주입** (`weekly.py`)
- 신규 쿼리: `SELECT key, debut_date FROM groups WHERE debut_date IS NOT NULL AND is_active=1`.
- D-N 계산: 생성 시각의 **KST 기준 "오늘"** 과 각 `debut_date` 의 일수 차. 순수 함수로 분리(`_debut_countdown(rows, today)`)해 단위 테스트.
  - `days_to_debut = (debut_date − today).days`.
  - label: `days>0`→`D-{days}`(데뷔 전), `days==0`→`D-DAY`, `days<0`→`D+{abs(days)}`(데뷔 후).
- 컨텍스트 dict 에 `debut_countdown` 키 추가:
  ```json
  "debut_countdown": {
    "miiwan": {"debut_date":"2026-06-16","days_to_debut":8,"label":"D-8"},
    "plave":  {"debut_date":"2023-03-12","days_to_debut":-1183,"label":"D+1183"}
  }
  ```
  경쟁사도 포함 → 프롬프트의 "경쟁사 D-N 베이스라인" cross-ref 도 정확해진다.
- **"오늘" 기준**: ipx_action 은 forward-looking("오늘부터")이라 분석 주(week_end)가 아닌 **생성 시각(now) 기준**으로 D-N 계산. KST date 사용 (운영자의 "오늘" 과 정합, 대시보드 KST 프레이밍과 일치).

**B. 프롬프트 가드 + 예시 중성화** (`prompts.py PROMPT_WEEKLY`)
- 하드 가드 블록 추가 (V2.31 환각 가드 연장):
  > 데뷔 D-N·데뷔일·"D-Day"·날짜(예: 6/30)는 **반드시 컨텍스트 `debut_countdown` 의 값만** 사용한다. 추정·계산·발명 절대 금지. 그룹이 `debut_countdown` 에 없으면 D-N·데뷔일을 언급하지 않는다. 카운트다운 콘텐츠 건수("총 N건")도 `debut_countdown` 의 `days_to_debut` 에서 도출한다.
- few-shot 예시·MiiWAN scope 규칙의 하드코딩 리터럴 중성화:
  - `D-30` → `D-{N}` (또는 "`debut_countdown.<group>.label` 사용" 명시)
  - `총 30건` → `총 N건`
  - `6/30` 등 구체 날짜 제거
  - MiiWAN scope diagnosis 섹션의 `D-30 광고 검토` 등도 동일 처리.
- 목적: 예시 앵커가 환각의 절반이므로 가드 규칙과 예시 중성화를 **둘 다** 적용.

**C. 테스트**
- worker: `_debut_countdown` 순수 함수 — 미래(D-N)/당일(D-DAY)/과거(D+N) 경계, 빈 입력. `build_context` 가 `debut_countdown` 키를 포함(fixture groups 쿼리 stub 1개 추가).
- prompt: `test_prompts.py` 에 새 가드 토큰(`debut_countdown` / "추정·발명 절대 금지" 취지) 포함 회귀. 기존 few-shot 에 `D-30` 리터럴이 **남아있지 않은지** 회귀(중성화 검증).

### 3.2 오염 카드 정리 (운영자 원격 D1 실행)
- 데뷔일 환각 **4건만** 삭제: week 05-03("데뷔 후속 보도자료") / 05-10(D-30) / 05-24(D-20) / 05-31(D-24).
- **주의**: 05-03 주에는 정상 카드("멤버별 티저")도 있어 week_start 단위 삭제는 위험 → **id 단위** 삭제. 플랜에서 정확한 id 4개를 원격 조회 후 `DELETE FROM insights WHERE id IN (id1,id2,id3,id4)` SQL 을 확정.
- D1 원격 DELETE 는 운영자 직접 실행 (메모리 `feedback_d1_remote_apply_human_only`) — SQL 을 준비하고 운영자가 `! wrangler d1 execute ... --remote` 로 실행.

### 3.3 재생성
- 근본 해결 코드를 `main` 에 push (GitHub Actions analyze-weekly 가 새 worker 코드를 체크아웃·사용) → `gh workflow run analyze-weekly.yml` 수동 디스패치.
- 오늘(월)이면 bounds 가 interim 산출(week_start=이번 일 06-07, kind=interim). 생성 시각(6/8) 기준 D-8 올바른 카드 생성.

### 3.4 순서
구현(A·B·C, TDD) → worker 테스트 통과 → push → 운영자 정리 DELETE(SQL 제공) → 수동 디스패치 재생성 → 대시보드 확인.

## 4. 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `worker/src/idol_sight/llm/weekly.py` | `_debut_countdown` 순수 함수 + `build_context` 가 groups debut 쿼리 + `debut_countdown` 컨텍스트 주입 |
| `worker/src/idol_sight/llm/prompts.py` | 데뷔 D-N 환각 가드 블록 + few-shot/scope 예시의 `D-30`/`총 30건`/`6/30` 중성화 |
| `worker/tests/unit/test_llm_weekly.py` (또는 신규 test) | `_debut_countdown` 경계 + `build_context` debut_countdown 포함 |
| `worker/tests/unit/test_prompts.py` | 가드 토큰 포함 + `D-30` 리터럴 부재 회귀 |
| (데이터) `insights` 원격 D1 | 환각 4건 id 단위 DELETE (운영자 실행) |

## 5. 마이그레이션 / 배포

- 스키마 변경 없음 → migration 불필요.
- 코드 push → frontend-deploy 자동(프런트 무관) + Actions analyze-weekly 가 새 코드 사용.
- 데이터 정리는 코드와 독립 (운영자가 언제든 DELETE 실행 가능; 재생성은 push 후).

## 6. 결정 기록

- 정리 범위: **데뷔일 환각 4건만**(정상 마케팅 카드 3건 보존). id 단위 삭제로 05-03 정상 카드 보호.
- 재생성: **지금 수동 디스패치**.
- 예시 처리: 가드 규칙 + 예시 중성화 **둘 다**(앵커 제거).
- D-N 기준 시각: **생성 시각(now)의 KST date** (forward-looking "오늘부터" 정합).
- 주입 범위: `debut_date` 있는 **전 활성 그룹**(경쟁사 D-N 베이스라인 cross-ref 정확성).
