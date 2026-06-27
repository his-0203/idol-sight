# P2a — MiiWAN 찐팬 활동량 지표 설계서

> **기준일**: 2026-06-27 · **단계**: P2(실무 신규 지표)의 첫 sub-project · **범위**: MiiWAN 단독, 신규 수집 0(기존 데이터 재가공)

## 0. 배경 & 범위 결정

P2(실무 신규 지표)는 세 sub-project로 분해된다: **P2a 찐팬 활동량(이 문서)** · P2b 인지도 지수 · P2c SOV/시장점유 정리.

"찐팬들의 활동량을 체크"하려는 목표에 대해, 라이브 채팅 수집 실태를 코드·실측으로 확인한 결과:
- 라이브 채팅 원문(author 포함) 자동 수집 워크플로(`collect-live-chat.yml`)는 cron(KST 04·12시)으로 돌지만 **`--group miiwan`만** 실행. `live_chat_messages`는 보존(삭제 안 함).
- `ccv_tracked`(CCV/충성도 대상 corporate 8)는 채팅을 안 긁고, V튜버(isedol/stellive)는 ccv_tracked도 아님.

**사용자 결정**: 찐팬 활동량은 **MiiWAN 단독**(자사 심층분석 전용). 그룹간 시장점유 비교에서는 제외(비교는 SOV 등 다른 신호). 시스템 철학("자사=심층, 경쟁사=외형만")과 일치.

**실측 grounding (D1, 2026-06-27)**:
- 라이브 채팅: 방송 3건(06-16/17/22), 메시지 8541/5987/5767(저장=수집), 고유 챗터 140/99/84, **author NULL = 0**(완전 채워짐) → 고유·재방문 지표 가능. 챗터당 ~60–69 메시지(초고밀도 코어).
- 최근 영상 12건: 조회 중앙값 ~2,800, **좋아요 중앙값 ~220**, 댓글 중앙값 ~23. like_rate 6–10%대(매우 높음), comment_rate ~0.5–1.8%.

## 1. 목표 / 비목표

**목표**: MiiWAN의 찐팬 활동량을 (A) 라이브 채팅 measured 지표 + (B) 영상 참여 estimated 지표로 산출·저장·노출. **신규 수집 0**(전부 기존 `live_chat_messages`·`youtube_video_stats` 재가공).

**비목표**:
- MiiWAN 외 그룹으로 확대(별도 비용 발생 — 본 범위 아님).
- 활동량을 그룹간 시장점유 비교에 사용(사용자 결정으로 제외).
- 멤버십/슈퍼챗/재방문 시청자(YouTube Analytics 미노출 — NULL) — 본 범위 아님.
- 벤치마크 밴드("높다/낮다" 임계)의 정밀 캘리브레이션 — first-pass로 두고 데이터 축적 후 보정.

## 2. 데이터원 (전부 기존)

- `live_chat_messages` (video_id, group_key, msg_id, offset_ms, author, message) — 방송별 raw 채팅. MiiWAN만 존재.
- `live_chat_reports` (video_id, group_key, ended_at, total_messages) — 방송 메타·멱등 제어.
- `youtube_videos` + `youtube_video_stats` (views, likes, comments, snapshot_at) — 영상별 최신 스냅샷.
- `agg_summary.yt_subscribers` (또는 channel_stats) — MiiWAN 구독자.

## 3. 지표 정의

### (A) 라이브 채팅 — measured (방송별)
방송 b의 메시지 집합에서:
1. **고유 챗터 수** `unique_chatters = COUNT(DISTINCT author)` (author 비어있지 않은 것).
2. **챗터당 메시지** `msgs_per_chatter = round(total_messages / unique_chatters, 1)`. `unique_chatters=0`이면 None.
3. **분당 피크 채팅량** `peak_msgs_per_min = max_bucket( COUNT(*) GROUP BY offset_ms // 60000 )`. `offset_ms` NULL 메시지는 velocity 버킷에서만 제외(고유·메시지 카운트엔 포함). 버킷 없으면 None.
4. **재방문 비율** `returning_rate = |chatters(b) ∩ chatters(b-1)| / |chatters(b)|` — 시간순 직전 방송 대비. 직전 방송 없으면(첫 방송) None.

### (A-rollup) 윈도우 코어팬 (최근 56일)
- **코어팬** = 윈도우 내 **2개 이상 방송에 등장한** 고유 author 집합.
- `core_fan_count` = |코어팬|. `core_fan_share = core_fan_count / 윈도우_고유_챗터수`.
- 윈도우 헤드라인: `unique_chatters`/`msgs_per_chatter`/`returning_rate`/`peak_msgs_per_min`의 방송별 값 **중앙값**.

