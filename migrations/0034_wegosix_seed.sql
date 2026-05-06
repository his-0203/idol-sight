-- migrations/0034_wegosix_seed.sql
--
-- 새 추적 그룹 추가: WE GO-6 (위고식스, wegosix). 사용자 요청 2026-05-06.
--
-- 23rd Century Kids 가 제작한 6인 버추얼 보이그룹 (pre-debut). 공식
-- 핸들 @wegosix (YouTube/X/Instagram). 정규 데뷔일 미확정 → debut_date
-- NULL (MiiWAN 와 다르게 일자 미공개 상태).
--
-- group_model: corporate (PLAVE / MiiWAN 와 같은 회사 주도형 K-POP).
-- yt_channel_id: UCd1vuUixEPTfyiBdINt7UWA (handle @wegosix 에서 회수).
--
-- Members (announced 2026-05 기준 5명, 6번째 미공개):
--   1. Xiu (시우) - 리더
--   2. Hale (해일)
--   3. Sanho (산호)
--   4. Jinhwi (진휘)
--   5. Wooyeon (우연)
-- 멤버별 솔로 채널 yt_channel_id 는 미시드 — confirmed handle 확보 후
-- 후속 마이그레이션에서 업데이트.

INSERT OR IGNORE INTO groups
  (key, name, name_kr, debut_date, yt_channel_id, group_model, is_active)
VALUES
  ('wegosix', 'WE GO-6', '위고식스', NULL,
   'UCd1vuUixEPTfyiBdINt7UWA', 'corporate', 1);

-- naver_query / context_keywords 는 검색 정확도 위해 채워둠. 한글
-- 명칭이 짧고 일반 단어 ("위고", "위고식스") 라 anchor co-occurrence
-- 패턴 (V2.6 relevance gate) 으로 false positive 방지.
UPDATE groups
   SET naver_query = '위고식스 OR "WE GO-6" OR wegosix',
       context_keywords = '23rd Century Kids,wegosix,위고식스,WE GO-6,WEGO6,시우,해일,산호,진휘,우연',
       blacklist_phrases = '양도,팝니다,[광고],도배'
 WHERE key = 'wegosix';

INSERT OR IGNORE INTO members (group_key, name, name_en, yt_channel_id, active) VALUES
  ('wegosix', '시우',  'Xiu',     NULL, 1),
  ('wegosix', '해일',  'Hale',    NULL, 1),
  ('wegosix', '산호',  'Sanho',   NULL, 1),
  ('wegosix', '진휘',  'Jinhwi',  NULL, 1),
  ('wegosix', '우연',  'Wooyeon', NULL, 1);
