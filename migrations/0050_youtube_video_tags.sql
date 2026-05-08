-- 0050_youtube_video_tags.sql — youtube_videos.tags 컬럼 추가.
--
-- YouTube Data API v3 `videos.list?part=snippet` 응답의 `snippet.tags`
-- (영상 태그 배열) 와 `snippet.description` 안 `#해시태그` 를 통합 추출해
-- JSON array literal 로 저장한다. 예: '["miiwan","마하진","kpop"]'.
--
-- 스코프: MiiWAN 공식 채널 (`group_key='miiwan'`) 영상에 한해서만 채워진다.
-- 다른 그룹 row 는 NULL 유지 — collector 가 group.key 기준으로 분기.
-- 윤리 가이드라인 §4 (자사 그룹 위주 깊이, 경쟁사는 외형만) 에 따른 의도된
-- 비대칭. 후속 캠페인 트렌딩 / 빈도 분석은 별도 모듈에서 수행.
--
-- 빈 배열은 NULL 로 저장 — 분석 쿼리에서 `WHERE tags IS NOT NULL` 단순화.
--
-- Backfill: `backfill-yt-videos --group miiwan` 1회 재실행 시 collector 의
-- ON CONFLICT(video_id) UPDATE tags=excluded.tags 경로로 과거 영상 소급 보완.

ALTER TABLE youtube_videos ADD COLUMN tags TEXT;
