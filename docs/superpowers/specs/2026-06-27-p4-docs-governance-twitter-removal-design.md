# P4 — 문서·정합성 동기화 + Twitter 물리삭제 + 거버넌스 설계서

> **기준일**: 2026-06-27 · **단계**: 마지막(P4) · **성격**: 문서 동기화(safe) + Twitter 완전 물리삭제(**파괴적, 사용자 승인됨**) + velocity 플래그(additive) + 거버넌스 골격. 점수/산식 불변.

## 0. 배경 & 범위

P1~P2c 머지 후(main `009dbf0`) 남은 정합성·위생 작업. 사용자 결정: **Twitter 완전 물리 삭제(DROP TABLE/COLUMN 포함, 비가역)** — 현재 twitter_posts는 dead(P1서 산식 제거). 거버넌스 콘텐츠(R&R·보존기간 실제 값)는 골격만, 값은 운영팀이 나중에.

스코핑 카탈로그(file:line·조치): 스크래치 `p4_agent_0.md`(docs) / `p4_agent_1.md`(twitter) / `p4_agent_2.md`(velocity·HealthSpec·governance).

## 1. 목표 / 비목표

**목표**: (A) 산식 레퍼런스·metric-dictionary를 현행 코드(P1~P2c)와 동기화 + in-code docstring drift 수정. (B) Twitter를 수집기·테이블·컬럼·프론트 UI까지 완전 제거. (C) velocity 신뢰플래그 컬럼 추가(P2a 후속). (D) 거버넌스 런북 골격(retention·R&R·캘리브레이션 로그)·문서 오기 수정.

**비목표**: 점수/산식/임계값 변경. 거버넌스 실제 값 입력(골격만). HealthSpec 서버 잔여필드 제거(weights/bonus_max/denom — 무해, 선택 후속). CLI 모놀리식 분해·Challenge Scan 테스트(코드건강, 별도).

## 2. Twitter 완전 물리삭제 — 단계 순서 (소비자 선정리 후 DROP)

**반드시 이 순서**(DROP 전에 모든 소비자 제거 — 안 그러면 런타임 깨짐):

