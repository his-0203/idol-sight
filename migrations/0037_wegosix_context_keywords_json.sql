-- migrations/0037_wegosix_context_keywords_json.sql
--
-- 0034 의 wegosix context_keywords / blacklist_phrases 를 콤마-string
-- 으로 시드했는데, 워커 _load_group 은 json.loads() 로 파싱 → JSON array
-- 형식만 받음. 다른 그룹과 동일한 JSON array 표기로 정정.
--
-- backfill-yt-videos --group wegosix 가 _load_group 단계에서
-- JSONDecodeError 로 raise → 영상 인덱싱 실패. 정정 후 재dispatch
-- 하면 정상 walked.

UPDATE groups
   SET context_keywords = '["23rd Century Kids","wegosix","위고식스","WE GO-6","WEGO6","시우","해일","산호","진휘","우연"]',
       blacklist_phrases = '["양도","팝니다","[광고]","도배"]'
 WHERE key = 'wegosix';
