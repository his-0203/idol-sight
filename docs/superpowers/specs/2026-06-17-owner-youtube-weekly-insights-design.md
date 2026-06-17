# 미완소년 소유자 YouTube 데이터 → 수·일 인사이트 통합 설계

- 날짜: 2026-06-17 (데뷔 D+1)
- 범위: worker(인사이트 파이프라인·수집기·migration) 중심. 프론트는 인사이트 카드 렌더가 이미 있어 무변경(2차 demographics viz는 후속).
- 동기: 4-에이전트 종합 분석 결론 — **이미 매일 수집·저장되는 미완소년 소유자 OAuth 데이터(`agg_youtube_analytics*`)가 수·일 LLM 인사이트(`weekly.py build_context`)에 전혀 들어가지 않는다.** 가장 작은 변경으로 가장 큰 정보 이득.

## 현재 상태(확인됨)

- 수집: `collectors/youtube_analytics.py`, miiwan 전용, 매일 `collect-daily.yml`. 국가 차원(watch_share/growth_mom/retention_rel/sub_per_1k/watch_minutes/organic_share/subs_gained) → `agg_youtube_analytics_country`. 채널 차원(`agg_youtube_analytics`)은 returning/membership/super_chat 전부 NULL.
- 소비: `frontend/functions/api/miiwan.ts`(DECISION 보드)만. **인사이트 LLM은 미소비.**
- `build_context`(`weekly.py:29-108`) 입력: agg_summary(7d·prev7d)/hanteo/market_share/naver_articles/signals/debut_countdown. owner 데이터 없음.

## 설계

### Phase 1 — owner 국가 데이터를 인사이트 컨텍스트에 주입 (migration·수집 변경 없음)

1. `weekly.py`
   - 순수 함수 `_format_owner_youtube(rows, today, *, top_n=8, stale_days=7, min_watch_minutes=60)`:
     - rows = `agg_youtube_analytics_country` 최신 스냅샷 행들.
     - 신선도: `today - snapshot_date > stale_days` → `None` (수집 중단 시 옛 데이터로 환각 방지).
     - watch_share 내림차순 top_n.
     - 각 국가: `watch_share_pct`, `watch_minutes`, `retention_rel`, `organic_share_pct`(None 허용), `sub_per_1k`, `growth_label`(None→"신규(측정 보류)", 값→"+12%"/"−5%"), `low_sample`(watch_minutes < min_watch_minutes).
     - ground-truth 라벨 구조(`debut_countdown` 패턴) — LLM이 raw 숫자 환각 못 하게 사전 가공.
     - 반환: `{window, snapshot_at, age_days, countries:[...]}` 또는 `None`.
   - `_fetch_owner_youtube(db, today)`: 최신 스냅샷 1개 쿼리 후 위 포매터 호출.
     ```sql
     SELECT country, watch_share, growth_mom, retention_rel, sub_per_1k,
            watch_minutes, organic_share, subs_gained, snapshot_at
     FROM agg_youtube_analytics_country
     WHERE group_key='miiwan'
       AND snapshot_at=(SELECT MAX(snapshot_at) FROM agg_youtube_analytics_country WHERE group_key='miiwan')
     ORDER BY watch_share DESC
     ```
   - `build_context`: 맨 끝(debut 쿼리 뒤)에 1개 execute 추가 → `ctx["miiwan_youtube"]`(없으면 키 생략).
2. `prompts.py`
   - `_OWNER_YOUTUBE_GUIDELINES` 블록: 컨텍스트 설명 + 가드(상대 share·30일 롤링 시간축·NULL≠0·소표본·경쟁사 비교 불가·페이드 단정 금지) + few-shot 3종(해외진출 ipx_action / 국내↔해외 디커플링 insight / organic 진정성 교차).
   - PROMPT_WEEKLY f-string에 삽입 + 상단 컨텍스트 목록에 miiwan_youtube 추가.

### Phase 2 — 2차 수집 확장 (subscribedStatus + demographics)

3. migration `0091_youtube_analytics_audience.sql` (0090 은 live_chat 이 선점)
   - `agg_youtube_analytics` += `subscribed_watch_share REAL`, `unsubscribed_watch_share REAL`.
   - `agg_youtube_analytics_demographics(group_key, snapshot_at, age_group, gender, viewer_pct, PK(...))`.
4. `youtube_analytics.py`
   - 순수 `build_subscriber_split(rows)` (dimensions=subscribedStatus, metric=estimatedMinutesWatched) → `{subscribed_watch_share, unsubscribed_watch_share}` | None.
   - 순수 `build_demographics_rows(rows, group_key, snapshot_at)` (dimensions=ageGroup,gender; metric=viewerPercentage) → INSERT stmts.
   - `_subscribed_report`/`_demographics_report` HTTP(기존 `_traffic_report`처럼 best-effort try/except).
   - 채널 INSERT에 subscriber split 채움(기존 NULL 4종은 유지).
5. `build_context` Phase 2b: 최신 채널 행(subscriber split) + demographics top → `miiwan_youtube["audience"]`에 추가. prompts에 굿즈/타겟 few-shot 1줄.

### 가드(전 함정 — 4-에이전트 합의)
소표본 분모 노이즈·신규국 growth 폭발(NULL 보존)·단기 스파이크≠추세(interim 관찰)·watch_share 상대값·경쟁사 owner 데이터 부재·organic 낮음≠페이드. 전부 `_OWNER_YOUTUBE_GUIDELINES`에 명시 + 포매터가 구조적으로 차단(low_sample 플래그, growth_label NULL 표기).

## 후속(이번 범위 밖, 명시)
- day 차원 시계열(진짜 주간 델타) — 수집 스키마/카덴스 변경 커서 별도.
- 트래픽 검색어 상세(insightTrafficSourceDetail) 저장.
- demographics 프론트 시각화(굿즈 보드 확장).

## 테스트
- `_format_owner_youtube`: 신선도 컷·top_n·low_sample·growth_label NULL·organic NULL.
- `build_context`: owner 데이터 주입/부재/stale.
- PROMPT_WEEKLY substring 가드.
- `build_subscriber_split`/`build_demographics_rows` 순수 계산.
- 기존 test_llm_weekly stub들에 owner 쿼리 1개 append.
