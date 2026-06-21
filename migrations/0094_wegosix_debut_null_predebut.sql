-- migrations/0094_wegosix_debut_null_predebut.sql
--
-- wegosix (위고식스) 데뷔일 가안(2026-08-31) 제거 → NULL.
-- 운영자 지시 2026-06-21: 정식 데뷔 일자 확정 전까지 BTHD(V2.42 Undated)
-- 와 동일하게 *pre-debut* organicity 점수를 표시하고 싶다.
--
-- 문제 (placeholder 미래 데뷔일의 부작용)
-- ----------------------------------------
-- 0074 가 넣은 placeholder debut_date='2026-08-31'(여름 데뷔 가안)이
-- 미래라 wegosix 의 모든 영상(529개)이 days_relative_to_debut ≈ -264 →
-- 'Pre' 버킷에 갇힌다. V2.49 롤링 표시창은 anchor(MiiWAN) 기준
-- [D-60..D+60] 7버킷 + Undated 만 노출하므로 'Pre' 는 어느 쪽에도 안 잡혀
-- DebutWindowKPI 에서 wegosix organicity 점수가 통째로 사라진다.
--
-- 해법 (BTHD 가 NULL 이던 시절과 동일 상태로)
-- --------------------------------------------
-- debut_date=NULL → build_video_organicity(debut_window.py)가 영상을
-- 'Undated' 버킷으로 재채점, summary API 가 카드 fetch 에 Undated 를
-- passthrough(V2.42), DebutWindowKPI 가 "pre-debut · N개 영상 · 평균 X점"
-- 배지로 표시. 0074(placeholder) 의 사실상 되돌림 — 정식 데뷔일 공개 시
-- 후속 마이그레이션으로 재입력 + confidence high 승급(0074/0093 패턴).
--
-- 자동 정정 (별도 UPDATE 불필요)
-- ------------------------------
--   - debut_window_video_organicity: video_id PK UPSERT 라 다음
--     organicity cron 이 529 'Pre' 행을 'Undated' 로 덮어씀.
--   - debut_window_organicity_summary: build_summary 가 full DELETE+
--     rebuild(_CLEAR_SUMMARY_SQL) 라 stale (wegosix,'Pre') 요약 자동 제거.
--   - group_events 의 '정식 데뷔 (가안 — 여름 데뷔 …)' 행(0074)은
--     organicity 와 무관한 타임라인 정보라 유지. 정식 데뷔일 확정 시
--     0074 처럼 DELETE→INSERT 로 갱신.

UPDATE groups
   SET debut_date = NULL
 WHERE key = 'wegosix';
