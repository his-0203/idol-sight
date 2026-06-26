# P1 — 산식 정확도 버그·구조 수정 설계서

> **기준일**: 2026-06-27 · **단계**: 4단계 개선 프로그램 중 P1 · **접근법**: A(표적 수정 — 명백한 로직·구조 결함만, "보정 예정" 임계값 재튜닝은 별도 단계)

## 0. 배경

idol-sight 전 영역(산식·실무 지표·안내문구·문서)을 병렬 정찰한 결과, 점수 산식에 **재캘리브레이션이 아니라 명백한 로직·구조 결함**으로 분류되는 항목들이 확인됐다(전부 실제 `파일:라인` 코드로 재검증). 이 문서는 그중 P1 범위 — 즉시 고칠 수 있고 기존 점수의 신뢰를 회복하며, 후속 단계(P2 실무 신규 지표)가 올라설 토대가 되는 수정 — 만 다룬다.

**4단계 로드맵 (컨텍스트)**

| 단계 | 내용 |
|---|---|
| **P1 (이 문서)** | 산식 정확도 버그·구조 수정 |
| P2 | 실무 신규 지표 — 찐팬 활동량(라이브 채팅 author 집계)·인지도 지수·SOV/시장점유 재정의 |
| P3 | 안내문구 정비 + LLM 프롬프트 로스터 |
| P4 | 문서·정합성 동기화 + 거버넌스 |

## 1. 목표 / 비목표

**목표**
- 점수를 왜곡하는 로직·구조 결함을 표적 수정하고, 각 수정에 회귀 테스트를 붙인다.
- Twitter를 산식에서 완전히 제거한다(수집 불가 확정).
- Twitter 제거로 드러난 논란/위기 감지 단절을 살아있는 소스(커뮤니티 sentiment)로 복구한다.
- 값을 바꾸지 않는 즉시 UI 표시 버그 2건을 함께 처리한다.

**비목표 (명시적 제외)**
- "보정 예정" 임계값 재적합(loyalty 앵커, organicity ER/balance 경계) → **B 단계로 이연**. 로직 수정과 섞으면 점수 변화 원인 추적이 불가능해진다.
- P1 확장(아래 §7)으로 분류된 medium 항목.
- Twitter 수집기/DB 컬럼의 물리적 삭제 — 산식 제외만 한다(컬럼 정리는 P4).

## 2. 핵심 설계 결정 (확정)

1. **접근법 A** — 표적 로직·구조 수정만. 재캘리브레이션 분리.
2. **점수 변동 수용** — SOV·ritual·velocity·controversy 재소싱으로 일부 그룹 점수가 이동하며, 이는 *의도된 교정*이다. 회귀 테스트에 "교정 전/후" 값을 픽스처로 박아 의도성을 문서화한다.
3. **K-POP/서브컬처 분리 유지** — 서브컬처 코호트 결함은 카테고리 **병합으로 풀지 않는다**.
4. **Twitter 산식 제외** — SOV 가중치·진단 축에서 제거.
5. **논란 감지는 커뮤니티 sentiment로 재소싱** — 위기 알림은 거버넌스 민감(오탐 시 Streisand) 영역이므로 인간검증 전제는 유지.

## 3. 수정 항목

각 항목: 파일 · 현재 동작 · 목표 동작 · 점수 영향 · 수용 기준(테스트).

### 3.1 SOV 정규화 버그 🔴 ⚠️점수영향
- **파일**: `worker/src/idol_sight/analysis/market_share.py:49,76,120-167`
- **현재**: 코호트 전체가 동일값/0인 신호(모멘텀의 subscribers·twitter `[0.0]*n`, 또는 미수집 신호)에 `_percentile_rank`가 tie 평균으로 **전원 0.5**를 부여. `_compose_score`가 이를 가중합해 균일 상수(예: 모멘텀에 0.125)를 주입 → 분포를 균등 쪽으로 압축, 진짜 격차를 평탄화.
- **목표**: "전부 동일값(또는 전부 0)인 신호는 기여 0"으로 처리하고, `_compose_score`가 **가용 신호로 가중치를 재정규화**. 신호를 빼려던 본래 의도대로 동작.
- **수용 기준**: (1) 모멘텀 subscribers/twitter가 결과에 어떤 상수도 주입하지 않음. (2) 한 신호만 코호트 전체 0일 때 나머지 신호 분포가 보존됨(균등화되지 않음). (3) 기존 정상 코호트 케이스의 상대 순위는 보존.

