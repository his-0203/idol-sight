-- migrations/0038_null_zero_yt_aggregates.sql
--
-- 데이터 위생: agg_summary 의 live 행에서 yt_subscribers / yt_total_views
-- 가 0 으로 들어간 케이스를 NULL 처리. youtube_channel_stats 가
-- 그룹/시점에 데이터 없으면 산식의 COALESCE(MAX(c.x), 0) 가 0 을
-- emit → INSERT 시 0 이 박힘 → /api/market 의 MAX(snapshot_at) 가
-- 그 행 픽업 → MarketOverview 카드 "0 구독자" / "0 조회수" 노출.
-- backfill_estimate 에 정상값(예: wegosix 12.6K)이 있어도 latest
-- snapshot wins 라 가려짐.
--
-- 본 마이그레이션은 stale 한 0-row 정리 1회분. 이후 발생을 막으려면
-- worker 의 build_agg_summary 산식이 0 을 NULL 로 emit 하도록 같이
-- 변경 (다음 commit, agg_summary.py).
--
-- 안전성: data_source='live' 로 한정 — backfill_exact / backfill_estimate
-- 의 정상 0 (있다면) 은 손대지 않음. 그리고 yt_total_videos 는
-- 별도 컬럼이라 분리 처리 (단순 영상 0개인 신생 채널은 합법적 0).

UPDATE agg_summary
   SET yt_subscribers = NULL
 WHERE data_source = 'live'
   AND yt_subscribers = 0;

UPDATE agg_summary
   SET yt_total_views = NULL
 WHERE data_source = 'live'
   AND yt_total_views = 0;

UPDATE agg_summary
   SET yt_likes_total = NULL
 WHERE data_source = 'live'
   AND yt_likes_total = 0;

UPDATE agg_summary
   SET yt_comments_total = NULL
 WHERE data_source = 'live'
   AND yt_comments_total = 0;

-- SKINZ video-count cliff at D+390: a single backfill_estimate row at
-- 2026-05-05T00:00:00Z carries yt_total_videos=50 (probably partial
-- SB Premium recent-uploads page) while neighbors are 590~593. The
-- DebutCurve API picks MAX value per day_offset, but null neighbors
-- get filtered, leaving the bogus 50 alone in that day's bucket and
-- producing the visual cliff. NULL it so adjacent days carry the line.
UPDATE agg_summary
   SET yt_total_videos = NULL
 WHERE group_key = 'skinz'
   AND snapshot_at = '2026-05-05T00:00:00Z'
   AND yt_total_videos = 50;
