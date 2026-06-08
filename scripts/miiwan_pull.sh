#!/usr/bin/env bash
# MiiWAN 성장 분석용 D1 read-only 데이터 추출 (운영자 직접 실행).
# 결과를 /tmp/miiwan_data.json 으로 저장. 모두 SELECT (읽기 전용).
set -euo pipefail
cd "$(dirname "$0")/../frontend"
OUT=/tmp/miiwan_data.json
TMP=$(mktemp -d)

run() { # $1=label $2=sql
  wrangler d1 execute idol-sight --remote --json --command "$2" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d[0]['results']))" \
    > "$TMP/$1.json" || echo "[]" > "$TMP/$1.json"
  echo "  $1: $(python3 -c "import json;print(len(json.load(open('$TMP/$1.json'))))") rows"
}

echo "Pulling MiiWAN analysis data (read-only)…"

run groups "SELECT key,name_kr,debut_date,group_model,is_active FROM groups"

run miiwan_traj "SELECT snapshot_at,yt_total_videos,yt_total_views,yt_subscribers,yt_likes_total,yt_comments_total,dc_total_posts,theqoo_posts,instiz_posts,naver_total_news,twitter_posts,controversy_count,negative_ratio FROM agg_summary WHERE group_key='miiwan' ORDER BY snapshot_at DESC LIMIT 45"

run summary_latest_all "SELECT a.group_key,a.snapshot_at,a.yt_total_videos,a.yt_total_views,a.yt_subscribers,a.yt_likes_total,a.yt_comments_total,a.dc_total_posts,a.theqoo_posts,a.instiz_posts,a.naver_total_news,a.twitter_posts,a.controversy_count,a.negative_ratio FROM agg_summary a WHERE a.snapshot_at=(SELECT MAX(b.snapshot_at) FROM agg_summary b WHERE b.group_key=a.group_key)"

run health_latest_all "SELECT h.group_key,h.snapshot_at,h.total,h.raw_total,h.grade,h.label,h.breakdown_json FROM agg_health_scores h WHERE h.snapshot_at=(SELECT MAX(b.snapshot_at) FROM agg_health_scores b WHERE b.group_key=h.group_key)"

run health_traj_miiwan "SELECT snapshot_at,total,raw_total,grade,breakdown_json FROM agg_health_scores WHERE group_key='miiwan' ORDER BY snapshot_at DESC LIMIT 20"

run organicity "SELECT group_key,window_bucket,video_count,long_form_count,short_form_count,organic_score_mean,organic_ratio,suspect_ratio,likely_paid_ratio,total_views,total_engagement FROM debut_window_organicity_summary ORDER BY group_key,window_bucket"

run miiwan_videos "SELECT v.video_id,v.title,v.published_at,v.is_short,v.content_type,s.views,s.likes,s.comments FROM youtube_videos v JOIN youtube_video_stats s ON s.video_id=v.video_id WHERE v.group_key='miiwan' AND s.snapshot_at=(SELECT MAX(s2.snapshot_at) FROM youtube_video_stats s2 WHERE s2.video_id=v.video_id) ORDER BY v.published_at DESC LIMIT 25"

run member_meta "SELECT m.snapshot_at,m.hhi,m.evenness,m.status FROM agg_member_pop_meta m WHERE m.group_key='miiwan' ORDER BY m.snapshot_at DESC LIMIT 1"

run member_pop "SELECT p.member_id,p.composite_score,p.yt_avg_views,p.community_mentions FROM agg_member_popularity p WHERE p.group_key='miiwan' AND p.snapshot_at=(SELECT MAX(p2.snapshot_at) FROM agg_member_popularity p2 WHERE p2.group_key='miiwan') ORDER BY p.composite_score DESC"

run events_miiwan "SELECT event_date,title,category FROM group_events WHERE group_key='miiwan' ORDER BY event_date DESC LIMIT 20"

python3 - "$TMP" "$OUT" <<'PY'
import sys,json,os,glob
tmp,out=sys.argv[1],sys.argv[2]
data={}
for f in glob.glob(os.path.join(tmp,"*.json")):
    data[os.path.basename(f)[:-5]]=json.load(open(f))
json.dump(data,open(out,"w"),ensure_ascii=False,indent=0)
print(f"\nWrote {out}  ({os.path.getsize(out)} bytes)")
PY
rm -rf "$TMP"
