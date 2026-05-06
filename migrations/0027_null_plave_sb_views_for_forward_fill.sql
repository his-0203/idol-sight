-- migrations/0027_null_plave_sb_views_for_forward_fill.sql
--
-- 사용자 production 검증 (Image 26): PLAVE 누적조회수 D+50~D+90 V-shape
-- 잔존. PR #11 (yt_history_backfill UPSERT)와 0026 (라이브 NULL) 적용
-- 후에도.
--
-- 진단:
--   * 0023 SB PLAVE rows (D+58~D+90, 33일) 에 yt_total_views = 18.2M~25.8M
--     (실제 시점 누적조회수 — 정확).
--   * yt_history_backfill의 cumulative SUM(현재 view counts)는 ~65M~85M
--     (over-estimate — 영상이 출시 후 3년간 누적된 view를 그 출시일에
--     발생한 것처럼 합산).
--   * PR #11의 COALESCE(existing, excluded) 패턴: 기존 SB 값을 보호 →
--     yt_history_backfill가 D+58~D+90 슬롯을 덮을 수 없음.
--   * 인접 dates (D+57 이전, D+91 이후)는 yt_history 65M+ 값 → 시각적
--     절벽 (V-shape).
--
-- fix: PLAVE의 SB 행 (D+58~D+90) yt_total_views NULL 처리. 다음
-- backfill-yt-history 실행 (forward-fill 패치 포함) 시 비어있는 슬롯에
-- yt_history의 carry-forward cumulative 값이 채워짐 → 곡선 monotonic.
--
-- Trade-off: SB의 정확한 contemporaneous 값을 잃지만, 사용자 우선순위는
-- "monotonic 차트" > "절대값 정확도". yt_history는 여전히 over-estimate
-- 이지만 적어도 monotonic하고 차트 시각적으로 자연스러움.
--
-- 다른 그룹 (SKINZ/MYRAKL 0024 SB views) 은 손대지 않음 — 그쪽은
-- yt_history range에서 충돌 없거나 (SKINZ D+392~D+421은 publish 일자
-- 부근), MYRAKL은 SB views = 채널 누적과 잘 일치함.
--
-- SB rows 식별: yt_subscribers IS NOT NULL 패턴 (yt_history는 항상
-- yt_subscribers=NULL).
UPDATE agg_summary
   SET yt_total_views = NULL
 WHERE group_key = 'plave'
   AND data_source = 'backfill_estimate'
   AND yt_subscribers IS NOT NULL
   AND date(snapshot_at) BETWEEN '2023-05-09' AND '2023-06-10';
