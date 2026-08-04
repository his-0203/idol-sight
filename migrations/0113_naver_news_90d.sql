-- migrations/0113_naver_news_90d.sql
--
-- 시장 지도 산식 v2(2026-08): 인지도의 뉴스 신호를 누적 → 최근 90일
-- 플로우로 교체하기 위한 새 컬럼. naver_total_news 는 health_score 가
-- 5개 지점에서 소비하므로 의미를 바꾸지 않고 별도 컬럼으로 공존한다
-- (spec: docs/superpowers/specs/2026-08-04-market-map-formula-v2-design.md).
-- 값은 aggregate 가 naver_articles.published_at 기준 windowed COUNT 로
-- 채운다. 과거 스냅샷은 NULL 유지(재백필 안 함 — 90일 창 앞부분이 수집
-- 개시 이전이라 편향; awareness 는 컬럼 부재/NULL 시 누적으로 폴백).
ALTER TABLE agg_summary ADD COLUMN naver_news_90d INTEGER;
