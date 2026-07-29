# 동시기 성과 — "다음 보고까지" 카드 + 데뷔 창 활동 수치 보강 Implementation Plan

> **For agentic workers:** Task 1→2→3 순차 구현, Task 4에서 페르소나 검토 1라운드 → 수정 → 검증·배포.

**Goal:** (사용자 요청 2026-07-30) ① 투자사·경영진이 "지금 잘하는 것 / 보완할 것 / **다음 액션으로 무엇을 해서 다음 보고 때 무엇을 가져올지**"까지 한 카드에서 보게 한다 ② 이미 수집돼 있으나 미사용인 수치(데뷔 창 업로드 편수·롱/숏 구성·창 내 총 조회수·참여율)를 추가해 "투입 대비 산출"과 "반응 밀도" 축을 보강한다.

## 완료 기준
- 기존 K1~K6(2026-07-30-cohort-readability.md) 전부 유지 — 특히 위계 3단·문장 다이어트·정직성.
- 새 카드의 강점/보완은 **기존 섹션 verdict들의 데이터에서 집계·파생**(중복 문장 재작성 금지 — 요약 배열). 액션·산출물 약속은 **편집 가능한 상수**(코드 주석에 "운영 약속 — 데이터 파생 아님, 보고 주기마다 갱신" 명시)로 하되 수치 인용은 파생.
- 새 수치는 라벨 충돌 금지: 기존 "영상 N편"(scored 표본)과 새 "업로드 N편"(전수) 구분 명시.
- 페르소나(투자+타이포 통합) 리뷰 Critical·Important 0.

## Global Constraints
- pnpm, frontend/에서 vitest·typecheck·build. 결론·수치 하드코딩 금지(명세된 액션 상수 예외). 임계·창 상수 보간. 재제안 금지 지표(dc_total_posts·naver_total_news·awareness 계열·CCV/충성도(데뷔 정렬 불가)) 사용 금지. plave=참조(순위 제외) 규칙 유지.
- 실측 참고: 코호트 유기성 창 버킷은 debut_window_organicity_summary에 그룹×버킷으로 존재, `video_count`(전수)·`long_form_count`·`short_form_count`·`total_views`·`total_engagement` 컬럼이 이미 있고 API가 같은 테이블을 SELECT 중(가중치용으로 total_views만 사용).

---

### Task 1: API — 데뷔 창 활동 집계 필드

**Files:** `frontend/functions/api/miiwan-cohort.ts`, `frontend/src/lib/cohortHeadline.ts`(OrgRow), `frontend/tests/functions/api_miiwan_cohort.test.ts`

- 유기성 summary 쿼리 SELECT에 `video_count, long_form_count, short_form_count, total_engagement` 추가(orgWindow.buckets 동일 창).
- 그룹별 합산해 organicity 행에 추가: `uploads: number`(video_count 합, 전수) · `uploads_long: number` · `uploads_short: number` · `window_views: number | null`(total_views 합; 0이면 null 아님 — 실측 0 허용, 행 자체 없으면 null) · `engagement_per_1k_views: number | null`(= total_engagement 합 ÷ total_views 합 × 1000, 소수 1자리; 분모 0이면 null). 데이터 없는 그룹은 uploads 0·나머지 null. degrade는 기존 organicity와 동일 경로(쿼리 실패 시 organicity 비움 — 별도 플래그 불필요, 같은 쿼리이므로).
- 참고: `engagement_per_1k_views`로 하는 이유 — % 표기(0.x%)보다 "조회 1,000회당 반응 N건"이 경영진 독해에 직관적이고 기존 "구독 효율(subs/1k뷰)" 어법과 짝이 맞는다.
- 테스트: 픽스처로 합산·비율·분모0·필드결측 케이스.

### Task 2: UI — "데뷔 창 활동" 컴팩트 표 (⑤ 자연 유입 섹션 뒤, 새 소섹션)

