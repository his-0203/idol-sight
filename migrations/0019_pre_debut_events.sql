-- migrations/0019_pre_debut_events.sql
-- 0017의 historical event seed에서 빠진 항목 보충:
--   PLAVE  — 멤버 5명 개별 공개 (member_reveal)
--   MYRAKL — D-30 buildup (리서치 결과: 영문/한문 매체 모두에서 데뷔 전 정확한
--             이벤트 일자를 회수하지 못함 → 안전하게 행 생성 생략, 아래 주석 참고)
--
-- 리서치 출처 (2026-05-06):
--   PLAVE 멤버 공개일: kprofiles.com/plave-members-profile/,
--     kprofiles.com/hamin-plave-profile-and-facts/,
--     kprofiles.com/yejun-plave-profile-and-facts/
--   각 멤버 라이브 방송 공개 — kpop.fandom.com/wiki/PLAVE 도 동일 일자 수록
--
-- PLAVE 멤버 공개 메커니즘:
--   VLAST는 데뷔 전 공식 유튜브/트위치 라이브를 통해 멤버를 1명씩 순차 공개.
--   0017에 이미 2022-09-15 pre_debut('공식 유튜브/트위치 첫 라이브 방송') 존재.
--   예준 공개는 같은 날이지만 event_type=member_reveal + 다른 title로 별도 행 추가.
--   UNIQUE INDEX: (group_key, event_date, title) — 충돌 없음.
--
-- MYRAKL D-30 빌드업 리서치 결과:
--   시도한 출처: kprofiles.com, kpopping.com, topcelev.news, allkpop.com,
--     17caratkpop.substack.com, koreatimes.co.kr, sports.khan.co.kr,
--     youtube.com/@myrakl_official, kpop-groups-that-debuted-2025-2026 목록
--   결론: 어느 출처에서도 데뷔 전(2026-01-26 이전) 특정 일자(발표/멤버공개/쇼케이스/티저)
--     가 기록된 기사를 확인하지 못함. 멤버 개별 공개 일자 불명. Anti-fabrication rule에
--     따라 MYRAKL 행 전체 생략.

-- ─── INSERT OR IGNORE 단일 블록 ───────────────────────────────────────
-- (INSERT OR IGNORE는 UNIQUE INDEX 충돌 시 무시 — 재실행 안전)

INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence)
VALUES
  -- ── PLAVE 멤버 개별 공개 (member_reveal) ─────────────────────────
  -- 예준(Yejun) — 2022-09-15, PLAVE 첫 라이브 방송 당일 1호 멤버 공개
  ('plave', '2022-09-15', 'member_reveal', '예준(Yejun) 멤버 공개',
    '1호 멤버. 공식 유튜브/트위치 라이브로 첫 공개.',
    'https://kprofiles.com/yejun-plave-profile-and-facts/',
    'high'),

  -- 노아(Noah) — 2022-09-29
  ('plave', '2022-09-29', 'member_reveal', '노아(Noah) 멤버 공개',
    '2호 멤버.',
    'https://kprofiles.com/plave-members-profile/',
    'high'),

  -- 밤비(Bamby) — 2022-10-20
  ('plave', '2022-10-20', 'member_reveal', '밤비(Bamby) 멤버 공개',
    '3호 멤버.',
    'https://kprofiles.com/plave-members-profile/',
    'high'),

  -- 은호(Eunho) — 2022-11-14
  ('plave', '2022-11-14', 'member_reveal', '은호(Eunho) 멤버 공개',
    '4호 멤버.',
    'https://kprofiles.com/plave-members-profile/',
    'high'),

  -- 하민(Hamin) — 2023-01-16 (5인 라인업 완성)
  ('plave', '2023-01-16', 'member_reveal', '하민(Hamin) 멤버 공개',
    '5호 멤버(막내). 5인 라인업 확정.',
    'https://kprofiles.com/hamin-plave-profile-and-facts/',
    'high');

-- ── MYRAKL D-30 빌드업 행 없음 ───────────────────────────────────────
-- 리서치에서 데뷔 전 이벤트 일자를 확인할 수 있는 출처를 발견하지 못했으므로
-- Anti-fabrication rule에 따라 행을 생성하지 않음.
-- 추후 공식 ACCORD Entertainment 보도 자료 또는 MYRAKL 공식 SNS 아카이브에서
-- 확인되는 경우 migration 0020에서 추가할 것.
