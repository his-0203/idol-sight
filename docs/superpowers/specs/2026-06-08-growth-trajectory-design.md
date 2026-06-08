# 성장 궤적 레이어 (Growth Trajectory) — V2.43 Phase 1

날짜: 2026-06-08
범위: worker 분석 모듈 + 신규 table(migration) + API + 신규 그룹 탭 뷰. 모든 그룹.

## 배경 / 문제

현재 대시보드는 **상태(state) 진단**에 강하다 — organicity(콘텐츠가 진짜냐), 커뮤니티 건전성, 멤버 비중. 그러나 **"이 그룹이 건강하게 성장하는가, 어디가 부족한가"는 약하다.** 바이탈 패널은 "건강·안정"과 "건강하지만 정체/하락"을 구분하지 못한다 — 성장기 그룹엔 바로 그 구분이 전부다(예: 데뷔 그룹이 Health "B"로 8주 횡보 = 안정이 아니라 정체인데 전부 초록으로 보임). 이는 organicity 논의의 "진짜 vs 충분·지속"을 그룹 차원으로 일반화한 것이다.

빠진 것은 1차 지표(레벨) 위의 **2차 렌즈**: ① 궤적(방향·모멘텀) ② 깔때기 전환 ③ 기대 대비 갭. Phase 1은 **①궤적**만 다룬다(ROI 최고, 가장 견고).

## 결정된 방향 (brainstorm)

- **기준 프레임 = Frame A (자기 과거 대비)**. 코호트/이상경로 대비는 보류.
- **궤적 대상 = 원천 기둥**(scored Health factor 아님). 이미 `agg_summary`에 일별로 저장된 raw 시계열 위에 얹어 코호트 ref 재계산을 회피 — 더 견고하고 Frame A와 일치.
- **시간 창 = 주단위(WoW) + 4주 추세 + 가속**.
- **출력 = 서술 궤적 + 약점 플래그 + posture 라벨**. 자동 처방은 기존 weekly LLM에 위임(월권 회피, 윤리 §5).
- **배치 = 모든 그룹의 `성장` 탭**(GroupTabs 5번째). 궤적은 전부 공개 집계 외형 지표(구독자·조회·커뮤니티 게시량·sentiment)라 §4 "경쟁사는 외형만"에 위배 안 됨.

## 데이터 토대 (검증 완료)

- `agg_summary` PK `(group_key, snapshot_at)` = 일별 시계열. MiiWAN 126일, 경쟁사 수백~수천일, BTHD 12일.
- **누적 레벨 컬럼**(단조 증가): `yt_subscribers`, `yt_total_views`, `yt_likes_total`, `yt_comments_total`, `dc_total_posts`/`theqoo_posts`/`instiz_posts`/`twitter_posts`. → 궤적은 **1차 차분(주간 flow)**.
- **비율/레벨 컬럼**: `negative_ratio`. → 레벨 + drift.
- **하루에 스냅샷 여러 개**(aggregate→melon→aggregate sandwich) → KST 일별 1개로 리샘플(그날 MAX(snapshot_at)) 필수.
- 계산된 Health 4-factor는 시계열 저장 안 됨 → 그래서 raw 기둥을 쓴다(과거 코호트 ref 재구성 회피).

## 기둥 4개 + 궤적 산식

KST 일별 리샘플된 레벨 시계열 `L(d)` 기준.

| 기둥 | 원천 | 타입 | 궤적 |
|---|---|---|---|
| **도달 성장** (reach) | yt_subscribers (primary), yt_total_views (secondary) | 누적 | 주간 flow Δ7 = L(d)−L(d−7) |
| **호응 품질** (engagement) | 증분 ER = Δ(likes+comments)/Δviews over window | 누적→비율 | 비율 추세 |
| **커뮤니티 모멘텀** (community) | dc+theqoo+instiz+twitter posts 합 | 누적 | 주간 flow |
| **여론** (sentiment) | negative_ratio | 레벨 | 레벨 + drift (낮을수록 건강) |

각 기둥 산출:
- **WoW 성장률** `g = (L(d) − L(d−7)) / L(d−7)` (레벨형). 비율형(호응·여론)은 값 자체의 WoW 변화. 증분 ER window = trailing 7일.
- **4주 기울기**: **누적 기둥은 주간-flow 시계열**(Δ7), **비율/레벨 기둥(호응·여론)은 값 시계열**에 trailing 28일 선형회귀 → 평균 대비 상대값(%/주)으로 정규화. 증분 ER slope window = 28일.
- **가속**: 최근 14일 평균 flow(비율형은 평균 레벨) vs 직전 14일 평균의 차(부호 + deadband).
- **분류**: `climbing|plateau|declining`(4주 상대기울기 임계 ±5%/주, **first-pass·calibrate**) × `accelerating|decelerating`(가속 부호, deadband).

