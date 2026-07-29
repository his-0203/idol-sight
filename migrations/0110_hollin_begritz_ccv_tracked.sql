-- migrations/0110_hollin_begritz_ccv_tracked.sql
--
-- 0104 에서 hollin·begritz 를 전역 시드할 때 ccv_tracked 세팅이 누락됐다
-- (0084 의 "corporate 전부" UPDATE 는 0104 이전이라 두 그룹을 알 수 없었다).
-- 채널 ID 는 이미 등록돼 있으므로 플래그만 켜면 다음 collect-ccv 런부터
-- 수집된다 — 데뷔 전(hollin 2026-09-01 · begritz 2026-08 론칭)이지만
-- bthd·wegosix 전례대로 데뷔 전 베이스라인을 지금부터 쌓는다.
-- segmentary(isedol·stellive·uryael) 제외 정책은 그대로다.
UPDATE groups SET ccv_tracked=1 WHERE key IN ('hollin','begritz');
