# P2c + P3 — SOV 개념 정리 + 안내문구·LLM 프롬프트 정비 설계서

> **기준일**: 2026-06-27 · **단계**: P2c(SOV/시장점유 표기) + P3(안내문구·LLM 프롬프트) 번들 · **성격**: 표시·문구 정비(점수/산식 불변), 일부 정합성(stale 가중치·재소싱 후 라벨) 수정 포함

## 0. 배경 & 범위

머지된 main(P1·P2a·P2b 반영) 기준 카피 감사 결과 **잔여 27건**(프론트 20 + 프롬프트/문서 7). 이미 처리된 항목(GroupContent 전략 인사이트 humanize, LLM 표준명 로스터)은 제외. 카탈로그 전문: 작업 스크래치 `p2c_p3_catalog.md`(file:line·현재·제안 포함).

핵심 갈래: (P2c) SOV가 영문/'점유율' 혼재 + '시장점유율' 오인 + **stale 가중치 힌트**(P1서 Twitter 제거됨). (P3) HealthSpec 버전스탬프·개발 체인지로그·유령 토글, 영문 일색 컴포넌트, 인류학 용어, 재소싱(controversy=community) 후 남은 '트위터' 라벨, 낡은 주석.

## 1. 목표 / 비목표

**목표**: 운영자/LLM 노출 문구를 평이 한국어로 통일하고, P1 변경(Twitter 제거·controversy 재소싱)과 어긋난 stale 문구·가중치를 정합화. 점수/산식/데이터는 불변(표시 레이어만; 단 controversy 표시의 데이터 바인딩이 여전히 twitter_posts를 가리키면 소스 정합 위해 최소 수정).

**비목표**: 산식/임계값 변경. docs 전면 동기화(P4 — 단 SOV 개념 표기는 본 단계). 검색량 등 신규 기능. 카탈로그 low-severity 미세 다듬기 중 의미 없는 것은 생략(YAGNI).

## 2. 확정 용어 (사용자 위임 — 일관 적용)

- **SOV** → "**관심 점유율 (Share of Voice)**" (제목·축·본문·빈상태 통일). '시장점유율' 오인 방지 위해 '관심/발언 점유'임을 라벨에 명시. 인지도(P2b)와의 차이 1줄 병기("인지도=절대 인지(카테고리 순위) / 관심 점유율=그룹 간 상대 비중").
- **SOV 가중치 힌트(정합성)**: P1 반영 → "유튜브 조회 33% / 커뮤니티 28% / 뉴스 22% / 구독자 17%" (**트위터 제거**). worker `SOV_WEIGHTS` 실제 값과 일치시킬 것.
- **4지표**: 한국어 선행 — 도달(Reach) / 의례적 승리(Ritual) / 동원(Mobilization) / 친밀도(Intimacy).
- **그룹모델**: 기업형(K-pop 정통) / 분절형(왁타버스 위성) / 연합형(V-tuber 우산) (GroupContent 기존 글로스와 통일).
- **organicity** → "진정성(오가닉) 점수".
- **controversy 표시** → "논란 신호"(출처 '트윗' 단정 제거; 소스는 community). 프롬프트 예시의 '트윗'→'글', '트위터 controversy'→'커뮤니티 논란'.
- **버전 스탬프**(V2.18·v2.21 등) 카피에서 제거. **개발 체인지로그·Legacy 6-component 토글** 제거(또는 개발자 전용 숨김).

## 3. 작업 단위 (파일-영역별, SDD task)

1. **MarketOverview.tsx (P2c)** — SOV 제목/축/본문/빈상태 "관심 점유율" 통일 + 가중치 힌트 정합(트위터 제거, 33/28/22/17) + 인지도↔SOV 차이 1줄 + '검색량은 추후' 정리.
2. **HealthSpec.tsx** — 버전스탬프 제거, 개발 체인지로그 박스 제거/접기, Legacy 6-component 토글 제거, 4지표·그룹모델 한국어 선행, 잔여 영문(Factor/Grade/input weights) 한국어화.
3. **CompetitorOrganicityBar.tsx** — 제목·구간·점수모드·로딩 한국어화, organicity→진정성(오가닉) 점수.
4. **GroupContent.tsx** — 'Debut Window Video Organicity'→'데뷔 구간 영상 진정성'(+버전 제거), 신호명 한국어('급상승/논란/역주행/취약 지표'), 'Controversy 트윗'→'논란 신호' (+controversy 데이터 바인딩이 twitter_posts면 controversy_count 소스로 점검).
5. **잡 UI 카피** — Tooltip.tsx(cohort p75/engagement_rate 풀어쓰기), MiiWANBriefing.tsx(ai_comment 낡은 주석·트위터 멘션 controversy 힌트 분리·Risk Watch 한국어), SystemStatus.tsx(리포 경로→앱 내 안내), FanActivityCard.tsx(선택적 '코어' 다듬기).
6. **prompts.py (P3)** — controversy 예시 '트윗'→'글'(:95,:96), 멤버 reveal '트위터'→'공식 SNS'(:103), diagnosis GOOD 예시 '트위터 논란'→'커뮤니티 논란'(:376), cross-ref 치트시트 '트위터 controversy/일반'→'커뮤니티 논란/일반'(:475), '조회 SOV'→'공개 조회 점유'(:623). **few-shot 의미 보존 최소 수정**. test_prompts.py 통과 유지.
7. **docs/metric-dictionary.md (P2c)** — SOV 정의에 '발언/관심 점유' 한국어 표기 + 시장점유율과 구분 명시(개념 표기만; 전면 동기화는 P4).

## 4. 검증

- frontend: 각 task 후 `npx tsc -b --noEmit` clean + 관련 `npx vitest run` (라벨 변경이 테스트 단언을 깨면 갱신). HealthSpec Legacy 토글 제거 시 관련 테스트·import 정리.
- worker: prompts.py 변경 후 `uv run python -m pytest tests/unit/test_prompts.py -q`(표준명/포맷 단언) + 영향 테스트 통과.
- 데이터 바인딩 점검(GroupContent/MiiWANBriefing controversy): twitter_posts 직접 참조면 controversy_count(community)로 정합 — 단 표시 동작 보존.
- 전 구간 점수/산식 불변(표시만).

## 5. 후속

- low-severity 미세 다듬기(FanActivityCard 코어 등)는 선택. P4에서 docs 전면 동기화(analysis-formulas-reference V2.52, 인용 라인). 검색량 인지도 플러그인은 P2b 후속.