### (B) 영상 참여 — estimated (채널 현재 스냅샷)
**최근 56일 내 발행 영상**의 각 최신 스냅샷 기준(라이브 채팅 윈도우와 동일). 56일 내 영상이 3건 미만이면 최신 12건으로 폴백(소표본 가드):
> ⚠️ **추정치**(공개 외형 신호) — 메트릭 정의서 원칙대로 "추정이며 인간 판단 대체 아님" 명시. measured 라이브 코어와 **다른 축**.
- **추정 관여 팬** `est_engaged_fans = median(likes per video)`. 근거: YouTube 좋아요는 *영상당 1인 1회* → 영상당 좋아요 ≈ 그 영상에 반응한 **고유 팬 수의 근사**.
- **추정 적극 코어** `est_active_core = median(comments per video)`. 댓글은 1인 다회 가능 → 적극 참여 **상한** 추정.
- **시청 전환** `view_through = median(views) / yt_subscribers` (구독자 중 실제 시청 추정 비율). subscribers≤0이면 None.
- **참여율** `like_rate = median(likes/views)`, `comment_rate = median(comments/views)`.

### 층위 해석 (카드)
`추정 관여 팬(좋아요)` ↔ `측정 라이브 코어(고유 챗터)` ↔ `추정 적극 코어(댓글)` 를 참여 강도별 층위로 병치(엄격한 포함관계 아님 — 서로 다른 참여 표면).

## 4. 저장 스키마 (migration 신규)

**`agg_live_activity`** — 방송별 1행, `(group_key, video_id)` PK 멱등 upsert:
`group_key, video_id, ended_at, unique_chatters, total_messages, msgs_per_chatter REAL, peak_msgs_per_min, returning_rate REAL, basis TEXT, generated_at`.

**`agg_live_activity_summary`** — 그룹별 1행(현재 윈도우+추정), `group_key` PK:
`group_key, generated_at, window_days, broadcast_count, median_unique_chatters, median_msgs_per_chatter, median_returning_rate REAL, median_peak_msgs_per_min, core_fan_count, core_fan_share REAL, est_engaged_fans, est_active_core, view_through REAL, like_rate REAL, comment_rate REAL, basis TEXT`.

(loyalty의 raw→summary 분리 패턴 미러. summary는 카드 헤드라인, per-broadcast는 추이.)

## 5. 산정 모듈 & basis

`worker/src/idol_sight/analysis/live_activity.py`:
- `build_live_activity(client, *, group_key, window_days=56)` — `live_chat_reports`를 진실원으로 윈도우 내 방송을 시간순 처리, per-broadcast 행 + summary 행 산출. (B) 추정은 `youtube_video_stats` 최신 스냅샷 + subscribers로. full DELETE 후 rebuild(멱등).
- **basis** (loyalty 미러): 방송 0 → `insufficient`(summary만 기록, 카드 "축적 중"). 방송 1 → `low_confidence`(returning_rate=None, core_fan 미산정). 방송 ≥2 → `scored`.
- 모든 그룹 tracked지만 live_chat 데이터 있는 그룹만 실질 산출 = MiiWAN.

`cli.py`: `build-live-activity --group miiwan` 커맨드 + `collect-live-chat` 직후 또는 aggregate 사이클에 편입(워크플로 1줄 추가).

## 6. 노출 (frontend)

- `frontend/functions/api/miiwan.ts` 확장: `agg_live_activity_summary`(헤드라인) + `agg_live_activity`(방송별 추이) 응답에 포함.
- `frontend/src/views/MiiWANBriefing.tsx`에 **'찐팬 활동량' 카드** 신설(MiiWAN 전용 뷰라 노출 그룹 게이트 불필요):
  - 헤드라인 3층위: 추정 관여 팬(좋아요) / 측정 라이브 코어(고유 챗터) / 추정 적극 코어(댓글) + 코어팬 비율.
  - 방송별 추이(FanLoyaltyCard식 행/막대): 날짜·고유 챗터·챗터당 메시지·분당 피크·재방문 비율.
  - 카피는 평이 한국어(예: "이번 방송에 다시 온 단골 비율", "영상에 좋아요로 반응한 추정 팬 수 — 고유 인원 근사"). 추정 항목엔 "추정" 배지.

## 7. 테스트

`worker/tests/unit/test_live_activity.py`:
- 합성 `live_chat_messages`로 고유 챗터·챗터당 메시지·분버킷 피크(offset_ms NULL 섞어 제외 확인)·2방송 교집합 `returning_rate`·코어팬(≥2방송 등장) 산정 고정.
- basis 3단계(0/1/≥2 방송).
- (B) 추정: 합성 video_stats로 median likes/comments/views·view_through·subscribers≤0 None 처리.
- 멱등성(rebuild 시 행 수 불변).
프런트: `miiwan.ts` 응답 shape + 카드 렌더(가능 범위) 테스트.

## 8. 후속 (비목표 기록)

- 타 그룹 확대(collect-live-chat을 ccv_tracked/V튜버로) — 비용 발생, 별도 결정.
- 벤치마크 밴드 캘리브레이션(좋아요/댓글/시청전환 "높음/낮음" 임계) — 데이터 축적 후.
- offset_ms 정밀(라이브 진행 중 vs 종료후 채팅 구분) — 현재 전체 사용.
