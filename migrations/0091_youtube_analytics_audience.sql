-- 0091: 미완소년 소유자 OAuth — 시청자 구성(구독 상태·인구통계) 보강.
--
-- 0087 채널 행의 returning_viewers_30d/membership 은 Analytics API 가 깔끔히
-- 노출하지 않아 NULL 로 남는다. 그 공백을 *실제로 수집 가능한* 두 신호로 메운다:
--
--   subscribed/unsubscribed_watch_share — dimensions=subscribedStatus 리포트.
--       "구독자 vs 비구독 시청 시간 비중" = returning 시청자의 실용 대체재.
--       (조회→구독 후 머무는 코어 vs 신규 유입 비율.)
--   agg_youtube_analytics_demographics  — dimensions=ageGroup,gender 리포트.
--       시청자 연령×성별 분포(viewerPercentage). 굿즈·타겟 코어팬 결정 입력.
--
-- 둘 다 miiwan 전용. best-effort 라 권한·조합 제약 시 NULL/빈 결과 가능.

ALTER TABLE agg_youtube_analytics ADD COLUMN subscribed_watch_share REAL;
ALTER TABLE agg_youtube_analytics ADD COLUMN unsubscribed_watch_share REAL;

CREATE TABLE IF NOT EXISTS agg_youtube_analytics_demographics (
  group_key   TEXT,
  snapshot_at TEXT,
  age_group   TEXT,            -- 'age13-17' | 'age18-24' | ... (API 라벨 그대로)
  gender      TEXT,            -- 'male' | 'female' | 'user_specified'
  viewer_pct  REAL,            -- 0..100, 해당 연령×성별 시청 비중
  PRIMARY KEY (group_key, snapshot_at, age_group, gender)
);
