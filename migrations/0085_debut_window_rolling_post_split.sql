-- migrations/0085_debut_window_rolling_post_split.sql
--
-- V2.49 — Debut Window 롤링 윈도우: 'Post' catch-all (days >= +70) 폐기.
-- worker bucket_for 가 d >= 10 을 20일 폭 산술 라벨 (D+20k, k=(d-10)/20+1)
-- 로 생성하게 바뀌므로, 기존 Post 행을 같은 산식으로 재배치한다.
-- (0073 패턴 — UPDATE in-place + summary DELETE 후 cron 재집계.)
--
-- SQLite 정수 나눗셈은 양수에서 truncate = Python floor 와 동일 (d>=70 이라
-- 항상 양수). window_bucket 은 CHECK 없는 TEXT 라 새 라벨 삽입 자유 (V2.42).

-- 1) per-video 테이블: Post 행만 산술 라벨로 재할당.
UPDATE debut_window_video_organicity
SET window_bucket = 'D+' || (((days_relative_to_debut - 10) / 20 + 1) * 20)
WHERE window_bucket = 'Post';

-- 2) summary 테이블: bucket 구성이 바뀌므로 통째로 비우고 다음 worker cron
--    의 build_summary 가 재집계. (몇 시간의 'Loading…' 은 운영자 수용,
--    즉시 채우려면 worker aggregate 수동 dispatch.)
DELETE FROM debut_window_organicity_summary;
