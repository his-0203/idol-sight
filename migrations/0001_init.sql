-- 0001_init.sql — IDOL-SIGHT initial schema (spec §5.2)

-- ─── 마스터 ──────────────────────────────────────
CREATE TABLE groups (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_kr TEXT NOT NULL,
  debut_date TEXT,
  yt_channel_id TEXT,
  dc_gallery_id TEXT,
  naver_query TEXT,
  context_keywords TEXT,
  blacklist_phrases TEXT,
  twitter_handles TEXT,
  is_active INTEGER DEFAULT 1
);

CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  name TEXT,
  name_en TEXT,
  yt_channel_id TEXT,
  active INTEGER DEFAULT 1
);

-- ─── 원천: YouTube ──────────────────────────────
CREATE TABLE youtube_videos (
  video_id TEXT PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  channel_id TEXT,
  title TEXT,
  duration_sec INTEGER,
  published_at TEXT,
  content_type TEXT,
  is_short INTEGER DEFAULT 0,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE youtube_video_stats (
  video_id TEXT REFERENCES youtube_videos(video_id),
  snapshot_at TEXT NOT NULL,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  PRIMARY KEY (video_id, snapshot_at)
);

CREATE TABLE youtube_channel_stats (
  channel_id TEXT,
  snapshot_at TEXT,
  subscribers INTEGER,
  total_views INTEGER,
  video_count INTEGER,
  PRIMARY KEY (channel_id, snapshot_at)
);

-- ─── 원천: 뉴스 ─────────────────────────────────
CREATE TABLE naver_articles (
  url_hash TEXT PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  title TEXT,
  source TEXT,
  url TEXT,
  published_at TEXT,
  is_excluded INTEGER DEFAULT 0,
  exclude_reason TEXT,
  collected_at TEXT NOT NULL
);

-- ─── 원천: 커뮤니티 (통합) ─────────────────────
CREATE TABLE community_posts (
  url_hash TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  group_key TEXT REFERENCES groups(key),
  title TEXT,
  url TEXT,
  posted_at TEXT,
  collected_at TEXT NOT NULL
);

CREATE TABLE community_post_stats (
  url_hash TEXT,
  snapshot_at TEXT,
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  PRIMARY KEY (url_hash, snapshot_at)
);

CREATE TABLE community_keywords (
  group_key TEXT,
  snapshot_at TEXT,
  keyword TEXT,
  count INTEGER,
  PRIMARY KEY (group_key, snapshot_at, keyword)
);

-- ─── 원천: 트위터 ──────────────────────────────
CREATE TABLE twitter_posts (
  tweet_id TEXT PRIMARY KEY,
  group_key TEXT REFERENCES groups(key),
  author_handle TEXT,
  title TEXT,
  url TEXT,
  posted_at TEXT,
  collected_at TEXT,
  type TEXT
);

-- ─── 원천: 한터 ───────────────────────────────
CREATE TABLE hanteo_weekly (
  week_start TEXT,
  week_end TEXT,
  group_key TEXT REFERENCES groups(key),
  album TEXT,
  rank INTEGER,
  sales INTEGER,
  note TEXT,
  PRIMARY KEY (week_start, group_key, album)
);

-- ─── 집계 ───────────────────────────────────────
CREATE TABLE agg_summary (
  group_key TEXT,
  snapshot_at TEXT,
  yt_total_videos INTEGER,
  yt_total_views INTEGER,
  yt_subscribers INTEGER,
  dc_total_posts INTEGER,
  theqoo_posts INTEGER,
  instiz_posts INTEGER,
  naver_total_news INTEGER,
  twitter_posts INTEGER,
  controversy_count INTEGER,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE TABLE agg_health_scores (
  group_key TEXT,
  snapshot_at TEXT,
  total REAL,
  raw_total REAL,
  grade TEXT,
  label TEXT,
  breakdown_json TEXT,
  bonus_json TEXT,
  quality_method TEXT,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE TABLE agg_market_share (
  week_start TEXT,
  week_end TEXT,
  group_key TEXT,
  cum REAL,
  mom REAL,
  final REAL,
  market_total INTEGER,
  PRIMARY KEY (week_start, group_key)
);

CREATE TABLE agg_member_popularity (
  group_key TEXT,
  snapshot_at TEXT,
  member_id INTEGER,
  yt_score REAL,
  community_score REAL,
  composite_score REAL,
  yt_videos INTEGER,
  yt_avg_views INTEGER,
  yt_sufficient INTEGER,
  community_mentions INTEGER,
  PRIMARY KEY (group_key, snapshot_at, member_id)
);

CREATE TABLE agg_member_pop_meta (
  group_key TEXT,
  snapshot_at TEXT,
  hhi REAL,
  evenness REAL,
  status TEXT,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE TABLE insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT,
  week_start TEXT,
  scope TEXT,
  type TEXT,
  title TEXT,
  body TEXT,
  source_refs_json TEXT
);

-- ─── 운영 메타 ──────────────────────────────
CREATE TABLE crawl_meta (
  job TEXT PRIMARY KEY,
  group_key TEXT,
  source TEXT,
  expected_interval_h INTEGER,
  last_attempt_at TEXT,
  last_success_at TEXT,
  status TEXT,
  error_msg TEXT,
  runtime_ms INTEGER,
  rows_inserted INTEGER,
  rows_updated INTEGER
);

CREATE TABLE selectors_cache (
  site TEXT,
  selector_key TEXT,
  serialized TEXT,
  updated_at TEXT,
  PRIMARY KEY (site, selector_key)
);

CREATE INDEX idx_yt_video_group ON youtube_videos(group_key);
CREATE INDEX idx_naver_group_date ON naver_articles(group_key, published_at);
CREATE INDEX idx_comm_platform_group_date ON community_posts(platform, group_key, posted_at);
CREATE INDEX idx_comm_stats_snap ON community_post_stats(snapshot_at);
CREATE INDEX idx_summary_snap ON agg_summary(snapshot_at);
CREATE INDEX idx_health_snap ON agg_health_scores(snapshot_at);
