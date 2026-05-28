-- migrations/0074_wegosix_debut_summer_placeholder.sql
--
-- Wegosix (위고식스) 데뷔일 가안 갱신 — 2026-05-31 → 2026-08-31.
-- 운영자 지시 2026-05-28: 외부 일정이 "5월말" 에서 "여름" 으로 미뤄짐.
-- 정확한 일자 미공개 상태라 여름 끝물 (8월 마지막 일자) 을 placeholder.
--
-- 0036 (provisional 2026-05-31) 의 후속. 동일하게 confidence='low' 유지
-- — 자동 알림 트리거가 잘못된 D-Day 발화하지 않도록 명시적 신호. 정확한
-- 일자 확보 시 후속 마이그레이션에서 수정 + confidence='high' 승급.
--
-- group_events 의 0036 행 (event_date='2026-05-31', title='정식 데뷔
-- (가안 — 5월 중 발표 예정)') 은 unique key (group_key, event_date,
-- title) 의 event_date 가 바뀌므로 DELETE → INSERT 패턴. 같은 키로
-- UPDATE 가 불가능.
--
-- debut_window_video_organicity.window_bucket / days_relative_to_debut
-- 는 worker cron 의 build_video_organicity 가 다음 실행 시 모든 영상을
-- 재계산하면서 자동 정정됨 (V3.1 all-videos 정책). 별도 migration UPDATE
-- 불필요. debut_window_organicity_summary 도 build_summary 가 재집계.

UPDATE groups
   SET debut_date = '2026-08-31'
 WHERE key = 'wegosix';

DELETE FROM group_events
 WHERE group_key = 'wegosix'
   AND event_date = '2026-05-31'
   AND title = '정식 데뷔 (가안 — 5월 중 발표 예정)';

INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence)
VALUES
  ('wegosix', '2026-08-31', 'debut',
   '정식 데뷔 (가안 — 여름 데뷔 발표, 8월말 placeholder)',
   '외부 일정 "여름 데뷔" 로 변경 (이전 5월말 가안). 정확한 일자 확보 시 후속 마이그레이션으로 갱신 + confidence high 승급.',
   NULL,
   'low');
