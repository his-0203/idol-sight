-- migrations/0029_null_naver_news_lower_bound_spikes.sql
--
-- 사용자 production 검증 (Image 36): DebutCurve / 네이버 뉴스 차트에
-- D-30 / D-15 / D+90 부근 정확히 1000 spike 잔존. SKINZ + OWIS + (간헐적
-- MYRAKL).
--
-- 원인:
--   * Naver Open API `/v1/search/news.json` 의 `items[]` 배열 최대
--     1000개 반환 (sort=date, 최신순).
--   * 우리 `scripts/historical_backfill/naver_api_fetch.py` 가 1000
--     articles 를 pubDate weekly로 bucket. 특정 주차에 articles이 몰려
--     있으면 그 주가 ~수백~1000+로 카운팅됨.
--   * 정확히 1000 값 = "그 주에 우리 sample 1000 articles 가 모두
--     포함됨 + 실제는 더 많을 가능성" (lower-bound flag).
--   * Naver Open API 는 날짜 범위 필터 미지원 → 추가 회수 불가.
--
-- 또한 이전 Stealth scraper (PR #4 시점) 의 `1001+` flag 값 1000도 일부
-- 잔존했을 가능성. PR #4 의 0022 가 NULL 처리했으나, PR #10 의 0025
-- (Open API) UPSERT 가 그 NULL 슬롯을 새 1000 값으로 덮었을 수 있음.
--
-- fix: 모든 backfill_estimate 행에서 naver_total_news >= 1000 인 값을
-- NULL 처리. spanGaps:true 로 차트가 인접 값으로 부드럽게 보간 →
-- misleading spike 제거.
--
-- Trade-off: 진짜 1000+ 값 (높은 뉴스 볼륨 주차)도 손실. 그러나
-- 정확한 카운트가 미상이라 "큰 값이 있었다"는 신호는 유지하되 차트의
-- visual integrity 우선. 라이브 collector (data_source='live') 행은
-- 손대지 않음 — 실시간 카운트는 정확.
--
-- 추가 회수 옵션 (별도 작업):
--   * BIGKinds (한국언론진흥재단 뉴스 archive) API — 무료, 풍부한
--     historical 검색
--   * NewsLibrary (네이버 뉴스 구버전) crawl
--   * X API Pro — 트위터 historical (별개 차원)
UPDATE agg_summary
   SET naver_total_news = NULL
 WHERE data_source = 'backfill_estimate'
   AND naver_total_news >= 1000;
