-- migrations/0068_wegosix_members_lineup_update.sql
--
-- V2.32 — WE GO-6 (wegosix) 멤버 라인업 재설정.
--
-- 배경
-- ----
-- 0034 (2026-05-06) 시드 시점 5인 (시우 / 해일 / 산호 / 진휘 / 우연).
-- 2026-05-26 운영자 확인: 현재 활동 멤버는 5명이지만 구성이 변경됨.
--
-- 외부 검증
-- ---------
--   kprofiles.com/we-go-6-members-profile/ —
--     Current Members: Xiu (Leader), Wooyeon, Taegang, Kuta (Maknae)
--     Former Members:  Jinhwi, Hale, Sanho
--   디시 wegosix 마이너 갤러리 (2026-05-26 확인) — 우연/쿠우타/제로
--     멤버 언급 게시글 다수.
--   운영자 (2026-05-26): Zero 도 활동 멤버로 포함, 총 5명.
--
-- 변경
-- ----
--   유지 (active=1):
--     시우  (Xiu, id=49) — Leader
--     우연  (Wooyeon, id=53)
--   완전 삭제 (운영자 지시: "실제 쓰지 않는 멤버들은 삭제"):
--     해일  (Hale, id=50)
--     산호  (Sanho, id=51)
--     진휘  (Jinhwi, id=52)
--   신규 (INSERT, active=1):
--     쿠우타 (Kuta)   — Maknae
--     제로  (Zero)
--     태강  (Taegang)
--
-- 옛 멤버 데이터 정리
-- -------------------
-- members 행 DELETE 시 agg_member_popularity 의 같은 member_id row 는
-- soft FK (REFERENCES 선언 없음) 라 orphan 으로 남는다. frontend
-- /api/members/[key].ts 가 `JOIN members m ON m.id = mp.member_id` 로
-- 묶기 때문에 orphan row 는 자동으로 응답에서 빠지지만, 통계 합산
-- (SUM/AVG) 에서 잘못 계산될 수 있다. 명시적으로 historical row 도
-- 함께 정리.
--
-- context_keywords (한국어 + 영어 둘 다 감지 — 운영자 지시)
-- ----------------------------------------------------------
-- 옛 멤버 (해일/산호/진휘) 제거. 새 멤버는 한글 + 영문 둘 다 시드:
--   시우 / Xiu, 우연 / Wooyeon, 쿠우타 / 쿠타 / Kuta / Kuuta,
--   제로 / Zero, 태강 / Taegang.
--
-- ★ "Zero" 영문은 일반어 충돌 위험 (zero gravity / waste / sum 등) 이
--   매우 큰 토큰. relevance.py 의 GENERIC_KEYWORD_BLOCKLIST 에 "Zero"
--   추가 (별도 커밋 — V2.32 핵심 변경) 로 strict_generic_blocklist=True
--   인 DcCollector supplemental fetch 에서는 anchor (위고식스/WE GO-6)
--   동반 시에만 매치. wegosix primary 갤러리 fetch 는 그룹 컨텍스트
--   안이라 false positive 영향 최소.

DELETE FROM agg_member_popularity
 WHERE member_id IN (
   SELECT id FROM members
    WHERE group_key = 'wegosix' AND name IN ('해일', '산호', '진휘')
 );

DELETE FROM members
 WHERE group_key = 'wegosix' AND name IN ('해일', '산호', '진휘');

INSERT INTO members (group_key, name, name_en, yt_channel_id, active) VALUES
  ('wegosix', '쿠우타', 'Kuta',    NULL, 1),
  ('wegosix', '제로',  'Zero',    NULL, 1),
  ('wegosix', '태강', 'Taegang', NULL, 1);

UPDATE groups
   SET context_keywords = '["23rd Century Kids","wegosix","위고식스","WE GO-6","WEGO6","WeGoSix","WEGOSIX","Wegosix","WE GO 6","WeGo6","wego6","we go six","WE GO SIX","위고6","ㅇㄱㅅㅅ","시우","Xiu","우연","Wooyeon","쿠우타","쿠타","Kuta","Kuuta","제로","Zero","태강","Taegang"]'
 WHERE key = 'wegosix';
