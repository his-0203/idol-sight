-- migrations/0078_bthd_blacklist_json_fix.sql
--
-- 0075 회귀 수정 — bthd.blacklist_phrases 가 JSON 배열이 아니라 쉼표구분
-- 평문('양도,팝니다,[광고],도배,단톡')으로 시드되어, cli.py 의
-- _load_group 이 GroupConfig 로 파싱할 때 json.loads() 가 JSONDecodeError
-- (Expecting value: char 0) 로 죽었다. → bthd 의 모든 작업(backfill /
-- collect 등 GroupConfig 를 로드하는 전부)이 실패.
--
-- groups 의 *_phrases / *_keywords / *_galleries / *_boards / twitter_handles
-- 컬럼은 모두 JSON 배열 텍스트여야 한다(cli.py:228~ json.loads). 다른 그룹은
-- 정상(예: bdawn 0064 는 '["양도","팝니다",...]'). bthd 만 0075 시드 실수.
--
-- 발견: 2026-06-04 backfill-yt-videos bthd run 26929285266 실패 분석.

UPDATE groups
   SET blacklist_phrases = '["양도","팝니다","[광고]","도배","단톡"]'
 WHERE key = 'bthd';
