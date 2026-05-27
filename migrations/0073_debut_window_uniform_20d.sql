-- migrations/0073_debut_window_uniform_20d.sql
--
-- V2.34 — Debut Window bucket 균등 20일 폭 통일.
--
-- 이전 (V3.1, 2026-05-25): WINDOW_BUCKETS 가 11개였지만 폭 비대칭이었음
--   Pre / D-60 (30일) / D-30 (10일) / D-20 (10일) / D-10 (9일) / D-Day (3일)
--   D+10 (9일) / D+20 (10일) / D+30 (10일) / D+60 (30일) / Post
--
-- 신규 (V2.34): 7 named bucket 모두 정확히 20일 폭 균등 + Pre/Post catch-all.
--   Pre  : days <= -71
--   D-60 : -70 .. -51
--   D-40 : -50 .. -31
--   D-20 : -30 .. -11
--   D-Day: -10 .. +9   (debut centered)
--   D+20 : +10 .. +29
--   D+40 : +30 .. +49
--   D+60 : +50 .. +69
--   Post : days >= +70
--
-- 영향 받는 테이블:
--   1) debut_window_video_organicity  — 영상별 row, days_relative_to_debut 그대로
--      유지하되 window_bucket 라벨을 신규 boundary 로 재할당 (UPDATE in-place).
--   2) debut_window_organicity_summary — (group_key, window_bucket) PRIMARY KEY.
--      기존 bucket 의 의미가 바뀌므로 통째로 DELETE → 다음 worker cron 의
--      build_summary 가 재집계.

-- 1) per-video 테이블: bucket 라벨만 재할당.
UPDATE debut_window_video_organicity
SET window_bucket = CASE
  WHEN days_relative_to_debut <= -71 THEN 'Pre'
  WHEN days_relative_to_debut <= -51 THEN 'D-60'
  WHEN days_relative_to_debut <= -31 THEN 'D-40'
  WHEN days_relative_to_debut <= -11 THEN 'D-20'
  WHEN days_relative_to_debut <=   9 THEN 'D-Day'
  WHEN days_relative_to_debut <=  29 THEN 'D+20'
  WHEN days_relative_to_debut <=  49 THEN 'D+40'
  WHEN days_relative_to_debut <=  69 THEN 'D+60'
  ELSE 'Post'
END;

-- 2) summary 테이블: bucket 경계가 바뀌면 SUM/평균이 무의미 → 통째로 비우고
--    다음 worker cron 의 build_summary 가 재집계.
--    (몇 시간의 'Loading…' 빈 카드 노출은 운영자가 수용. 즉시 채우려면
--    `worker/cli.py build-debut-window-summary` 수동 실행.)
DELETE FROM debut_window_organicity_summary;
