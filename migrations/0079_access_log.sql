-- 0079_access_log.sql
-- 운영자 전용 주간 접속 추적. client_id 는 무작위 UUID(가명) — PII 아님.
CREATE TABLE IF NOT EXISTS access_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))  -- UTC ISO8601
);
CREATE INDEX IF NOT EXISTS idx_access_log_created_at ON access_log(created_at);
CREATE INDEX IF NOT EXISTS idx_access_log_client_id  ON access_log(client_id);
