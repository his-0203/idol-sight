-- migrations/0075_bthd_seed.sql
--
-- V2.35 — BTHD (비더후드) 그룹 시드.
--
-- 새 추적 그룹 추가: BTHD = B THE HOOD = 비더후드. 사용자 요청 2026-05-31.
--
-- 그룹 개요
-- ---------
-- 5인 보이그룹 컨셉의 신생 버추얼 아이돌. 채널 개설 2026-03-09, 첫
-- 티저 영상 'Something’s calling' 2026-05-29 (조회수 ~70K).
-- 데뷔일 / 소속사 / 멤버 라인업 (JACE 1인 제외) 모두 미공개 — 운영자
-- 지시상 '티저만 나온 상황'. group_model='corporate' 로 K-POP 섹션
-- (MarketOverview categoryOf: 'corporate'→'kpop') 편입.
--
-- 세계관: 머나먼 행성 NOVUS → 특수 계급 'HOOD' 5인 → 지구 골든
-- 디스크 신호에 이끌려 지구 도착. JACE 가 첫 신호 감지자. 세계관
-- 단어 (NOVUS / HOOD / 골든디스크) 는 일반어 충돌 위험으로 context_
-- keywords 에 포함하지 않음 (별도 가드 사유는 아래 주석 참조).
--
-- 채널 매핑 (curl + RSS feed 검증)
-- --------------------------------
--   그룹 공식 @official_BTHD → UCzTZLrV5SXJswiV_5muor6Q
--   멤버 솔로 채널: 아직 미공개 (JACE 만 description 에 호명, 채널 ID
--                 미확보) → members row 는 라인업 공개 시점에
--                 후속 migration 으로 추가.
--
-- 디시 갤러리: 미개설 (404 검증 — bthd/bthehood 어느 namespace 에도
-- ----------- 없음). 차후 개설 확인되면 별도 UPDATE.
--   보조 갤러리: vboyband (버추얼 보이그룹 통합갤). BTHD 가 5인 보이
--   그룹이므로 V2.27 패턴 (UR:L 와 동일) 적용. strict_generic_blocklist
--   가드와 함께 동작.
--
-- context_keywords 와 일반어 충돌 가드
-- ------------------------------------
-- 포함 토큰:
--   "BTHD" / "bthd" / "Bthd"  — 4자 영문 약자, SHORT_TOKEN_THRESHOLD=3
--                                 통과, 일반어 충돌 거의 없음
--   "B THE HOOD" / "BTHEHOOD" / "Bthehood" / "bthehood"
--                              — 공식 풀네임 / 해시태그 / 표기 변형
--   "비더후드"                 — 한글 4자, 안전
--   "official_BTHD"            — 공식 핸들
--   "ㅂㄷㅎㄷ"                 — 한글 초성 4자 (V2.30 패턴 답습)
--   "버추얼"                  — 카테고리 토큰 (다른 그룹과 공유, 본
--                                  토큰만으로는 약하지만 보조 매칭에 유용)
--
-- 제외 (일반어 충돌로 위험):
--   "NOVUS" — 라틴어 / 신발 브랜드 (Novus Shoes) / 가구 브랜드 다수
--   "HOOD"  — 후드 (의류) 일반어 충돌 매우 강함, BOYHOOD 등
--                  유사 그룹명도 존재
--   "JACE"  — 동명이인 가수 (2014년 데뷰) + 영문 이름으로 흔함.
--                  멤버 로우로는 시드하지 않고 (소로 채널 미공개),
--                  라인업 공개 시에도 GENERIC_KEYWORD_BLOCKLIST 추가
--                  검토 필요 (별도 커밋).
--
-- 데뷰일 미정
-- ----------
-- groups.debut_date 는 NULL 로 시드. 공식 발표 시 후속 migration 으로
-- UPDATE. Debut Window 관련 분석은 debut_date IS NULL 이면 자동
-- 스킵되므로 안전.

INSERT OR IGNORE INTO groups
  (key, name, name_kr, debut_date, yt_channel_id, group_model, is_active)
VALUES
  ('bthd', 'BTHD', '비더후드', NULL,
   'UCzTZLrV5SXJswiV_5muor6Q', 'corporate', 1);

UPDATE groups
   SET dc_gallery_id = NULL,
       dc_supplemental_galleries = '["vboyband"]',
       naver_query = 'BTHD OR "B THE HOOD" OR 비더후드 OR BTHEHOOD',
       context_keywords = '["BTHD","bthd","Bthd","B THE HOOD","BTHEHOOD","Bthehood","bthehood","비더후드","official_BTHD","ㅂㄷㅎㄷ","버추얼"]',
       blacklist_phrases = '양도,팝니다,[광고],도배,단톡'
 WHERE key = 'bthd';
