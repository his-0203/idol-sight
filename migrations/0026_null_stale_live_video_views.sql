-- migrations/0026_null_stale_live_video_views.sql
--
-- 사용자 production 검증 (Image 24 PLAVE 누적조회수 D+50~D+90 V-shape,
-- Image 25 OWIS 영상수 D+30 dip + MY:RAKL D+90 dip).
--
-- 상황:
--   * `backfill-yt-videos` 실행으로 production `youtube_videos`에
--     PLAVE/SKINZ/MYRAKL/OWIS 채널의 풀 history (수백~수천 영상) 인덱싱.
--   * 그러나 그 이전부터 매일 돌던 라이브 cron (`aggregate` 명령어)이
--     SPARSE youtube_videos로 계산한 `agg_summary` 행을 매일 production에
--     축적해 옴 → `data_source='live'`, 낮은 cumulative 값.
--   * `backfill-yt-history` (PR #11 fix)는 video publish date에만 row
--     emit → publish 사이 일자는 yt_history row 없음 → 라이브의 stale
--     값만 남음.
--   * DebutCurve max-wins는 SAME-DAY 다중 행 충돌은 처리하지만,
--     OTHER-DAY 일자에 stale 낮은 값이 single source면 그대로 표시 →
--     spanGaps + tension 보간이 V-shape 생성.
--
-- fix: 4 그룹의 모든 라이브 yt_total_videos / yt_total_views를 NULL.
-- 다음 cron 실행 (B fix가 적용된 agg_summary.py 사용 + 풀 youtube_videos
-- 인덱싱 후) 시점에 정확값으로 재작성됨. 일시적으로 라이브 영역에 NULL
-- gap 발생할 수 있으나 spanGaps:true + 인접 yt_history 값으로 보간.
--
-- 보호: 4 그룹 외 (MiiWAN/B:DAWN/ISEDOL/STELLIVE)는 손대지 않음 — 이
-- 그룹들은 우리 백필 대상이 아니라 라이브 데이터가 정확.
UPDATE agg_summary
   SET yt_total_videos = NULL,
       yt_total_views  = NULL
 WHERE data_source = 'live'
   AND group_key IN ('plave', 'skinz', 'myrakl', 'owis');
