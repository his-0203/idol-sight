-- Operator decision (2026-10-22): use the first officially distributed group
-- recording as the debut anchor, including pre-release/prologue singles.
-- Broadcast launches, cover videos and live-only originals do not qualify.
--
-- B THE HOOD: Lowkey, 2026-06-26. Five-member first single; this is earlier
-- than the marketed debut EP THE REAL DEAL (2026-10-20).
-- https://music.apple.com/kr/album/lowkey-single/6777950875
-- https://sports.khan.co.kr/article/202606270530003
--
-- WE GO-6: Monster, 2026-09-22. The "Angel unit" includes all five members.
-- https://music.bugs.co.kr/album/4155552
-- https://www.chosun.com/entertainments/music/2026/09/23/GNRGIZBRME2TSOBTGBQWEMZUHA/
--
-- BEGRITZ: leave the undated/PRE state unchanged. The operator confirmed
-- that live clips of originals (e.g. X도) do not count as distributed releases.
-- Health grades and debut-window aggregates refresh on the next aggregation.

UPDATE groups
   SET debut_date = '2026-06-26', debut_confirmed = 1
 WHERE key = 'bthd';

UPDATE groups
   SET debut_date = '2026-09-22', debut_confirmed = 1
 WHERE key = 'wegosix';

-- Replace only the obsolete provisional seed events, preserving other events.
DELETE FROM group_events
 WHERE group_key = 'bthd'
   AND event_date = '2026-06-26'
   AND event_type = 'debut'
   AND title = '1st Pre-Release Single 발매 (잠정 데뷔 앵커)';

DELETE FROM group_events
 WHERE group_key = 'wegosix'
   AND event_date = '2026-08-31'
   AND event_type = 'debut'
   AND title = '정식 데뷔 (가안 — 여름 데뷔 발표, 8월말 placeholder)';

INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence)
VALUES
  ('bthd', '2026-06-26', 'debut',
   '첫 공식 단체 음원 — Lowkey 발매',
   '5인 단체 선공개 싱글의 정식 음원 유통일. 운영 기준상 첫 공식 단체 음원 발매를 데뷔로 인정한다. 홍보상 정식 데뷔 앨범 THE REAL DEAL의 발매일(2026-10-20)과 구분한다.',
   'https://music.apple.com/kr/album/lowkey-single/6777950875',
   'high'),
  ('wegosix', '2026-09-22', 'debut',
   '첫 공식 단체 음원 — 괴물(Monster) 발매',
   '멤버 5인 전원이 참여한 프롤로그 싱글의 정식 음원 유통일. 엔젤 유닛은 일부 멤버 유닛이 아닌 전원 참여 페르소나이며, 첫 공식 단체 음원 기준으로 데뷔를 확정한다.',
   'https://music.bugs.co.kr/album/4155552',
   'high');
