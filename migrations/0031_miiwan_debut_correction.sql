-- migrations/0031_miiwan_debut_correction.sql
--
-- MiiWAN 데뷔 일자 정정 + 선공개곡 추가 (사용자 확인 2026-05-06).
--
-- 1) 정식 데뷔: 2026-06-01 (placeholder seed) → **2026-06-16** (확정)
-- 2) 선공개곡 "깃털": **2026-05-27** 발매 — 데뷔 D-20 시점 모멘텀 빌드업
--
-- 영향:
--   - groups.debut_date 갱신 → /api/miiwan days_to_debut, MiiWANBriefing
--     D-day 카드, alerts/rules.py debut_milestone 계산 모두 6/16 기준으로
--     자동 보정.
--   - group_events 의 기존 debut + first_release 행 (id=80, 81)을 6/16 으로
--     이동하고, 5/27 선공개곡 행 1개 추가.
--   - 선공개곡 = pre_debut event_type (정규 데뷔 전 모멘텀용 트리거).
--     MiiWANBriefing 의 EventTimeline + DebutCurve annotation 에서
--     자동 표시.
--
-- 멱등성: UNIQUE INDEX (group_key, event_date, title) + INSERT OR IGNORE.

UPDATE groups
   SET debut_date = '2026-06-16'
 WHERE key = 'miiwan';

-- 기존 debut + first_release 행 (id=80, 81) 두 건 모두 6/01 → 6/16.
UPDATE group_events
   SET event_date = '2026-06-16'
 WHERE group_key = 'miiwan'
   AND event_date = '2026-06-01';

INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence)
VALUES
  ('miiwan', '2026-05-27', 'pre_debut',
   '선공개곡 ''깃털'' 발매',
   '정식 데뷔 (2026-06-16) 20일 전 선공개. 그룹 모멘텀 빌드업 + D-30 캠페인 트리거 역할.',
   NULL,
   'high');
