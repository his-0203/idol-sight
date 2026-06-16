-- 0087: 미완소년 소유자 OAuth(YouTube Analytics) 적재 테이블.
--
-- 공개 API 키(YT_API_KEY)로는 못 보는 소유자 전용 지표를 담는다. 미완소년
-- 채널에만 적용 (다른 그룹은 OAuth 없음 → 행이 생기지 않음). DECISION 탭의
-- 해외진출/굿즈 보드가 이 테이블에서 읽는다 (functions/api/miiwan.ts).
--
-- 두 grain:
--   agg_youtube_analytics          — 채널 단위 (재방문/멤버십/슈퍼챗)
--   agg_youtube_analytics_country  — 국가 단위 (해외진출 점수의 4축 입력)
--
-- 주의: YouTube Analytics API가 '재방문 시청자수'·'멤버십 가입자수'를 깔끔히
-- 노출하지 않으므로 returning_viewers_30d / membership_count 는 NULL 일 수
-- 있다 (그 경우 수요하한 보드는 '연결 대기' 유지). 국가 지표는 항상 채운다.

CREATE TABLE IF NOT EXISTS agg_youtube_analytics (
  group_key             TEXT,
  snapshot_at           TEXT,
  returning_viewers_30d INTEGER,   -- nullable (API 미노출 시)
  membership_count      INTEGER,   -- nullable
  membership_penetration REAL,     -- membership_count / subscribers, nullable
  has_super_chat        INTEGER,   -- 0/1, nullable
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE TABLE IF NOT EXISTS agg_youtube_analytics_country (
  group_key     TEXT,
  snapshot_at   TEXT,
  country       TEXT,              -- ISO-3166 alpha-2 (e.g. 'JP', 'KR')
  watch_share   REAL,              -- 0..1, 전체 시청시간 중 비중
  growth_mom    REAL,              -- 소수, 직전 30일 대비 시청시간 증감
  retention_rel REAL,              -- 국가 평균시청률 / 국내(KR) 평균시청률
  sub_per_1k    REAL,              -- 1k 조회당 구독 증가
  PRIMARY KEY (group_key, snapshot_at, country)
);
