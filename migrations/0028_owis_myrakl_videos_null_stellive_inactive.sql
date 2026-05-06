-- migrations/0028_owis_myrakl_videos_null_stellive_inactive.sql
--
-- 사용자 production 검증 (Image 29 영상 수): OWIS / MY:RAKL 라인이
-- D+25~D+45 (OWIS) / D+85~D+100 (MY:RAKL) 구간에서 vertical comb
-- 패턴 (~130 ↔ ~0 진동). PR #11/#12/#13 fix 모두 적용 후에도 잔존.
--
-- 서브에이전트 진단:
--   * `yt_history_backfill`은 `youtube_videos WHERE group_key='owis'`를
--     enumerate하면서 cum_videos = (1, 2, ..., N). 이 group_key 안에는
--     OWIS 그룹 메인 채널 + 멤버 솔로 채널 영상이 모두 포함됨 (collector의
--     stamping 정책: group.key 로 일괄 표기).
--   * 멤버 솔로의 pre-debut 영상까지 합쳐 cum_videos가 ~130 도달.
--   * 라이브 cron의 `COUNT(DISTINCT v.video_id) GROUP BY group_key`는
--     같은 youtube_videos 테이블이지만 production 인덱싱 상태에 따라
--     ~50 (메인 채널만 인덱싱됐을 때) 반환.
--   * 두 source가 다른 `snapshot_at` 으로 공존, DebutCurve max-wins가
--     같은 day에 둘 모두 있으면 130 픽, 한쪽만 있으면 50 또는 NULL →
--     comb 시각.
--
-- 추가 사용자 요청: STELLIVE 차트에서 제거.
--   * STELLIVE는 segmentary/confederation 모델 (멀티-멤버 솔로 채널)
--     이라 OWIS/MYRAKL과 같은 inflated count 이슈를 가질 가능성 큼.
--   * 사용자가 명시적으로 차트에서 빼라고 요청 — `is_active=0`으로
--     soft delete. DebutCurve API의 `WHERE g.is_active=1` 필터에서
--     자동 제외됨. 데이터 자체는 보존 (필요시 재활성화).
--
-- 이 마이그레이션은 visual 일관성 우선. 정확한 long-term fix는 별도
-- PR로 yt_history_backfill에 channel_id 필터링 추가 (그룹 메인 채널만
-- count) — 그 후 OWIS/MYRAKL backfill 다시 활성화 가능.

-- (1) OWIS/MYRAKL의 backfill_estimate 행에서 video/view count NULL.
-- 라이브 행 (data_source='live')만 차트에 노출됨.
UPDATE agg_summary
   SET yt_total_videos = NULL,
       yt_total_views  = NULL
 WHERE group_key IN ('owis', 'myrakl')
   AND data_source = 'backfill_estimate';

-- (2) STELLIVE 비활성화 — DebutCurve / MiiWANBriefing 등 모든
-- is_active=1 필터에서 제외됨.
UPDATE groups
   SET is_active = 0
 WHERE key = 'stellive';
