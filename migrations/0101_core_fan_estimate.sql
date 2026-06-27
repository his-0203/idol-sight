-- 0101_core_fan_estimate.sql — 전 그룹 추정 코어팬 (MarketOverview 참고용).
--
-- 동기:
--   P2a의 estimate_video_engagement(좋아요/댓글 median per video) 산식을 전 그룹으로
--   확대한다. youtube_video_stats 재가공 — 신규 수집 0, 산식 불변. MiiWAN의 라이브
--   측정 코어와는 다른 축(추정). MarketOverview 카드 참고 표기 전용 — 그룹 간
--   정렬/순위 지표가 아님.
--
--   agg_core_fan_estimate — (group_key, snapshot_at) PK:
--   build_core_fan_estimate 가 스냅샷별 멱등 쓰기
--   (DELETE FROM agg_core_fan_estimate WHERE snapshot_at=? 후 INSERT).
--   과거 스냅샷은 보존해 시계열을 남긴다.

CREATE TABLE IF NOT EXISTS agg_core_fan_estimate (
  group_key        TEXT NOT NULL,
  snapshot_at      TEXT NOT NULL,
  est_engaged_fans INTEGER,         -- median likes per video, round 정수화 (insufficient면 NULL)
  est_active_core  INTEGER,         -- median comments per video, round 정수화 (insufficient면 NULL)
  like_rate        REAL,            -- median(likes/views), views=0 영상 제외 (insufficient면 NULL)
  comment_rate     REAL,            -- median(comments/views), views=0 영상 제외 (insufficient면 NULL)
  video_count      INTEGER,         -- 산정에 사용한 영상 수
  basis            TEXT NOT NULL,   -- 'scored' | 'insufficient'
  generated_at     TEXT NOT NULL,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_cfe_snapshot ON agg_core_fan_estimate (snapshot_at);
