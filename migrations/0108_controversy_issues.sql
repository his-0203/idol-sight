-- migrations/0108_controversy_issues.sql
--
-- V2.55 Controversy Issue Dedup + Cap — 이슈 단위 dedup 결과 저장 테이블.
-- V2.54 감점이 이슈 심각도가 아니라 커뮤니티 볼륨(글 N건)에 비례하던 구조
-- 결함을 교정한다. analyze_weekly 가 그룹별 14일 윈도우 controversy 글을
-- Gemini 로 실제 사건 단위 이슈로 묶고(analysis/controversy_issues.py),
-- Σ severity weight 를 effective_weight 로 여기에 저장한다. health 산식 v3
-- (_controversy_factor) 이 이 weight 를 읽어 max(0.6, 1 - weight/10) 으로
-- 감점 — count 기반 폴백은 테이블 미적용/행 없음/computed_at stale 일 때만.
-- 그룹당 최신 1행만 유지(replace) — 히스토리 불필요. 글 0건 그룹은 행 DELETE.
-- Additive: 기존 집계·crisis alert·negative_ratio 로직 전부 불변.

CREATE TABLE IF NOT EXISTS controversy_issues (
  group_key       TEXT PRIMARY KEY REFERENCES groups(key),
  computed_at     TEXT NOT NULL,
  issue_count     INTEGER NOT NULL DEFAULT 0,
  effective_weight REAL NOT NULL DEFAULT 0,
  issues_json     TEXT
);
