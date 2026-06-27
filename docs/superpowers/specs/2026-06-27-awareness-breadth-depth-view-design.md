# 인지도 정의 정제 — organicity 직교 병기 + 인지도×코어팬 2D 사분면 설계서

> **기준일**: 2026-06-27 · **성격**: 인지도 정의 재검토(3-렌즈 분석 워크플로) 결론의 **즉시 구현분**. 점수 산식 **불변**, 신규 수집 **0**, **UI/표기 전용**. 카테고리(K-POP/서브컬처) 분리 **하드 제약** 유지.

## 0. 배경 — 인지도 정의 재검토 결론(요약)

사용자 질문: "광고로 모은 조회/구독을 인지도에 반영해야 하나? 추정 코어팬까지 반영해야 진짜 인지도인가?" → 3-렌즈 분석(측정타당성·마케팅정의·아키텍처) 완전 수렴:

- **인지도 = breadth(폭), 코어팬 = depth(깊이). 직교·종종 역상관.** 코어팬을 인지도 산식에 합치면 category error·이중계상(double jeopardy)·시스템 3축(core_fan_estimate·live_activity·Health intimacy) 중복 → **명확한 NO**.
- **광고로 산 도달도 breadth 관점엔 진짜 인지(reach is reach)** → "광고분 배제"는 틀림. 진짜 위협은 누적 stock 프록시의 그룹별 광고비 편향이 리더-상대 순위타당성을 흔드는 것. **engagement 가중 보정은 함정**(Health intimacy·organicity와 수렴해 변별축 파괴).
- **정공법**: ① 검색량(자발 신호) 추가 — 자격증명 막힘으로 **이연** ② organicity를 산식에 섞지 말고 **직교 caveat로 병기** ③ breadth×depth를 합산 아닌 **2D로 함께 읽기**.

본 스펙은 **②·③의 즉시 구현분**. ①(검색량)·가중 재배분(점수 이동 동반)은 별도 후속.

## 1. 목표 / 비목표

**목표**
- (A) **organicity 직교 caveat 플래그**: MarketOverview 각 그룹 카드의 인지도 표기 옆에, 데뷔윈도우 organicity 헤드라인 verdict가 주의 구간(borderline/suspect/likely_paid)일 때만 작은 경고 플래그. "인지도 상위 BUT 매수된 도달 의심"을 운영자가 직접 읽게.
- (B) **인지도×코어팬 2D 사분면**: 각 카테고리 섹션에, x=인지도 점수 · y=추정 적극 코어(est_active_core)의 산점도. 합치지 않고 함께 읽어 "매스인지·얕은코어(광고형) / 매스인지·강코어(진성) / 니치·강코어(컬트) / 저·저"를 변별.

**비목표**
- 인지도/Health 등 **점수 산식 변경**(전면 불변). organicity를 인지도에 **곱/합**(스코프 불일치 — 누적 stock × 데뷔윈도우 flow-quality). **검색량 수집**(이연). 가중 재배분(이연). 신규 데이터 수집.

## 2. 데이터 소스 (전부 기존)

