# 미개선 뷰 UX/UI 개선 계획 (그룹 상세·주간/인사이트·MiiWAN 심층)

> **기준일**: 2026-06-28 · **출처**: 4-에이전트 병렬 감사 + opus 종합(Workflow `wmcvhurub`). 재설계 디자인 시스템(사이드바 IA·GroupTabs master-detail·MarketOverview 표·토큰) 위에 쌓는 개선. 이미 배포된 것은 재제안 안 함.

## 교차 테마(≥2 뷰 반복)
1. **인사이트 렌더 중복** — 같은 카드 마크업 복붙(WeeklyUpdate≡Insights), TYPE_LABEL 2중 정의, 개요·MiiWAN에도 풀 카드 재렌더(총 4곳). → (i) `InsightCard` 단일 추출 (ii) 뷰별로 풀카드 vs "건수+링크 칩" 결정.
2. **다른 뷰 내용 재진술** — 개요 controversy 2회(GroupSignals+AlertSection), 개요 인사이트 재렌더, MarketAnalysis 헤드라인↔ActionQueue, GoodsBoard 제목 중복. → 요약+링크, 디테일 재렌더 금지.
3. **MiiWAN 자사색 #75d7d1 비일관** — movers amber, 자사 인사이트가 경쟁사처럼, Insights 자사 우선순위 없음, 브리핑 모드토글 비강조. → 자사 정체성 영역엔 own 토큰.
4. **overview-first/progressive disclosure 미흡** — 개요 14 평평 섹션, MiiWAN 고아 섹션·7탭, MarketAnalysis 도움말 기본열림·드릴다운 중간이탈. → lookup/reference는 `상세 ▾`로 접고 결정 데이터 위로.
5. **"so what" 판정 부재** — Members raw 수치, WeeklyUpdate 카드갤러리(lede 없음), GroupGrowth 무방향. `ContentFormatMatrix "권고:"` 박스가 복제할 패턴.
6. **section 라벨 + 미사용 토큰** — `text-label`/`text-body` 정의만 됨 → 헤딩/칩 추가 시 적극 사용.
7. **공유 서브컴포넌트** — Community `SENTIMENT_BADGE`를 PRRisk 뉴스에 재사용.
8. **고위험 데이터플로우(별도 트랙)** — 3중 `api.group()`, WeeklyUpdate 병렬 인사이트 페이로드.

## 실행 분류

### ✅ 지금 안전(디자인 결정 불필요) — Phase 1+2 → **구현 중**(Workflow `w9h5vv552`)
- **Phase 1 토큰·라벨 위생**: WeeklyUpdate movers amber→자사색·주간범위 카드→부제 · MiiWAN 미세(탭 hero 이동·5요소 ✓배지·CompetitorOrganicity 제목) · MarketAnalysis 미세(showHelp 기본닫힘·GoodsBoard 중복제목 제거·섹션주석 정정) · GroupGrowth 방향 라벨
- **Phase 2 판정·공유**: Members 판정박스 · PRRisk 뉴스 sentiment 배지+필터(SENTIMENT_BADGE lib 추출) · GroupContent CombinedToggle→KPI 헤더 세그먼트 · MiiWAN HealthCard 약점 3축

### 🟡 디자인 결정/눈/프로토타입 필요 — 사용자와 함께
- 개요 GroupAlertSection/GroupInsightSection 제거 + `상세 분석 ▾` 접기(무엇을 위로 둘지 확인)
- Insights 자사-우선 정렬 + 범위필터 정리(연대순 기대 깨질 수 있음)
- WeeklyUpdate "이번 주 주목 액션" lede(편집 보이스·"우선" 정의)
- MarketAnalysis CountryDrilldown 배치(레이아웃 스케치)
- MiiWANBriefing 고아 섹션 CONTEXT 슬롯·7탭 코호트 그룹화(IA 판단)
- **InsightCard 추출(#9)** — 4곳 dedup의 다리(순수 추출, 무동작변경)이지만 이후 칩-vs-카드 결정과 묶임
- GoodsBoard를 MarketAnalysis→MiiWANBriefing로 이관(파일 소유권)

### 🔴 이연(고위험 인프라·별도 추적)
- GroupTabs 자식 간 단일 group-data 컨텍스트/스토어 → 3중 `api.group()` 제거 (high/L)
- WeeklyUpdate 인사이트를 `api.insights(weekStart)`로 이관 + `api.weekly()` 병렬 페이로드 제거 (백엔드 협조, source_refs_json↔source_refs 불일치의 근본 홈)

## 권장 순서
Phase 1 → Phase 2(저위험 PR) → Phase 3 항목을 사용자와 1건씩 검토 → 🔴 데이터플로우는 별도 추적.
