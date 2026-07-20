# V2.53 — Organic Trust Layer 설계 (2026-07-20)

## 문제

BTHD(비더후드, 데뷔 전·잠정 앵커 2026-06-26)가 대시보드에서 과대평가된다 (2026-07-20 원격 D1 실측):

| 지표 | 현재값 | 문제 |
|---|---|---|
| 등급 | C (4.4) | 잠정 데뷔 앵커(mig 0093)가 `_is_pre_debut` 게이트를 우회 |
| 인지도 | 76.1 · kpop 3위 | 유료 의심 조회수·구독이 무할인 반영 |
| 추정 코어 | 218 / 18 | 팜 의심 좋아요·댓글이 median에 포함 |
| organicity | 22편 중 likely_paid 8 + suspect 5 (59%) | 판정 존재하나 세 점수에 미반영(직교 참고 신호) |

근본 원인: organicity(V2.21~V2.37, 5-tier verdict)가 등급·인지도·추정 코어 산식과 완전히 분리되어 있고, 데뷔 전 게이트가 "잠정 앵커" 상태를 표현하지 못함.

## 결정 (운영자 승인 2026-07-20)

1. **신뢰 할인 + 병기**: organicity 기반 신뢰 계수로 인지도·추정 코어를 할인한 보정값을 기본 표시·랭킹 기준으로 사용, 원값은 툴팁 병기.
2. **PRE 복원 + 잠정 앵커 구분**: 정식 데뷔 미확정 그룹은 등급을 PRE로 게이트. organicity·인지도 집계는 유지.
3. **사분면 차트는 원값 유지**: BreadthDepthQuadrant의 존재 이유가 "고인지·약코어=광고형" 탐지이므로 보정하지 않음 (운영자 확인).

## A. 신뢰 계수 `organic_confidence` (0~1, 그룹 레벨)

- 입력: `debut_window_video_organicity` 전 영상 verdict, `insufficient_data` 제외. n = 채점 영상 수.
- verdict 가중치: `organic_strong=1.0, organic=1.0, borderline=0.7, suspect=0.4, likely_paid=0.15`
- 영상 **count 기반 단순 평균** (V2.40 count-based 원칙 준수, 조회수 가중 금지):
  `mean = Σ weight(verdict_i) / n`
- thin-sample shrinkage (mig 0092 패턴 재사용): `conf = (n·mean + K·PRIOR) / (n + K)`, `PRIOR=0.75`, `K=3`
- **n=0 (organicity 데이터 없음) → conf=1.0 (무할인)**. 판정 근거 없이 감점하지 않는다 (정직 원칙). prior로 수렴시키지 않는 이유: prior 적용 시 organicity 미채점 그룹 전원이 25% 감점되는 부작용.
- 순수 함수로 구현 (`analysis/organic_confidence.py` 신규 모듈), awareness·core_fan_estimate 양쪽에서 import.
- BTHD 검산: mean=(3·1.0+6·0.7+5·0.4+8·0.15)/22≈0.472 → conf=(22·0.472+3·0.75)/25≈**0.505**

## B. 인지도 보정 (`analysis/awareness.py`)

- `awareness_score_adj = awareness_score × organic_confidence` (소수 1자리 반올림)
- **category_rank는 보정값 기준으로 재산정** → `category_rank_adj`. 기존 `awareness_score`/`category_rank`(원값 기준)는 그대로 유지 저장.
- 동점 tiebreak은 기존과 동일(subscribers).
- `basis` 의미 변경 없음. 세 신호 전부 0/NULL이면 기존대로 `insufficient`(보정값도 NULL).
- 스키마 (additive): `agg_awareness`에 `awareness_score_adj REAL`, `organic_confidence REAL`, `category_rank_adj INTEGER`
- BTHD 검산: 76.1 × 0.505 ≈ **38.4** → kpop 3위에서 중하위권으로 하락.

## C. 추정 코어 보정 (`analysis/core_fan_estimate.py`)

