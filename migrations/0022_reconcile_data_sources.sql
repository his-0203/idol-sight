-- migrations/0022_reconcile_data_sources.sql
--
-- 사용자 production 검증 (Image 10, 11)에서 두 가지 시각 이상 발견:
--
-- (1) PLAVE 영상 수 곡선이 D+30 부근 ~150에서 D+150 부근 ~5로 drop.
--     원인: production `youtube_videos` 테이블이 PLAVE 과거 영상을
--     incomplete하게 인덱싱 (YouTube API page-limit 또는 collector
--     설정). `yt_history_backfill` 모듈이 incomplete 데이터로 cumulative
--     SUM을 계산해 후속 일자에 매우 적은 값을 emit. 이 값이 Wayback에서
--     회수한 정확한 시점-실측 값(D-180~D+90 범위)과 한 시계열에 섞이며
--     V-shape drop 발생.
--
--     fix: PLAVE/SKINZ/MYRAKL/OWIS 4그룹의 yt_history_backfill 출력
--     행에서 yt_total_videos / yt_total_views를 NULL 처리. 이 그룹들은
--     Wayback 백필 값만 신뢰. yt_history_backfill 출력 행 시그니처는
--     migration 0018과 동일 (yt_subscribers IS NULL + 모든 비-YT 컬럼
--     0). 나머지 4 그룹 (MiiWAN/B:DAWN/ISEDOL/STELLIVE)의
--     yt_history_backfill 출력은 손대지 않음 — production의 youtube_videos
--     coverage가 그쪽엔 완전할 가능성 있고, 우리 백필이 거기로 침범하지
--     않음.
--
-- (2) 네이버 뉴스 곡선에 SKINZ/OWIS 일부 주차에서 정확히 1000 spike.
--     원인: stealth scraper가 Naver 검색 결과의 정확 카운트를 알기
--     위해 start=N으로 probing하다가 start=1001에서 "검색결과 없음"
--     응답이 오면 "총 1000개" lower-bound으로 기록. 실제 값은 ≥1000
--     (예: 5000, 10000)일 가능성 있지만 미확정.
--
--     fix: naver_total_news = 1000 (정확히 1000) 행을 NULL 처리. 1000은
--     scraper의 stopping flag이므로 "정확히 1000"인 정직한 카운트와 구별
--     불가능하지만, 실제로 정확히 1000인 경우는 통계적으로 매우 드물어
--     안전한 가정. 차트에서 misleading spike 사라짐. 추후 scraper에서
--     더 깊이 probing하여 정확값을 회수하면 재추가 가능.

-- (1) PLAVE/SKINZ/MYRAKL/OWIS의 yt_history_backfill 출력 행에서 비디오/조회수 NULL
UPDATE agg_summary
   SET yt_total_videos = NULL,
       yt_total_views  = NULL
 WHERE group_key IN ('plave', 'skinz', 'myrakl', 'owis')
   AND data_source = 'backfill_estimate'
   AND yt_subscribers IS NULL
   AND dc_total_posts = 0
   AND theqoo_posts = 0
   AND instiz_posts = 0
   AND naver_total_news = 0
   AND twitter_posts = 0
   AND controversy_count = 0;

-- (2) Naver lower-bound 1000 placeholder NULL 처리
-- spanGaps:true 차트 렌더링에서 NULL은 라인을 부드럽게 가로질러 연결.
-- 0으로 두면 misleading drop처럼 보일 수 있으니 NULL이 맞음.
UPDATE agg_summary
   SET naver_total_news = NULL
 WHERE data_source = 'backfill_estimate'
   AND naver_total_news = 1000;
