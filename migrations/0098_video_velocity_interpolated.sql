-- 0098_video_velocity_interpolated.sql — P2a velocity 보간 신뢰플래그.
--
-- view_count_24h_interpolated:
--   1   = 보간 성공 (양측 bracket — before + after 스냅샷 모두 존재, 선형 보간 적용)
--   0   = 단측 raw 폴백 (한쪽 스냅샷만 존재, 저신뢰 추정값)
--   NULL = 미산정 (스냅샷 부족 또는 해당 사이클 미처리)
--
-- D1/SQLite INTEGER로 bool 저장 (0/1/NULL). 프론트 노출은 후속 작업.

ALTER TABLE youtube_videos ADD COLUMN view_count_24h_interpolated INTEGER;
