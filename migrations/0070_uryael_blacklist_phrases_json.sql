-- migrations/0070_uryael_blacklist_phrases_json.sql
--
-- V2.33.1 — UR:L (uryael) blacklist_phrases CSV → JSON 배열 정정.
--
-- 0069 시드에서 blacklist_phrases 를 CSV 문자열 ('양도,팝니다,...') 로
-- 넣었으나 config.py 가 `json.loads()` 로 파싱 → 첫 collect 즉시
-- JSONDecodeError. 다른 그룹 (V2.30 이후) 은 JSON 배열 형식이고
-- 0034 wegosix 의 원본 CSV 도 0064 에서 JSON 으로 마이그레이션됨.
-- 0069 작성 시 0034 의 *원본* SQL 만 참고해 패턴이 잘못 복제됨.
--
-- 본 마이그레이션은 단일 UPDATE — 0069 의 SQL 텍스트 자체는 그대로
-- 두고 (immutable migrations 원칙) 새 행을 통해 컬럼 값만 교정.

UPDATE groups
   SET blacklist_phrases = '["양도","팝니다","[광고]","도배","단톡","어그로"]'
 WHERE key = 'uryael';
