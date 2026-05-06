-- migrations/0033_isedol_member_channel_ids.sql
--
-- ISEDOL 3 멤버 yt_channel_id 정정 (사용자 확정 핸들 기반 2026-05-06).
--
-- 0003 시드의 channel_id 가 잘못 박혀있었음:
--   * 비챤   기존 UCkUk0vX2Y5lKYbBKmiyTJEw 는 실제로는 "랑구" 채널
--   * 릴파   기존 UCvs0Brn0-cc9Nu8U5h8tnfQ 는 실제로는 "꽁밍" 채널
--   * 주르르 기존 UCUKN9rymgfWI9Zy4naPSLJw 는 실제로는 동명이인 "Jururu" 채널
--
-- 그 결과 YouTube collector 가 daily cron 마다 잘못된 채널 3건을
-- hit 하고 0건 결과를 받아 ISEDOL 멤버 영상 likes/comments/views
-- 합산이 절반만 반영됨 → engagement_rate / quality / intimacy
-- factor 가 부당하게 낮음 → ISEDOL Health C 4.5.
--
-- 정정 후 backfill-yt-videos CLI 풀 페이지네이션 + collect-hourly
-- aggregate + analyze-weekly recompute 순으로 회복.
--
-- 핸들 → channel_id 매핑 검증: youtube.com/@<handle> 응답 HTML 의
-- channelId 토큰을 직접 회수 (사용자 확인 + 채널 페이지 <title>
-- 매칭).

UPDATE members
   SET yt_channel_id = 'UCs6EwgxKLY9GG4QNUrP5hoQ'
 WHERE group_key = 'isedol' AND name = '비챤';

UPDATE members
   SET yt_channel_id = 'UC-oCJP9t47v7-DmsnmXV38Q'
 WHERE group_key = 'isedol' AND name = '릴파';

UPDATE members
   SET yt_channel_id = 'UCTifMx1ONpElK5x6B4ng8eg'
 WHERE group_key = 'isedol' AND name = '주르르';
