# 메트릭 정의서 (Metric Dictionary)

전략팀·PM이 대시보드 숫자를 신뢰·해석하기 위한 정의서. **각 지표: 무슨 뜻 / 윈도(누적 vs 주간) / 신뢰도 / 알려진 한계.** 코드가 단일 소스 — drift 시 `worker/src/idol_sight/analysis/` 가 정답.

> ⚠️ 공통 원칙: 경쟁사는 **외형만** 추적(깊이는 자사 MiiWAN). 여러 지표가 *추정*이며 인간 판단을 대체하지 않는다.

## YouTube / 도달

| 지표 | 정의 | 윈도 | 신뢰도·한계 |
|---|---|---|---|
| `yt_subscribers` / `yt_total_views` | 채널 누적 구독/조회 | 스냅샷(누적) | 공식 API. 신뢰 높음 |
| `engagement_rate` | `(likes + 5·comments) / views` (댓글 5× 가중) | 영상 단위 | health_score·diagnosis 공통식(`health_score.engagement_rate`) |
| `viral_velocity_ratio` | 영상 24h 조회 / 채널 평균 24h (leave-one-out) | 영상 단위 | 소형 채널·flat baseline 에서 무의미(0). **long-form 만 사용**(Shorts 는 V2.37 에서 제외) |
| `view_count_24h` | 업로드 +24h 조회(보간) | 영상 단위 | 6h 스냅샷 보간. ±18h 윈도 |

## Organicity (Debut Window) — **휴리스틱 추정, ground-truth 아님**

`organic_score` 0–100 + verdict 5단계(organic_strong/organic/borderline/suspect/likely_paid). **유료광고 여부를 *관측*하지 않고 공개 지표로 추정**한다 (Analytics 연동 안 함 — 운영자 결정).
- **ER = "세기" 신호 / like:comment 균형 = "진정성(organic vs 조작)" 신호.** 낮은 ER 자체가 paid 를 뜻하지 않음(콜드 도달일 수 있음).
- Shorts(V2.37): ER floor/ceil 0.5%/9%, balance 정상대 15~78, velocity 미사용, 가중 eng0.4/bal0.6. Long-form: 별도 모델(velocity 포함).
- **한계**: 정상 유료 광고(콜드 실시청자)와 오가닉 저ER 은 비중만으로 구분 불가. verdict 는 추정 → 외부 사용 전 인간 검증. 임계값은 1회 스냅샷 캘리브 → 데이터 축적 시 재보정.
- **볼륨 무관 (의도) + thin-sample 보정(V2.50)**: organic_score 는 영상 1개의 *진정성*만 보며 볼륨·성장과 무관하다 — "적게 올리고 오가닉이면 고득점" 은 성장 부재를 점수가 못 잡는 게 아니라 **organicity 가 다루는 축이 아니기 때문**(성장은 별도 *성장 궤적* 레이어). 다만 버킷 헤드라인(simple mean)이 scored 1~2개에서 자신만만한 organic_strong 을 내던 문제를 막기 위해, 헤드라인은 **중립 prior(55)로 수축**한다: `shrunk = (n·mean + k·55)/(n+k)`, k=3 (`debut_window.py` ORGANICITY_PRIOR/ORGANICITY_SHRINKAGE_K). raw mean(catalog/reach 렌즈)은 보존, `scored_video_count < 3` 버킷은 프런트에서 `*` 로 표시. **"성장하는가" 판정은 organicity 가 아니라 성장 탭을 본다.**

## 커뮤니티 / 여론

| 지표 | 정의 | 윈도 | 한계 |
|---|---|---|---|
| `dc_total_posts` / `theqoo_posts` / `instiz_posts` | 플랫폼별 수집 글 수 | **누적**(무윈도) | agg_summary 가 누적 집계 — "이번 주"가 아니라 전체 누적. WoW 는 스냅샷 간 delta 로 봐야 함 |
| `negative_ratio` | (negative+controversy)/classified | **누적**(community 누적집계와 일관) | 위와 동일하게 누적. 단독 윈도화는 보류(설계 결정 대기) |
| `controversy_count` | 논란 분류 트윗/글 수 | 스냅샷 | — |
| `community_keywords_topic` | external(방송)/self(자체)/negative/neutral 분류 | 최근 7일 제목 | first-pass lexicon(운영자 calibration 여지) |

## 알림 (위기 감지) — Streisand 민감

`controversy_spike` / `identity_leak` / `model_theft` / `video_velocity_24h` / `debut_milestone`.
- controversy_spike: **그룹별 자기 직전 스냅샷** 대비 ≥2× & ≥5건(전역 비교 아님). identity_leak: naver 기사 제목 키워드(benign 복합어 마스킹). 
- **전부 자동 발사 → 대응 전 인간 검증 필수** (오탐 시 Streisand). `docs/governance-runbook.md` 참조.

## 차트 / 판매

| 지표 | 정의 | 윈도 |
|---|---|---|
| `melon_top100_peak` / `_depth` | 멜론 TOP100 최고 순위 / 진입 기간 | 일간(06 KST)·top100(22 KST) 별도 |
| `hanteo_sales` | 한터 주간 초동 판매량 | 주간(hanteonews 기사) |
| `music_show_wins` | 음방 1위 confirmed 카운트 | 누적(status='confirmed' 만) |

## SOV / Health

- **SOV (Share of Voice · 발언/관심 점유)**: 여러 신호에서의 *언급·관심 점유도*를 나타내는 합성 지표(시장점유율과 무관). 신호별 percentile rank와 z-score를 혼합(단일 고볼륨 신호 지배 방지). 카테고리 코호트(kpop/subculture) 내 비교.
- **Health Score**: 4-factor(Reach/RitualVictory/Mobilization/Intimacy) group_model별 가중. ref 동적(percentile). 산식 정의는 `HealthSpec.tsx` 모달.

## 시간대 주의

- 대부분 타임스탬프 UTC 저장('Z'). 상대시각("3시간 전")은 offset 이라 정확. **절대 KST 타임스탬프는 일부 ~9h skew 가능**(저영향, 전용 TZ 패스 보류). 멜론 `chart_date`(KST 본 날짜)와 `snapshot_at`(수집 UTC) 분리.