- median 계산 대상에서 verdict가 `suspect`/`likely_paid`인 영상 **제외**. `organic_strong/organic/borderline` + **organicity 미채점 영상은 포함** (채점 안 됐다고 버리지 않음).
- 필터 후 잔여 영상 < 3편(기존 `_MIN_WINDOW_VIDEOS`)이면 폴백(최신 12편)도 동일 필터 적용, 그래도 < 3편이면 `basis='insufficient_organic'` (est 값 NULL).
- 스키마 (additive): `agg_core_fan_estimate`에 `est_engaged_fans_adj INTEGER`, `est_active_core_adj INTEGER`, `organic_video_count INTEGER`. 기존 컬럼(원값)은 기존 로직 그대로 유지 저장.
- 조인 키: `youtube_videos.video_id` ↔ `debut_window_video_organicity.video_id` (최신 스냅샷 verdict).

## D. 등급 PRE 게이트 복원 (`analysis/health_score.py`)

- 스키마: `groups.debut_confirmed INTEGER NOT NULL DEFAULT 1` (additive). migration에서 `bthd=0` 설정.
- 게이트 확장: `debut_date IS NULL OR 미래 OR debut_confirmed=0` → `grade='PRE'`, `total=None` (기존 PRE 경로 재사용).
- **organicity·Debut Window·인지도·코어 집계는 debut_date를 그대로 사용** — mig 0093(잠정 앵커로 롤링 윈도우 산정)의 취지 보존. 등급만 게이트.
- 정식 데뷔 확정 시 해제 절차: `UPDATE groups SET debut_date='<확정일>', debut_confirmed=1 WHERE key='bthd';` + group_events confidence 갱신 (마이그레이션 1건).

## E. 프론트 표시

- **MarketOverview.tsx**:
  - 인지도 셀: `awareness_score_adj` + `#category_rank_adj` 기본 표시. adj가 NULL(미적용 DB/구 스냅샷)이면 원값 폴백. 툴팁: "원값 {raw} · 신뢰 계수 {conf} (유료 의심 영상 {pct}%)".
  - 추정 코어 셀: `est_engaged_fans_adj` 폴백 동일. `basis='insufficient_organic'`이면 '—' + 툴팁 "유료 의심 영상 제외 후 표본 부족".
  - 정렬 키: 인지도·코어 정렬은 보정값 기준 (폴백 값 포함).
  - 등급 셀: 변경 없음 (BTHD는 PRE 칩으로 복귀 — 기존 토큰 재사용).
  - HELP 문구에 신뢰 할인 설명 추가.
- **BreadthDepthQuadrant / breadthDepth.ts**: 원값 유지 (변경 없음). 설명문에 "인지도는 유료 의심 할인 전 원값" 한 줄 추가.
- **API (`functions/api/market.ts`)**: 신규 컬럼 조회는 별도 쿼리 `.catch(null)` 후 spread merge (mig 0095 graceful 패턴) — migration 미적용 D1에서 기존 응답 회귀 방지.
- **HealthSpec / `docs/analysis-formulas-reference.md`**: 신뢰 계수 산식·가중치·PRE 게이트 확장 반영.

## F. 마이그레이션·파이프라인·검증

- migration 3건 (전부 additive, graceful 규칙 준수):
  1. `0105_debut_confirmed.sql` — groups 컬럼 + bthd=0
  2. `0106_awareness_adj.sql` — agg_awareness 컬럼 3개
  3. `0107_core_fan_adj.sql` — agg_core_fan_estimate 컬럼 3개
  - (번호는 구현 시점 최신 migration 확인 후 확정)
- 워커 빌더는 컬럼 부재 시 죽지 않게 try/except (V2.52 `build_fan_loyalty` 패턴).
- 파이프라인 순서 변경 없음: organicity(2단계) → awareness(3) → core(4) → health(5) 순서가 이미 의존성 충족.
- TDD: 신규 순수 함수·필터·게이트 전부 단위 테스트. 기존 worker/frontend 전체 테스트 유지.
- 검산 fixture: BTHD 실측 분포(3/6/5/8)로 conf≈0.505, adj≈38.4 회귀 테스트.
- **원격 migration apply는 운영자 직접 실행** (기존 규칙). 적용 전까지 프론트는 원값 폴백으로 동작.
- frontend 커밋 subject는 ASCII-only (Cloudflare Pages 8000111).

## 구현 위임 (비용 최적화)

- 계획: Fable (본 세션). 구현: subagent-driven —
  - worker 산식·게이트·신규 모듈 (A~D): **opus**
  - 프론트 표시·API·migration SQL·문서 (E~F): **sonnet**

## Open questions

- 없음 (사분면 원값 유지·conf 가중치·prior는 운영자 승인 완료. 가중치 재보정은 운영 후 실측으로).
