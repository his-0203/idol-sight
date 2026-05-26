-- migrations/0069_uryael_seed.sql
--
-- V2.33 — UR:L (유아렐) 그룹 시드.
--
-- 새 추적 그룹 추가: UR:L (유아렐). 사용자 요청 2026-05-26.
--
-- 그룹 개요
-- ---------
-- 샌드박스네트워크의 첫 버추얼 아이돌 프로젝트. 4인 보컬 그룹. 공개
-- 오디션 등을 통해 선발된 모카 / 랑코 / 마냥 / 솜먕 으로 구성. 오리지널
-- 3D 아바타는 언리얼 엔진 기반. 2025-12-31 첫 싱글 'Chemical Love' /
-- 수록곡 'Again' 발매 → 멜론 Hot100 7위 / 9위, 멜론 검색어 1위 기록.
-- 2026 연간 프로젝트 '사계(四季)': 5월 봄 / 8월 여름 / 10월 가을 /
-- 12월 겨울 음원 발매 + 12월 단독 온라인 콘서트.
--
-- 그룹 모델: segmentary (subculture cohort)
-- ---------------------------------------
-- 샌드박스네트워크 소속이지만 4인 모두 인디/스트리머 출신 보컬을 회사가
-- collective 로 묶은 형태. ISEDOL/STELLIVE 의 segmentary 패턴과 일치
-- (개인 인지도 누적 + 회사 운영 결합). corporate (PLAVE/MiiWAN 등) 의
-- 신생 audition-debut 모델과 변별. weekly_diagnosis_signals._category_of
-- 매핑에서 'subculture' cohort 로 들어가 ISEDOL/STELLIVE 와 z-score
-- 비교 (cohort=2 → 3, 변별력 일부 회복).
--
-- 채널 매핑 (curl 메타 추출 검증)
-- ------------------------------
--   그룹 공식 @URL-유아렐  → UCLAA9TKj-EYf2RUl1gLB9pQ
--   모카   @mocamu2       → UCiQ3nmup_0jgUOnZ_MQcwKQ
--   랑코   @1langkko      → UCZeHbW3Ifpn4gz9x6OY07JQ
--   마냥   @마냥          → UCtoHqh381tZlGSmPITK45Lw
--   솜먕   @myang0315     → UCs7qFfGz4UUy4y2GyU8BpAQ  (SOMMYANG)
--
-- 디시 갤러리: sandboxurl (MINI 갤러리)
-- ------------------------------------
-- 일반 board/mgallery 가 아닌 /mini/ namespace. DcCollector V2.33 의
-- _fetch_list_with_fallback 가 /board/ → /mini/ fallback 처리.
-- 보조 갤러리: vboyband (버추얼 보이그룹 통합갤) — 본 그룹은 보컬
-- 4인 (혼성 아님, 한국어 컨텍스트상 일반어 충돌이 큼) 이므로 strict_
-- generic_blocklist=True 가드가 필수.
--
-- context_keywords 와 일반어 충돌 가드
-- ------------------------------------
-- "URL" / "url" — IT 용어 일반어 충돌 (모든 링크 메시지에 등장).
-- "마냥" — 부사 ("마냥 좋다") 일반어 충돌.
-- "모카" — 음료 (커피 모카) 일반어 충돌.
-- 세 토큰 모두 relevance.py GENERIC_KEYWORD_BLOCKLIST 추가 (별도 커밋)
-- 로 strict 모드 (DcCollector supplemental) 에서 anchor-required.
-- primary (sandboxurl) fetch 는 group-scoped 이라 영향 없음.

INSERT OR IGNORE INTO groups
  (key, name, name_kr, debut_date, yt_channel_id, group_model, is_active)
VALUES
  ('uryael', 'UR:L', '유아렐', '2025-12-31',
   'UCLAA9TKj-EYf2RUl1gLB9pQ', 'segmentary', 1);

UPDATE groups
   SET dc_gallery_id = 'sandboxurl',
       dc_supplemental_galleries = '["vboyband"]',
       naver_query = '유아렐 OR "UR:L" OR uryael OR "URL유아렐"',
       context_keywords = '["UR:L","url","URL","Url","유아렐","uryael","Uryael","URL유아렐","url-유아렐","URL-유아렐","사계","Chemical Love","샌드박스네트워크","SandboxNetwork","모카","Mocha","mocamu","Mocamu","mocamu2","랑코","Rangko","langkko","1langkko","llangkko","마냥","Manyang","manyang","솜먕","Sommyang","SOMMYANG","myang","myang0315","ㅇㅇㄹ","ㅇㅇㄹㅎ","버추얼"]',
       blacklist_phrases = '양도,팝니다,[광고],도배,단톡'
 WHERE key = 'uryael';

INSERT OR IGNORE INTO members (group_key, name, name_en, yt_channel_id, active) VALUES
  ('uryael', '모카',  'Mocha',    'UCiQ3nmup_0jgUOnZ_MQcwKQ', 1),
  ('uryael', '랑코',  'Rangko',   'UCZeHbW3Ifpn4gz9x6OY07JQ', 1),
  ('uryael', '마냥',  'Manyang',  'UCtoHqh381tZlGSmPITK45Lw', 1),
  ('uryael', '솜먕',  'Sommyang', 'UCs7qFfGz4UUy4y2GyU8BpAQ', 1);
