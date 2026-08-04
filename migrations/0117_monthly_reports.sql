-- migrations/0117_monthly_reports.sql
--
-- 월간 보고서 덱 저장소. 매월 1일 cron(monthly-report.yml)이 전월 덱을
-- 내부판/투자사판 2벌 생성해 자립 HTML 로 저장한다 — 요청 시 동적 생성이
-- 아니라 사전 렌더+동결(이 리포는 소급 정정이 일상이라, 보고서는 생성
-- 시점 스냅샷이어야 함). 크기는 D1 REST 바디 한계(d1.py 주석 ~1MB)를
-- 고려해 커맨드가 800KB fail-fast 가드를 건다. base64 이미지 금지.
-- 스펙: docs/superpowers/specs/2026-08-04-monthly-report-design.md
CREATE TABLE IF NOT EXISTS monthly_reports (
  month        TEXT NOT NULL,          -- 'YYYY-MM' (보고 대상 월)
  edition      TEXT NOT NULL,          -- 'internal' | 'investor'
  generated_at TEXT NOT NULL,
  html         TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  meta_json    TEXT,                   -- {"draft": bool, "warnings": [...]}
  PRIMARY KEY (month, edition)
);