### 3.2 RitualVictory 0.8 천장 🔴 ⚠️점수영향
- **파일**: `worker/src/idol_sight/analysis/health_score.py:581-587` (`_wmean(..., redistribute=False)`)
- **현재**: 음방 confirmed가 **코호트 전체에 없으면** `music_show_n`(weight 0.20)이 분모에만 남아 corporate 그룹 ritual이 0.80에서 막힘 → PLAVE류 total ~6% 만성 과소.
- **핵심 구분**: `redistribute=False`의 본래 의도(hanteo/chart **부재 = 진짜 실패** → 페널티 유지)는 옳다. 그러나 **music_show가 코호트 전체에서 죽은 것**(음방 데이터 자체가 없음)은 "이 그룹이 1위 못 함"과 다르다 → music_show만 재분배해야 한다.
- **목표**: hanteo·news·chart_peak·chart_depth는 `redistribute=False` 유지, **`music_show_wins`만 코호트-dead일 때 재분배**(가중치를 나머지로 흡수, 페널티 0). 구현 방식(per-part 플래그 vs 분리 계산)은 구현 계획에서 결정.
- **수용 기준**: 음방 데이터가 코호트 전체에 없을 때, hanteo/chart 만점 그룹의 ritual이 1.0에 도달 가능. hanteo 부재 그룹은 여전히 페널티 받음(회귀 테스트로 두 케이스 고정).

### 3.3 서브컬처 진단 복원 (옵션 b) 🔴
- **파일**: `worker/src/idol_sight/analysis/weekly_diagnosis_signals.py:399` (`CATEGORY_COHORT_MIN=3`), `_is_lit` 경로
- **현재**: 서브컬처 코호트(2그룹)가 최소표본 3 미달 → `category_z` 상시 0 → 11개 가설의 cross-sectional 점등 축이 죽어 진단이 사실상 K-POP에만 작동.
- **목표 (카테고리 분리 유지)**: 서브컬처는 `category_z`를 **점등 필수 조건에서 제외**하고 `temporal_z`+`wow_pct`로 점등하도록 `_is_lit` 임계를 **카테고리별로 분기**. 표본 2개 z의 노이즈에 의존하지 않음. (카테고리 병합 폴백은 채택하지 않음.)
- **수용 기준**: 서브컬처 그룹이 temporal/wow 신호만으로 organic_growth 등 가설을 점등할 수 있음. K-POP 코호트 동작은 불변(회귀 테스트).

### 3.4 video_velocity 보간 🔴 ⚠️점수영향
- **파일**: `worker/src/idol_sight/analysis/video_velocity.py:12-18(docstring),67-78`
- **현재**: docstring은 "+24h에 가장 가까운 행을 골라 보간"이라 하지만, 실제론 ±18h 내 **최근접 단일행 raw views**를 그대로 24h값으로 사용(보간 없음). 스냅샷 타이밍(T+6h~T+42h)에 따라 속도가 과소/과대 → reactivity·organicity로 전파.
- **목표**: +24h 전후 두 스냅샷을 **시간 선형보간**해 24h 추정. 한쪽만 있으면 그 값 사용 + **신뢰도 강등 플래그**. docstring을 실제 동작과 일치시킴.
- **수용 기준**: 동일 영상이 T+6h/T+42h 스냅샷만 있어도 보간으로 안정적 v24 산출. 보간 불가(한쪽만) 케이스가 플래그로 구분됨. 회귀 테스트로 보간 전/후 ratio 차이 고정.

### 3.5 Twitter 산식 제거 🔴 ⚠️점수영향
- **파일**: `market_share.py:39-45,130,142` · `weekly_diagnosis.py:381-384,570-574,742-747,870-872` · `weekly_diagnosis_signals.py:370-385(twitter_controversy_z)`
- **현재**: Twitter가 (1) SOV 신호(가중치 0.10)와 (2) 진단 `twitter_z` 축(controversy_spike)에 들어감. 수집 불가로 이미 빈 신호.
- **목표**:
  - **SOV**: `SOV_WEIGHTS`에서 `twitter` 제거, 0.10을 나머지 4신호로 **비례 재분배** → yt 0.33 / community 0.28 / news 0.22 / subscribers 0.17 (합 1.0, assert 유지). cum/mom 신호 dict에서 twitter 행 제거.
  - **진단**: `twitter_z` 축(`twitter_controversy_z`)과 관련 쿼리·코호트 빌드 제거. controversy_spike는 §3.6의 재소싱된 `controversy_count_z` + community 신호로 점등.
- **수용 기준**: 산식·진단 어디에도 twitter 입력 없음. SOV 가중치 합=1.0. 기존 SOV 테스트가 새 가중치로 갱신됨.