1. **수집기·등록·스케줄 (safe)**: `collectors/twitter.py` 삭제, cli ALL_SOURCES/import 제거(cli.py:23,35,53,64,69), orchestrator.py:16, `test_twitter.py` 삭제, `.github/workflows/collect-6h|hourly|daily.yml`에서 twitter 스텝 제거.
2. **RAW 소비자 (twitter_posts 직접 SELECT)**: agg_summary.py:104-109(twitter COUNT 집계 블록 제거 — controversy는 이미 community), frontend `group/[key].ts:124-127,307`(SELECT·응답), `PRRisk.tsx:48,83,256-277`(트위터 리스트 UI 제거).
3. **파생 소비자 (agg_summary.twitter_posts 컬럼 read)**: dead-read부터 — cli.py:1335 SELECT·:1368 'twitter' 키, growth_trajectory.py:423(점수영향 0). 이어서 프론트 live — group/[key].ts:85, miiwan.ts:238, market.ts:138,143, debut-curve.ts:32, PRRisk.tsx:166-168, MiiWANBriefing.tsx:46,333,541-543,626(트위터 멘션 KPI 제거), Tooltip.tsx:149, DebutCurve.tsx:99, GroupContent.tsx:613.
4. **DROP TABLE** `twitter_posts`: 신규 `migrations/0098_drop_twitter_posts.sql`(`DROP TABLE IF EXISTS twitter_posts;`) + `test_schema.py:25` expected에서 제거. (파괴적·비가역; 테이블 dead라 손실 없음.)
5. **DROP COLUMN** `agg_summary.twitter_posts`: 신규 `migrations/0099_agg_summary_drop_twitter.sql`. **D1 DROP COLUMN 지원 확인**(SQLite 3.35+ — 미지원 시 table-rebuild 마이그레이션). 동반: agg_summary.py _UPSERT(:43,:56)·바인딩(:219)·counts dict(:74)에서 twitter 제거, yt_history_backfill.py:62, test_agg_summary.py:208-229, scripts/historical_backfill/*(csv_to_migration·socialblade·naver_api·bigkinds — INSERT 항목 제거).
6. **고아 정리 (선택·후순위)**: config.twitter_handles(:70)·cli 로딩(:197,230). groups.twitter_handles 컬럼 DROP은 보류(무해).

**검증**: 각 단계 후 worker(`uv run python -m pytest tests/unit`)·frontend(`npx vitest run`+`tsc`) 그린. DROP 마이그레이션은 `_apply_all` 체인 + test_schema로 검증. 점수/표시 회귀 0(twitter는 이미 dead).

## 3. 문서 동기화 (safe)

`docs/analysis-formulas-reference.md`:
- 헤더 기준일/버전 현행화.
- §2 SOV: 신호 5종→4종, SOV_WEIGHTS 0.33/0.28/0.22/0.17, momentum 'subscribers만', 'z-score 혼합'→'percentile-rank만'(z는 weekly market_share_z만).
- §5.1 controversy_count: community_posts sentiment='controversy' 14d 윈도(누적 아님, CONTROVERSY_WINDOW_DAYS=14), twitter_posts는 (삭제되므로 표에서 제거).
- §1.3 ritual: music_show_wins 코호트-dead 조건부 재분배 단서.
- §5.2 velocity: +24h bracket 선형보간(_interpolate_v24, 한쪽만→raw 폴백).
- §9.2 _is_lit: 서브컬처 category_z 제외 / §9.3 controversy_spike: twitter_z 삭제(3축).
- **신규 §**: live_activity(P2a)·awareness(P2b) 섹션 추가(상수·산식·basis). 삽입은 §8 인근, 번호 충돌 피하려 §8.x 하위 또는 말미 부록 — **부록 append로 기존 번호 보존**(TOC에 링크 추가).
- 변경 섹션의 인용 라인만 동기화(전수 재-cite는 과투자).

`docs/metric-dictionary.md`: fan_loyalty·live_activity·awareness 행 추가, SOV 가중치·controversy 정의 갱신.

**in-code docstring drift**: health_score.py 'p90'→p75, debut_window _compute_balance_score 'shorts 20-150'→15-78, build_video_organicity 'Pre/Post buckets'(Post 폐기 반영). (market_share/video_velocity docstring은 이미 정확.)

## 4. velocity 신뢰플래그 (additive, safe)

`migrations/0098`... → 번호 충돌 회피: velocity는 Twitter DROP과 번호 겹치지 않게 **0098=velocity_interpolated**(additive 먼저), **0099=drop_twitter_posts**, **0100=agg_summary_drop_twitter**로 배정.
`ALTER TABLE youtube_videos ADD COLUMN view_count_24h_interpolated INTEGER;` + `video_velocity.py`가 `_interpolate_v24`의 interpolated bool을 저장하도록 배선(현재 계산만 하고 미저장). 프론트 노출은 후속(선택).

## 5. 거버넌스 (문서·골격)

`docs/governance-runbook.md`:
- access_log: '인덱스 없음' 오기 정정(created_at·client_id 인덱스는 0079에 존재). retention 권고 유지(기간은 미확정 — 골격).
- **위기 R&R 표 골격**: [알림유형(identity_leak/model_theft/controversy_spike) × 1차 triage × 에스컬레이션 채널 × 법무·PR 컨택 × 데뷔일 on-call] — 값은 운영팀 입력 대기.
- **캘리브레이션 출처 기록 규칙**: REF/임계/가중치 변경 시 [상수·이전→새값·근거 데이터·결정자·날짜] append 규칙 + 최초 현행값 1회 기록.
- (선택) access_log 90일 retention 자동화 워크플로 골격(기간·주기 미확정이라 주석 골격만).

## 6. 마이그레이션 번호

0096(P2a)·0097(P2b) 머지됨 → **0098 velocity_interpolated(additive) · 0099 drop_twitter_posts · 0100 agg_summary drop twitter column.** 순서: velocity(additive, 무관) 먼저 또는 독립; Twitter DROP 둘은 소비자 정리 완료 후.

## 7. 테스트/롤아웃

- 단계별 그린 유지. Twitter 제거는 소비자→DROP 순서 엄수(역순 시 런타임/마이그레이션 실패).
- DROP COLUMN: D1 지원 확인, 미지원 시 table-rebuild(create new·copy·drop·rename).
- 점수/산식 불변(Twitter는 이미 dead, docs는 문서, velocity 플래그는 additive). 거버넌스는 문서.
