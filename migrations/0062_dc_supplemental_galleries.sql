-- migrations/0062_dc_supplemental_galleries.sql — V2.27
--
-- DC 보조 수집 채널 도입.
--
-- 배경
--   기존 DcCollector 는 group.dc_gallery_id 하나만 fetch 한다 (1:1 매핑).
--   그러나 MiiWAN 처럼 데뷔 전 그룹은 자기 마이너 갤러리(개설 직후라
--   트래픽 적음) 외에도 'vboyband' 같은 버추얼 보이그룹 통합갤에서
--   PLAVE / B:DAWN 과 함께 자주 언급된다. 1:1 매핑 구조에서는 통갤
--   언급이 영원히 누락된다.
--
-- 해결
--   groups 테이블에 'dc_supplemental_galleries' TEXT(JSON 배열) 컬럼을
--   추가하고, DcCollector 가 primary fetch 후 supplemental 각각에 대해
--   추가 fetch + is_relevant 필터링을 적용하도록 확장(V2.27 코드 변경
--   동반). 통갤 결과는 그룹 무관 글이 다수이므로 반드시 키워드 필터
--   필수, primary 결과는 종전대로 필터 없음.
--
-- 초기값
--   MiiWAN 만 ["vboyband"] 로 설정. 다른 버추얼 보이그룹 (PLAVE,
--   B:DAWN) 도 vboyband 적용 가치는 있으나, 두 그룹은 자체 mgallery
--   트래픽이 충분하므로 일단 보류. 운영자 판단으로 별도 마이그레이션
--   추가 시 확장 가능.
--
-- 영향 / 비용
--   - DC fetch 횟수: MiiWAN 만 2회(기존 1회). collect-6h 잡 시간 +10s.
--   - community_posts/stats 스키마 변화 없음 (platform='dc' 그대로).
--   - 중복은 DcCollector 가 url_hash 기준 dedupe.
--   - frontend api/groups.ts 는 명시 컬럼만 SELECT 하므로 영향 없음.
--
-- Rollback
--   UPDATE groups SET dc_supplemental_galleries = NULL;
--   -- SQLite 에서 DROP COLUMN 은 3.35+ 부터 지원. 컬럼 자체 제거가
--   -- 필요하면 별도 마이그레이션으로 처리.

ALTER TABLE groups ADD COLUMN dc_supplemental_galleries TEXT;

UPDATE groups
   SET dc_supplemental_galleries = '["vboyband"]'
 WHERE key = 'miiwan';