- **인지도**: `/api/market` → `groups[k].awareness.{score, category_rank}` (P2b #49, 머지됨).
- **추정 코어팬**: `/api/market` → `groups[k].core_fan_estimate.{est_engaged_fans, est_active_core}` (P2a 확장 #52, **본 작업의 선행 머지 필요**).
- **organicity 헤드라인**: `/api/debut-window/summary` → `SummaryRow[]`(group_key×window_bucket). 그룹→단일 collapse는 **기존 `CompetitorOrganicityBar`의 exact/current/none 버킷 fallback + `lib/organicity.ts`(`headlineOrganicScore`/`scoreToVerdict`/`isThinSample`) 재사용**.

## 3. 설계 결정 (이유 포함)

**3.1 organicity는 서버(/api/market) 아닌 클라이언트에서 합류.** 버킷 fallback 선택 로직이 frontend lib(`debutWindow.ts` `DEFAULT_CURRENT_BUCKET="D-Day"`/`DEFAULT_DISPLAY_BUCKETS`)에 있고, `organicity.ts` 헤더가 *교차언어 임계 드리프트 방지*를 명시(과거 V2.21→V2.37 churn). 서버에서 버킷 선택을 재구현하면 드리프트 재발 → MarketOverview도 `api.debutWindowSummary()`를 fetch하고 **공유 collapse 헬퍼**로 처리.

**3.2 그룹→단일 organicity collapse를 `lib/organicity.ts`로 추출(DRY).** 현재 `CompetitorOrganicityBar`에만 있는 `DisplayRow` 선택(exact→current→none, thin-sample 플래그)을 `selectGroupOrganicity(rows, groupKey, displayBuckets, currentBucket, mode)` 순수함수로 추출. 바와 MarketOverview가 같은 헬퍼 사용 → 색·임계·버킷 의미 단일 출처(파일 헤더 철학 정합). 바는 동작 불변(리팩터만).

**3.3 caveat 플래그 노출 규칙.**
- verdict ∈ {borderline, suspect, likely_paid} **그리고** `isThinSample(scored_count)==false` 일 때만 표시. thin(영상 1–2편)·insufficient/null → **미표시**(1–2편으로 늑대 외치지 않음).
- 색은 `verdictColor`. 라벨 짧게: borderline=`오가닉성 주의`, suspect=`유료 의심`, likely_paid=`유료 의심↑`. 작은 점+텍스트(카드 인지도 줄 옆).
- **스코프 정직성 캡션**(호버/각주): "영상 카탈로그 기준 — 인지도(누적)와 다른 축의 참고 신호. 인지도 점수에는 반영 안 됨."

**3.4 2D 사분면은 카테고리별 분리(하드 제약).** 인지도가 카테고리-리더 상대 정규화라 K-POP 80과 서브컬처 80은 비교 불가 → 카테고리 섹션마다 독립 사분면. 서브컬처도 표시(바의 isedol/stellive/uryael 제외와 달리, 여긴 카테고리 분리라 서브컬처 섹션에서 정상 노출).
- **x = awareness.score** (0–100, null이면 점 제외). **y = core_fan_estimate.est_active_core** (count, 자릿수 차 → **log 스케일**; null 제외).
- **사분면 분할선**: 둘 다 해당 카테고리 내 **중앙값**(상대 위치 — N이 작아 절대 임계보다 정직). 분할선에 "카테고리 중앙값" 명시.
- **사분면 라벨**: 우상=`진성 강세(고인지·강코어)`, 우하=`광고형/바이럴(도달≫헌신)`, 좌상=`니치 충성(컬트)`, 좌하=`저조`.
- **점 라벨**: 그룹명 직접 표기(N이 작음). organicity caveat 그룹은 점에 ⚠ 마커 동반(3.3과 일관).
- **캡션**: "넓이(인지도) × 깊이(추정 코어팬) — 합치지 않고 함께 읽기. 코어팬은 좋아요·댓글 추정(ground-truth 아님)."

**3.5 sortMode·정렬 불변.** 기존 health/awareness 토글·랭킹 그대로. 2D는 섹션 상단 별도 패널, 카드 리스트는 불변.

## 4. 파일 변경

- **Create** `frontend/src/components/BreadthDepthQuadrant.tsx` — props: `{ groups: Array<{key,name,awareness,coreActive,organicityCaveat}>, category }`. SVG 산점도(중앙값 십자선·4사분면 라벨·점 라벨·⚠ 마커). 카테고리당 1개.
- **Modify** `frontend/src/lib/organicity.ts` — `selectGroupOrganicity(...)` + `OrganicityCaveat`(verdict, score, thin, shown) 순수함수 추가. 기존 export 불변.
- **Modify** `frontend/src/components/CompetitorOrganicityBar.tsx` — 인라인 collapse를 `selectGroupOrganicity` 호출로 교체(동작 불변 리팩터).
- **Modify** `frontend/src/views/MarketOverview.tsx` — (a) `api.debutWindowSummary()` fetch + 그룹별 caveat 계산 (b) 카드 인지도 줄 옆 caveat 플래그 (c) 각 카테고리 섹션에 `<BreadthDepthQuadrant>` 패널.
- **Test** `frontend/tests/lib/organicity.test.ts` — `selectGroupOrganicity` 케이스(exact/current/none·thin·verdict 경계) 추가. **Create** `frontend/tests/components/breadthDepthQuadrant.test.ts`(또는 lib화한 순수 계산부 테스트) — 중앙값 분할·사분면 분류·null 제외. `frontend/tests/functions/api_market.test.ts` 불변(서버 미변경).

## 5. 테스트 전략

순수 계산부(사분면 분류·organicity collapse)는 lib 순수함수로 빼 단위테스트. SVG 렌더는 최소 스모크(점 개수·라벨). frontend `vitest` + `tsc` 그린, 기존 `organicity.test.ts` 드리프트 가드 유지.

## 6. 선행 조건 / 브랜치

- **선행**: PR #52(core_fan_estimate `/api/market` 노출) **main 머지** — 2D의 y축 의존. 세션 기확립 패턴("열린 PR 먼저 머지 후 진행")대로 #52 머지 후 main에서 분기.
- **브랜치**: `awareness-breadth-depth-view`.
- **배포 영향**: 프론트 전용(`frontend-deploy`). 신규 마이그레이션·워커 **없음**. organicity는 기존 `/api/debut-window/summary` 사용(추가 prod 작업 0).

## 7. 후속(본 스펙 밖, 이연)

검색량(share of search) 컬럼·가중 슬롯 + view 가중 하향(점수 이동·시계열 단절 → 산식 버전 태깅·백필 필요) — 자격증명(Naver DataLab) 복구 후. 별도 파생 `organic_awareness` 컬럼(옵션 B) — 욕구 있으면.
