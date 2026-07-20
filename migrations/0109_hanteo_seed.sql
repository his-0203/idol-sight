-- migrations/0109_hanteo_seed.sql
--
-- V2.56 — 웹 검증된 초동(첫 주 음반 판매량) 시드. hanteo_weekly 는 이전까지
-- 프로덕션 0행이었다(hanteo_standing_value 는 빈 입력 → {}, health_score.py
-- §RitualVictory hanteo_n 이 항상 0으로 죽어 있었음). 여기 3건은 2026-07-20
-- 웹 리서치로 확인된 수치 — 출처는 각 INSERT 위 주석.
--
-- rank 는 미확보 → NULL(한터 공식 랭킹 페이지 스냅샷이 아니라 언론/커뮤니티
-- 보도 취합이므로 순위 컬럼은 비워 정직화; sales 만 신뢰 수치로 채운다).
--
-- group_key 검증: plave/isedol/stellive 모두 groups 테이블 기존 key와
-- 일치(migrations/0007_group_model.sql 의 group_model UPDATE로 존재 확인,
-- migrations/0001_init.sql groups 테이블 정의).
--
-- 미포함(수치 미확인, 후속 마이그레이션 대상):
--   - OWIS 'MUSEUM' (2026-03-23) — 실물 앨범 존재하나 초동 수치 미확인.
--   - SKINZ 'SKINZ IS SKINZ' (2026-03-11) — 실물 앨범 존재하나 초동 수치 미확인.
--
-- INSERT OR REPLACE — PK (week_start, group_key, album) 충돌 시 갱신
-- 가능하게(재검증 후 수치 정정 대비).

-- plave / Caligo Pt.2 — 뉴스1·문화일보 등 복수 보도, 자체 최고 초동.
-- 출처: news1.kr/entertain/music/6143431, munhwa.com/article/11583900
INSERT OR REPLACE INTO hanteo_weekly
  (week_start, week_end, group_key, album, rank, sales, note)
VALUES
  ('2026-04-14', '2026-04-20', 'plave', 'Caligo Pt.2', NULL, 1255800,
   '초동 seed 2026-07-20 (뉴스1·문화일보 등 복수 보도, 자체 최고)');

-- isedol / Be My Light — 뉴스핌 14만 보도 + 한터 Bronze 인증, 커뮤니티
-- 집계 145,598 사용.
-- 출처: newspim.com/news/view/20251104001095
INSERT OR REPLACE INTO hanteo_weekly
  (week_start, week_end, group_key, album, rank, sales, note)
VALUES
  ('2025-11-03', '2025-11-09', 'isedol', 'Be My Light', NULL, 145598,
   '초동 seed 2026-07-20 (뉴스핌 14만·한터 Bronze 인증, 커뮤니티 집계 145,598)');

-- stellive / STAR TRAIL — 확정 보도 없음, KOREAN SALES D+3 누적 근사치.
-- 확인되는 대로 후속 마이그레이션에서 교체.
INSERT OR REPLACE INTO hanteo_weekly
  (week_start, week_end, group_key, album, rank, sales, note)
VALUES
  ('2026-05-08', '2026-05-14', 'stellive', 'STAR TRAIL', NULL, 7732,
   '초동 seed 2026-07-20 (KOREAN SALES D+3 누적 근사 — 확정 보도 없음, 확인 시 교체)');