> 임계값은 organicity와 동일하게 first-pass — 라이브 분포로 후속 보정. 휴리스틱 추정(ground-truth 아님).

## posture 라벨 + 약점 플래그

- **posture**: 기둥별 방향 점수 {climbing +1 / plateau 0 / declining −1}에 가중(reach 0.4 / engagement 0.3 / community 0.2 / sentiment 0.1) 합 → 방향 부호. 가속도 동일 가중 합 → 가속 부호. 매핑: `상승·가속` / `상승·감속(정점 징후)` / `정체` / `하락·감속` / `하락·가속(악화)`. **등급 아님, 방향 사실**(organicity de-valence 원칙) + "휴리스틱 추정·인간검증" 병기.
- **약점 플래그**: 표준화 궤적 점수(방향+가속) 최저 기둥 1개를 객관 표시("가장 약한 궤적: X(정체)").

## 아키텍처 (worker→table→API→view 패턴)

### worker `analysis/growth_trajectory.py`
- 그룹별 agg_summary history fetch → KST 일별 리샘플 → 기둥별 flow/비율 시계열 → WoW·4주기울기·가속·분류 → posture·약점 산출.
- 순수 함수로 분해(리샘플 / flow / 기울기 / 가속 / 분류 / posture)해 단위 테스트 가능.
- `cli.py aggregate`(skip_derived 무관 블록)에 등록 → 매일 cron 재계산.

### table `group_growth_trajectory` (migration 신규)
그룹당 1행, 최신 계산 스냅샷:
```
group_key      TEXT PRIMARY KEY
computed_at    TEXT NOT NULL
status         TEXT NOT NULL   -- 'ok' | 'insufficient_history'
history_days   INTEGER NOT NULL
posture_label  TEXT            -- NULL when insufficient
weakest_pillar TEXT            -- NULL when insufficient
pillars        TEXT NOT NULL   -- JSON: [{key, level, wow_growth, slope_4w, accel, direction, accel_dir}]
```
(JSON blob은 organicity의 signal_breakdown 패턴 동일 — 컬럼 churn 회피.) build 함수는 full DELETE 후 rebuild(요약 테이블 관례).

### API `functions/api/growth-trajectory.ts` (`?group=` 필수)
- `group_growth_trajectory` 1행 SELECT, pillars JSON 파싱해 반환.
- **graceful degradation**: 테이블 없으면 try/catch → `{ status: "no_data" }`(배포↔migration 순서 방어, CLAUDE.md 규칙).

### frontend `views/GroupGrowth.tsx` + `components/GrowthTrajectoryPanel.tsx`
- `<GroupTabs />` 렌더 + 패널: posture 헤더 → 기둥 4행(방향 화살표·WoW·가속) → 약점 callout → disclaimer.
- `status==='insufficient_history'` → "데이터 축적 중 (N일 / 최소 14일)". `no_data` → EmptyState.
- 라우팅: `router.ts`의 `RouterState["tab"]` union에 `"growth"` 추가, `GroupTabs.GROUP_TABS`에 `["growth","성장"]` 추가, App에서 tab==='growth' → GroupGrowth.

## 얕은 history 처리
- 리샘플 일수 < 14 → `status='insufficient_history'`, posture/약점 NULL. BTHD(12일) 해당 → "데이터 축적 중". MiiWAN(60일+)·경쟁사 → 정상.

## 비목표 (Phase 2+)
- 자동 처방(약점별 권장 액션) — LLM 위임 유지.
- 깔때기 전환(stage 간 누수율), 기대 대비 갭(Frame B/C).
- 그룹 카드/MiiWANBriefing 축약 posture 배지(후속 — 본 작업은 탭 뷰까지).
- 임계값 calibration(라이브 분포 수집 후).

## 테스트 (TDD)
- worker `test_growth_trajectory.py`: 합성 시계열로 ① 일별 리샘플(중복 제거) ② flow 계산 ③ 4주 기울기 부호·크기 ④ 가속 부호 ⑤ 분류 경계 ⑥ posture 매핑 ⑦ 약점 선정 ⑧ insufficient_history 경계(13일/14일) ⑨ 증분 ER(Δ기반).
- frontend: tsc clean, 패널 graceful(insufficient/no_data) 렌더, 라우터 tab union.

## 배포 순서
신규 table 읽는 API는 graceful(테이블 없으면 no_data) → 배포가 migration보다 먼저 나가도 500 대신 빈 응답. migration `gh workflow run migrate.yml`은 운영자 apply. worker는 다음 aggregate cron이 table 채움.
