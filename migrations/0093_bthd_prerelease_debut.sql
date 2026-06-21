-- migrations/0093_bthd_prerelease_debut.sql
--
-- BTHD (비더후드) 데뷔일 잠정 지정 — NULL → 2026-06-26.
-- 운영자 지시 2026-06-21: 2026-06-26 '1st Pre-Release Single' 음원 발매.
-- 선공개 싱글 발매일을 *잠정* 데뷔 앵커로 사용. 정식 데뷔 일자 공개 시
-- 후속 마이그레이션으로 교체 + confidence='high' 승급.
--
-- 0075 (BTHD 시드, debut_date=NULL) 의 후속. 시드 주석에 "공식 발표 시
-- 후속 migration 으로 UPDATE" 로 예고된 작업. confidence='low' 유지 —
-- 자동 알림이 잘못된 D-Day 발화하지 않도록 명시적 신호 (wegosix 0074 패턴).
--
-- 영향 (V2.42 Undated → 실 데뷔 앵커 전환):
--   - debut_window_video_organicity.window_bucket / days_relative_to_debut
--     는 worker cron 의 build_video_organicity 가 다음 실행 시 재계산하며
--     기존 'Undated' 행을 데뷔 기준 D±N 버킷으로 자동 재배치 (V2.49 롤링
--     윈도우). debut_window_organicity_summary 도 build_summary 가 재집계.
--     별도 migration UPDATE 불필요.
--   - DebutWindowKPI 의 pre-debut Undated 배지 → 정상 7-버킷 행으로 전환.
--   - debut_countdown / MiiWANBriefing 등은 MiiWAN 스코프라 무영향.

UPDATE groups
   SET debut_date = '2026-06-26'
 WHERE key = 'bthd';

INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence)
VALUES
  ('bthd', '2026-06-26', 'debut',
   '1st Pre-Release Single 발매 (잠정 데뷔 앵커)',
   '선공개 싱글 음원 발매일을 잠정 데뷔일로 설정. 정식 데뷔 일자 공개 시 후속 마이그레이션으로 갱신 + confidence high 승급.',
   NULL,
   'low');
