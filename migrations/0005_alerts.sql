-- 0005_alerts.sql — alert dedup ledger.
--
-- The alert engine fires on threshold crossings (debut milestones,
-- viral video velocity, controversy spikes …). Without dedup, every
-- hourly run would re-fire the same MiiWAN D-30 alert. We record each
-- (alert_key, fired_at) tuple so the engine can refuse to re-emit a
-- key that fired within its cooldown window.
--
-- alert_key shape:
--   "<rule>:<scope>:<bucket>"
--   e.g. "debut_milestone:miiwan:D-30"
--        "video_velocity_24h:plave:abcd1234"
--        "controversy_spike:isedol:2026-W18"
--
-- scope is informational (group_key or 'market'); bucket is the part
-- that distinguishes one firing from another (debut bucket, video id,
-- ISO week, etc.). We don't try to model that structure in DDL — the
-- engine constructs alert_key strings.

CREATE TABLE alerts (
  alert_key   TEXT PRIMARY KEY,
  rule        TEXT NOT NULL,
  scope       TEXT,
  severity    TEXT,
  title       TEXT,
  body        TEXT,
  fired_at    TEXT NOT NULL
);

CREATE INDEX idx_alerts_fired_at ON alerts(fired_at);
CREATE INDEX idx_alerts_rule_scope ON alerts(rule, scope);
