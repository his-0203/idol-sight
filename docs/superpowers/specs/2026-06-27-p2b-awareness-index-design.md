# P2b — 인지도 지수 (Awareness Index) 설계서

> **기준일**: 2026-06-27 · **단계**: P2(실무 신규 지표)의 두 번째 sub-project · **범위**: 보유 신호 0비용, 카테고리별 분리 랭킹, 검색량은 후속 플러그인

## 0. 배경 & 범위 결정

사용자 요청 "버추얼 아이돌들의 인지도 순위"에 직접 답하는 지표. 정찰 결과 전용 인지도(awareness) 산식은 코드에 없고(Health Reach가 묻힌 대용), 검색량 같은 비자발 인지 신호도 미수집이다.

**검색량 소스 실현 가능성 확인**: 기존 naver 수집기는 **스크래핑**(scrapling)이라 Naver API 자격증명이 없고, DataLab/Trends/pytrends 흔적도 없다. 검색량을 쓰려면 (A)Naver DataLab API(앱 등록·자격증명 필요) 또는 (B)Google Trends 스크래퍼(취약)가 필요하다.

**사용자 결정(C)**: 지금은 **보유 신호(구독·조회·뉴스)로 0비용 인지도 랭킹을 출시**하고, 검색량(A/B)은 나중에 입력 하나로 끼워넣는다. 지수 구조는 동일하므로 즉시 "인지도 순위"를 제공하고 자격증명 준비 시 업그레이드.

## 1. 목표 / 비목표

**목표**: 추적 그룹의 인지도를 보유 신호로 산출해 **카테고리(K-POP/서브컬처)별로 분리 랭킹**한다. 신규 수집 0. 검색량 입력을 나중에 추가할 수 있는 구조.

**비목표**:
- 카테고리 통합(cross-category) 줄세우기 — 사용자 결정으로 **분리 유지**([[idol-sight-kpop-subculture-separation]]).
- 검색량 신규 수집(이번 범위 아님 — 자리만 비움).
- 가중치/임계 정밀 캘리브레이션(first-pass, 데이터 축적 후 보정).
- Health Score 대체 — 인지도는 Health와 **독립된 1차원 지표**(Health Reach 기둥과 입력은 겹치나 목적이 다름).

## 2. 데이터원 (전부 기존, 0비용)

`agg_summary`의 그룹별 **최신 스냅샷**:
- `yt_subscribers` (보유 청중 — 알고 구독한 사람)
- `yt_total_views` (누적 도달)
- `naver_total_news` (언론 노출 — 대중 인지 통로)

카테고리: `groups.group_model` → `_category_of`(corporate→kpop, segmentary/confederation→subculture). worker(`weekly_diagnosis_signals._category_of`)·frontend(`MarketOverview.categoryOf`) 양쪽 기존 함수 재사용.

## 3. 산식

### 3.1 정규화 & 점수
각 신호를 **카테고리 리더 대비**로 정규화:
- `signal_n = log1p(value) / log1p(category_max)` (해당 카테고리 내 그 신호의 최댓값 기준). `category_max ≤ 0`이면 `signal_n = 0`. value NULL/음수 → 0.
- `log1p`: 자릿수 차이(PLAVE 수백만 vs 소형 그룹) 압축 + 영문 표기 비대칭(SKINZ 등 영문 brand가 한글 표기 그룹 대비 naver hit 낮음) 일부 완화.
- **리더 대비 정규화 채택 이유**: min-max는 카테고리 최하위를 강제로 0으로 만든다(SOV의 "최하위 0%" 문제). 리더 대비는 리더=신호별 1.0, 나머지는 상대값 → 실측 보유 청중이 있는 그룹이 0으로 깔리지 않음.

`awareness_score = round((0.5·sub_n + 0.35·view_n + 0.15·news_n) · 100, 1)` (0~100).

**가중치 (first-pass, 보정 가능)**: 구독 0.5(보유 청중=현 인지도 최강 신호) / 조회 0.35(도달) / 뉴스 0.15(언론, 표기 비대칭 편향 고려해 낮춤). 합 1.0. 검색량 추가 시 재배분(예: 검색 0.3 신설하고 나머지 0.7로 비례 축소) — 구현 시 가중치는 모듈 상단 상수로.

