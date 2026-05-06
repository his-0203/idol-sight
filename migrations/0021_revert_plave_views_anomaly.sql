-- migrations/0021_revert_plave_views_anomaly.sql
--
-- Image 7 (사용자 production 검증)에서 PLAVE 누적 조회수 곡선이 D+15
-- 부근에서 7.5M → D+50 부근 ~0 으로 떨어지는 V-shape 발생.
--
-- 원인: migration 0020이 Wayback 스냅샷에서 추출한 channel-level 누적
-- 조회수(7,474,945)를 PLAVE 2023-03-27 (D+15) 행에 INSERT 했음. 그러나
-- production의 다른 PLAVE 행들은 yt_history_backfill 모듈이 합성한
-- "현재 시점 view count의 cumulative SUM" 시리즈 — 본질적 over-estimate.
--
-- 두 다른 의미체계가 한 시계열에 섞이면:
--   D-50 → D+0: yt_history_backfill cumulative (over-estimate 시리즈)
--   D+15:        Wayback 실측 (under-estimate 대비 시리즈)
--   D+15 → 현재: 다시 yt_history_backfill (over-estimate)
-- 결과 = 시계열 불연속 → 차트 V-shape.
--
-- 정정: Wayback의 단일-시점-실측 view 값을 NULL 처리. 곡선이
-- yt_history_backfill의 monotonic over-estimate 시리즈로 통일됨.
-- video count는 그대로 유지 (정확값, monotonic, semantics 충돌 없음).
--
-- 부수 효과: PLAVE 2023-03-27 행은 이제 yt_total_videos=127 + 다른
-- 컬럼은 NULL/scrape값 그대로. 누적 조회수는 yt_history_backfill가
-- 채운 인접 일자 값으로 보간됨 (spanGaps 작동).
UPDATE agg_summary
   SET yt_total_views = NULL
 WHERE group_key = 'plave'
   AND snapshot_at = '2023-03-27T00:00:00Z'
   AND yt_total_views = 7474945;