### 3.6 논란 감지 재소싱 (커뮤니티 sentiment) 🔴 ⚠️동작영향
- **파일**: `worker/src/idol_sight/analysis/agg_summary.py:87-95` (controversy_count 출처) · 소비자: `health_score.py:448,665` (`_controversy_factor`), `weekly_diagnosis.py:371` (`controversy_count_z`), `alerts/__init__.py:186-218` (위기 알림)
- **현재**: `controversy_count`가 **`twitter_posts`(type='controversy')에서만** 나옴 → Twitter 사망으로 위험 배수·위기 알림·진단이 사실상 꺼짐. 한편 `sentiment.py`는 community_posts를 `'controversy'`로 LLM 분류 중(살아있는 소스)이나 `negative_ratio`로만 흐름.
- **목표**: `agg_summary`의 `controversy_count` 출처를 **`community_posts WHERE sentiment='controversy'`로 교체**. 단일 교체 지점에서 세 소비자(위험배수·진단·알림)가 자동으로 살아있는 데이터를 받음.
- **윈도우 주의 (중요)**: `_controversy_factor = max(0, 1 - count/10)`는 raw count 기반이라, community sentiment를 **누적**으로 세면 시간이 지나며 count가 무한 증가 → Health가 영구 0으로 붕괴. 따라서 controversy_count는 **최근 윈도우(예: 7~14일 posted_at 기준)** 카운트로 산출한다(누적 아님).
- **임계 sanity (B 경계 주의)**: `_controversy_factor`의 `/10`과 위기 알림의 `≥5건 & ≥2×`는 twitter 볼륨 기준으로 잡힌 값이다. community 볼륨이 크게 다르면 분모/floor가 어긋날 수 있으니 **재소싱 직후 실데이터로 1회 sanity 점검**하고, 필요한 최소 조정만 한다(광범위 재튜닝은 B). 변경 시 governance-runbook에 근거 기록.
- **수용 기준**: controversy_count가 community sentiment='controversy' 최근 윈도우에서 산출됨. 위험배수·controversy_spike 진단·위기 알림이 community 데이터로 동작(테스트). 위기 알림의 인간검증 전제 문구 유지.

### 3.7 즉시 UI 표시 버그 (값 불변) 🟢
- **humanize 누락** · `frontend/src/views/GroupContent.tsx:1150-1170`
  - 현재: '전략 인사이트' 섹션만 `humanizeInsightText`/`InsightBody`를 안 거쳐 LLM 원문(`**굵게**`·`WoW`·`z=2.3`·`organic_growth`)이 날것 노출.
  - 목표: 다른 인사이트 카드와 동일하게 `InsightBody(body)` + `humanizeInsightText(title)` 적용, type 칩 한국어화. (공통 카드 컴포넌트 추출은 P3에서.)
- **프롬프트 로스터 누락** · `worker/src/idol_sight/llm/prompts.py:8,184,681`
  - 현재: 표준 그룹명 표·scope enum이 8그룹뿐 — **WE GO-6·유아렐 누락** → 배지 매칭 실패·음차 환각.
  - 목표: 표준명 표·formatting 표·scope enum에 `wegosix`(WE GO-6/위고식스)·`uryael`(유아렐) 추가.
- **수용 기준**: 전략 인사이트가 다른 탭과 동일 가독성. WE GO-6/유아렐 언급 시 정확 표기로 배지 렌더.

### 3.8 낡은 주석 정정 🟢
- **파일**: `worker/src/idol_sight/analysis/health_score.py:149-150`
- **현재**: "dc/theqoo/instiz scrapers paused since V2.11" — 실제론 정상 작동(V2.28 기능 존재).
- **목표**: sparse-collector 방어 로직의 *목적*만 남기고 "paused" 단정 제거.

## 4. 테스트 전략

- 각 수정마다 **변경 전 동작을 고정하는 회귀 테스트 → 수정 → 의도한 차이만 검증**.
- 점수 이동 항목(3.1·3.2·3.4·3.5·3.6)은 "교정 전/후 값"을 픽스처로 명시해 *의도된 변화*임을 문서화.
- 대상 테스트 파일: `test_market_share.py`, `test_health_score.py`, `test_video_velocity.py`, `test_weekly_diagnosis*.py`, `test_agg_summary.py`, `test_alerts.py`, `test_sentiment.py` + 프론트 `insightFormat`/GroupContent 관련.
- worker↔frontend 경계 미러(예: alerts 상수)가 있으면 양쪽 핀 테스트 갱신.

## 5. 롤아웃 / 리스크

- **순서**: 3.1(SOV)·3.5(Twitter)·3.6(controversy 재소싱)은 상호 연관(SOV twitter 제거 ↔ 정규화 버그 ↔ controversy 소스)이라 묶어 처리. 3.2/3.3/3.4는 독립. 3.7/3.8은 무중단 선반영 가능.
- **리스크**: 위기 알림 재소싱은 거버넌스 민감 — community 볼륨 차이로 오탐 가능성. 완화: 윈도우 한정 + 재소싱 직후 sanity 점검 + 인간검증 전제 유지.
- **데이터 의존**: 3.6 윈도우/임계 sanity는 D1 실측 community controversy 분포 확인 필요(사용자가 `!`로 조회하거나 agg 조회).

## 6. 후속 — P1 확장 (다음 스펙, medium)

v90 mobilization/bonus 이중계상 · sentiment negative_ratio 윈도우 부재 · growth_trajectory 인덱스기반 lag(날짜기반으로) · platform_reactivity 단순평균→pooled ratio · 동적 REF를 hanteo/chart로 확장 · 진단 medium-confidence 사장 분기 · member_popularity 100 캡/이질 기준.

## 7. 횡단 트랙 (정찰 추가 발견 — P4/기회시 처리)

CLI 1591줄 모놀리식 분해 · Challenge Scan 테스트 부재 · access_log 무한증가(retention) · 위기 에스컬레이션 R&R 미정의 · classify_direction 과다 export · 마이그레이션 번호 gap 기록.
