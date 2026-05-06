-- migrations/0036_wegosix_provisional_debut.sql
--
-- Wegosix (위고식스) provisional debut date — 2026-05-31 (사용자
-- 가안 2026-05-06). 외부 보도가 "5월 중 데뷔" 까지만 확인된 상태라
-- 월말 마지막 일자를 placeholder 로 잡아둠.
--
-- DebutCurve / Health Score / 알림(debut_milestone) 산식이 모두
-- groups.debut_date 가 NOT NULL 일 때만 동작하므로, 데뷔 정렬 곡선에
-- Wegosix 라인을 띄우려면 일자가 있어야 함. 정확한 일자가 외부
-- 발표/보도로 확보되면 후속 마이그레이션에서 수정.
--
-- group_events 의 debut 행 confidence='low' — 자동 알림 트리거가
-- false positive 발화하지 않도록 운영자에게 명시적 신호. 일자 확정
-- 시 confidence='high' 로 같이 승급.

UPDATE groups
   SET debut_date = '2026-05-31'
 WHERE key = 'wegosix';

INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence)
VALUES
  ('wegosix', '2026-05-31', 'debut',
   '정식 데뷔 (가안 — 5월 중 발표 예정)',
   '외부 보도는 "5월 중 데뷔" 까지만 확인. 정확한 일자 확보 시 후속 마이그레이션으로 갱신 + confidence high 승급.',
   NULL,
   'low');
