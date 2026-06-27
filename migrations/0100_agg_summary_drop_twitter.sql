-- P4 Twitter 물리삭제: agg_summary.twitter_posts 컬럼 제거
-- (agg_summary.py UPSERT + 모든 backfill INSERT에서 컬럼 참조 제거 완료)
-- SQLite 3.35+ / D1 지원 확인됨 (ALTER TABLE ... DROP COLUMN)
ALTER TABLE agg_summary DROP COLUMN twitter_posts;
