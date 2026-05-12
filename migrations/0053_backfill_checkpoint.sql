-- 0053_backfill_checkpoint.sql
--
-- backfill-yt-videos 완료 시점 추적. matrix workflow의 그룹 단위 성공 시
-- UPDATE. CLI의 freshness 필터(기본 7일)가 이 컬럼을 읽어 최근 완료된
-- 그룹은 skip한다. health-check도 14일+ stale 그룹을 알림.
--
-- 기존 행은 NULL → 첫 실행 시 자동으로 walk 대상에 포함.

ALTER TABLE groups ADD COLUMN last_backfilled_at TEXT;