### 3.2 순위
`category_rank` = 카테고리 내 `awareness_score` 내림차순 순위(1=최고). 동점은 `yt_subscribers` 내림차순 tiebreak. **K-POP/서브컬처 각각 별도 순위.**

### 3.3 데뷔 전 포함
Health Score와 달리 **데뷔 전 그룹도 포함**한다(데뷔 전에도 구독·조회로 인지도가 존재 — 인지도가 Health보다 넓게 적용되는 차별점). `debut_date` 게이트 없음.

## 4. 저장 스키마 (migration 신규)

**`agg_awareness`** — 그룹·스냅샷별 1행, `(group_key, snapshot_at)` PK:
`group_key TEXT, snapshot_at TEXT, category TEXT, awareness_score REAL, category_rank INTEGER, sub_n REAL, view_n REAL, news_n REAL, basis TEXT NOT NULL, generated_at TEXT NOT NULL`.
- `basis`: 신호 데이터 있음 → `scored`; agg_summary 행은 있으나 세 신호 전부 NULL/0 → `insufficient`(점수 None, 랭킹 제외).
- 시계열 가능(스냅샷별). 인덱스 `idx_aw_snapshot (snapshot_at)`.

## 5. 산정 모듈 & basis & 파이프라인

`worker/src/idol_sight/analysis/awareness.py` (loyalty/live_activity 패턴 미러):
- `compute_awareness(groups: list[dict]) -> list[dict]` — 순수: 그룹별 최신 신호 + category를 받아 카테고리별 정규화·점수·순위 산출. (테스트 용이.)
- `build_awareness(client, *, snapshot_at) -> CollectionResult` — D1: 그룹별 최신 agg_summary + group_model 조회 → compute → **스냅샷별 멱등 쓰기**(`DELETE FROM agg_awareness WHERE snapshot_at=?` 후 INSERT, 또는 `(group_key,snapshot_at)` ON CONFLICT upsert — health_scores/market_share가 D1에 쓰는 기존 방식을 따른다). 과거 스냅샷은 보존(시계열).
- 데뷔 전 포함, 신호 없는 그룹 insufficient.

**파이프라인 편입**: `_run_aggregate`(cli.py)에서 agg_summary 산정 **직후**(awareness는 agg_summary 파생) health_scores·market_share 옆에 `build_awareness` 추가. 별도 워크플로 불필요(일일 aggregate에 포함). 부분쓰기 가드(`statements_executed != statements_sent`) 동일 패턴.

## 6. 노출 (frontend)

- MarketOverview에 데이터를 공급하는 엔드포인트(그룹 entries에 health_score·sov 포함하는 곳) 확장 → `awareness: { score, category_rank }` 포함.
- `frontend/src/views/MarketOverview.tsx`: 이미 카테고리별 섹션 + grade→total→SOV 정렬. **인지도 점수·카테고리 순위를 각 그룹 카드에 표시**하고, 인지도 기준 정렬 옵션 추가(또는 인지도 순위 배지). 검색량 자리(향후)는 비워둠. 카피 평이("인지도 = 얼마나 알려졌나 — 구독·조회·언론 종합").
- basis=insufficient 그룹은 '—'/순위 제외.

## 7. 테스트

`worker/tests/unit/test_awareness.py`:
- `compute_awareness` 순수: 카테고리 리더 대비 정규화(리더=각 신호 1.0), 가중합 점수, 카테고리별 순위(동점 subscribers tiebreak), 카테고리 분리(K-POP/서브컬처 순위 독립), log1p, category_max=0 가드, NULL 신호 0 처리, 데뷔 전 포함, insufficient.
- `build_awareness` D1(_FakeClient): statements shape, 멱등(rebuild 시 동일), full DELETE 선두.
- migration: `agg_awareness` 테이블·컬럼·PK(_apply_all 미러).
프런트: 엔드포인트 응답에 awareness 포함 + MarketOverview 렌더(가능 범위) + tsc.

## 8. 후속 (비목표 기록)

- **검색량 플러그인**: Naver DataLab API(앱 등록) 또는 Google Trends → `search_n` 입력 추가, 가중치 재배분. 지수 구조는 동일.
- 가중치/log1p 캘리브레이션(실측 분포 기반).
- 인지도 시계열 추이 카드(스냅샷 누적 활용).