**Files:** `MiiWANCohortReport.tsx`, `cohortHeadline.ts`(verdict), 테스트

- 새 섹션 제목 "데뷔 창 활동 — 얼마나 올려서 얼마나 반응을 얻었나" + 1줄 리드. 컬럼: 그룹 / 업로드(롱·숏 병기, "업로드 N편(롱 a·숏 b)") / 창 내 조회수 / 조회 1,000회당 반응. 정렬은 참조 하단·조회수 내림차순. miiwan 행 강조(기존 표 관례).
- 라벨 주의: 자연 유입 섹션의 "영상 N편"(판정 표본)과 구분 — 각주 1줄("업로드 편수는 창 내 전체, 자연 유입의 영상 수는 판정된 표본만").
- `activityVerdict(d): SectionVerdict` 신설(잘함/보완 자동, 예: 업로드 수 순위·반응 밀도 순위 파생 — 참조 제외, 데이터 없으면 null). VerdictLines 재사용. 문장 1개·sub 1줄 상한 준수.
- 기존 자연 유입 섹션 리드의 "편수 기준" 서술과 충돌 없는지 확인.

### Task 3: "다음 보고까지" 카드 (⑥ 각주 바로 위)

**Files:** `MiiWANCohortReport.tsx`, `cohortHeadline.ts`, 테스트

- `nextReportCard(d, verdicts): { strengths: string[]; focus: string[]; actions: Array<{action: string; deliverable: string}> }` 순수 함수:
  - `strengths`: 데이터 파생 불릿 최대 3 — 각 섹션 verdict가 이미 계산한 값 재사용(총 성장 순위 1~2위면 그 한 줄·데뷔 전 배수 1위면·편수 점수 상위면·데뷔 후 순증 지속이면). 조건 미충족 항목은 생략(빈 배열 허용).
  - `focus`: 데이터 파생 불릿 최대 3 — 데뷔 후 배수 하위권이면·판정 점수 < organic이면·조회수 쏠림(paid_view_share 존재)이면.
  - `actions`: **편집 가능한 상수 배열** `NEXT_REPORT_ACTIONS`(파일 상단, 주석: "운영 약속 — 데이터에서 파생되지 않음. 보고 주기마다 사람이 갱신한다.") 초기값 3개: ① {action: "광고 집행 내역(영상·기간·금액)을 정리해 자연 유입 판정과 대조", deliverable: "판정 점수 검증 결과와 광고 의존도 실측"} ② {action: "데뷔 후 성장 레버(콘텐츠 주기·구독 유도 지점) 실행", deliverable: "D+{as_of+30}년 아님 — 다음 보고 시점의 데뷔 후 배수·순증 재측정"} — deliverable의 시점 표기는 컴포넌트에서 `D+${as_of_day}` 이후임을 파생 표기 ③ {action: "업로드 구성(롱·숏)과 반응 밀도 유지 관찰", deliverable: "데뷔 창 활동 표의 추이 비교"}. (문구는 다듬되 "액션→가져올 것" 쌍 구조 유지.)
- 카드 렌더: 강조 카드(헤드라인과 동급 시각, 좌측 보더), 3열 또는 3블록 — "잘하고 있는 것(불릿)" / "보완할 것(불릿)" / "다음 보고까지(액션→가져올 것)". 각 불릿 1줄 상한. strengths/focus 빈 배열이면 해당 블록 생략.
- 헤드라인 카드와 중복 최소화: 헤드라인은 "한 줄 결론", 이 카드는 "행동 지향 요약" — 리드 1줄로 역할 구분 명시.

### Task 4: 검토·배포
- 통합 페르소나 리뷰 1회(투자심사역+타이포 겸임, opus): 새 카드·새 표가 K1~K6과 기존 화면과 모순 없는지, 실측 시뮬레이션. Critical·Important만 수정 웨이브 1회 → 스코프 재확인.
- `pnpm vitest run`+typecheck+build → main ff-머지·푸시(자동 배포) → CI 감시.
