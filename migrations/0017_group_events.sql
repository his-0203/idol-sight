-- 0017_group_events.sql — historical events seed for the 8 tracked
-- groups, sourced from 8 parallel research subagents (2026-05-05).
--
-- Why this exists: agg_summary captures cumulative-state snapshots,
-- which answer "where was the group at date X" but not "what
-- happened on date X". The DebutCurve and MiiWAN briefing benefit
-- from event annotations (debut, music-show win, milestone, member
-- reveal, etc.) so the operator can read a curve inflection against
-- a known cause. This table is the substrate for those annotations.
--
-- Schema:
--   group_events.event_type ∈ {debut, first_release, mv_release,
--     pre_debut, announcement, member_reveal, milestone, song_release,
--     album_release, first_show_win, show_win, first_concert,
--     tour_start, tour, first_show, selection, predecessor,
--     1st_gen_debut, 2nd_gen_debut, 3rd_gen_debut, company_launch,
--     graduation, graduation_announcement, merger, showcase,
--     1st_gen_transfer_debut, second_release, third_release}
--   confidence ∈ {high, medium} (low-confidence rows omitted; this
--     migration is operator-trusted seed, not raw research output).
--
-- Idempotency: UNIQUE INDEX on (group_key, event_date, title) +
-- INSERT OR IGNORE means re-running the migration is a no-op once
-- applied. New rows added in future migrations stay safe.
--
-- Subagent recommendations not auto-applied (left for operator):
--   - STELLIVE seeded debut_date 2023-03-08 has no public source
--     verification; subagent suggests 2023-01-07 (Mystic 1st-gen
--     Kanna debut) as a more defensible anchor.
--   - MiiWAN public press attributes solo to Abyss Company; the
--     "IPX × Abyss" framing in seed is internal-only per public
--     records.
--   - B:DAWN debut format is digital single, not EP (no schema
--     field captures this — affects narrative copy in Briefing).
--   - MY:RAKL debut release similarly digital-single by external
--     reporting.

CREATE TABLE IF NOT EXISTS group_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key    TEXT NOT NULL,
  event_date   TEXT NOT NULL,        -- ISO YYYY-MM-DD
  event_type   TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  source_url   TEXT,
  confidence   TEXT NOT NULL DEFAULT 'medium',
  FOREIGN KEY (group_key) REFERENCES groups(key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_group_events
  ON group_events(group_key, event_date, title);
CREATE INDEX IF NOT EXISTS idx_group_events_date
  ON group_events(group_key, event_date DESC);

-- ─── PLAVE (corporate K-POP, debut 2023-03-12) ──────────────────────
INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence) VALUES
  ('plave','2022-09-15','pre_debut','공식 유튜브/트위치 첫 라이브 방송',
    '그룹 최초 공개','https://en.wikipedia.org/wiki/Plave','high'),
  ('plave','2023-03-12','debut','공식 데뷔 — 1st 싱글 ''Asterum''',
    '타이틀 ''Wait For You''','https://en.wikipedia.org/wiki/Plave','high'),
  ('plave','2023-03-12','mv_release','데뷔 MV ''Wait For You'' 공개',
    NULL,'https://kpop.fandom.com/wiki/Asterum','high'),
  ('plave','2023-08-19','milestone','KCON LA 2023 출연',
    '버추얼 아이돌 최초 KCON 출연','https://asiapacificarts.org/2023/08/19/plave-kcon/','high'),
  ('plave','2023-08-24','album_release','1st 미니앨범 ''Asterum: The Shape of Things to Come''',
    NULL,'https://en.wikipedia.org/wiki/Plave','high'),
  ('plave','2024-02-26','album_release','2nd 미니앨범 ''Asterum: 134-1''',
    '첫주 569,289장 판매','https://en.wikipedia.org/wiki/Plave','high'),
  ('plave','2024-03-06','first_show_win','Show Champion ''WAY 4 LUV'' 1위',
    '버추얼 아이돌 최초 한국 음방 1위','https://www.soompi.com/article/1646949wpp/watch-plave-becomes-1st-virtual-group-to-win-on-show-champion','high'),
  ('plave','2024-03-09','show_win','MBC Show! Music Core 1위',
    '''WAY 4 LUV''','https://www.youtube.com/watch?v=a83auwjE-Zw','high'),
  ('plave','2024-04-13','tour_start','첫 단독 팬콘서트 ''Hello, Asterum!''',
    '서울 올림픽홀 (4/13-14)','https://www.allkpop.com/article/2024/04/plave-concludes-first-solo-concert-with-full-house-virtual-idol-groups-debut-show-sells-out','high'),
  ('plave','2024-08-20','single_release','디지털 싱글 ''Pump Up The Volume!''',
    '2024년 첫 보이그룹 멜론 Top 100 1위','https://www.allkpop.com/article/2024/08/plaves-pump-up-the-volume-becomes-the-first-boy-group-song-of-2024-to-hit-1-on-melons-top-100-7-songs-in-the-top-10','high'),
  ('plave','2024-10-05','tour','Hello, Asterum! Encore 콘서트',
    '10/5-6','https://english.visitseoul.net/exhibition/PLAVE-CONCERT_/47083','high'),
  ('plave','2025-02-03','album_release','3rd 미니앨범 ''Caligo Pt.1''',
    '첫주 100만장 돌파 — 버추얼 보이그룹 최초 밀리언셀러','https://www.gadgetmatch.com/plave-virtual-kpop-group-2025-comeback-caligo-pt-1-dash/','high'),
  ('plave','2025-03-01','milestone','YouTube 구독자 100만 돌파',
    '월 단위 추정','https://en.wikipedia.org/wiki/Plave','medium'),
  ('plave','2025-08-15','tour','Dash: Quantum Leap Tour 서울',
    '8/15-17','https://en.wikipedia.org/wiki/Plave','high'),
  ('plave','2025-11-10','single_release','싱글 ''Plbbuu''',
    NULL,'https://en.wikipedia.org/wiki/Plave','high'),
  ('plave','2026-04-13','album_release','4th 미니앨범 ''Caligo Pt.2''',
    NULL,'https://en.wikipedia.org/wiki/Plave','high');

-- ─── ISEDOL (segmentary 서브컬처, debut 2021-12-17) ─────────────────
INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence) VALUES
  ('isedol','2021-08-23','selection','이세계아이돌 오디션 시작',
    '우왁굳 주도','https://namu.wiki/w/%EC%9D%B4%EC%84%B8%EA%B3%84%EC%95%84%EC%9D%B4%EB%8F%8C','high'),
  ('isedol','2021-08-26','selection','최종 멤버 6인 확정',
    '아이네/징버거/릴파/주르르/고세구/비챤','https://ko.wikipedia.org/wiki/%EC%9D%B4%EC%84%B8%EA%B3%84%EC%95%84%EC%9D%B4%EB%8F%8C','high'),
  ('isedol','2021-12-17','debut','공식 데뷔 — ''RE:WIND''',
    '벅스 1위, 가온 다운로드 1위, 멜론 TOP100 80위','https://namu.wiki/w/RE%20:%20WIND','high'),
  ('isedol','2021-12-17','first_release','싱글 1집 ''RE:WIND''',
    NULL,'https://namu.wiki/w/RE%20:%20WIND','high'),
  ('isedol','2021-12-19','milestone','VRChat 가상 팬미팅',
    '데뷔 직후 VR 환경 첫 팬미팅','https://ko.wikipedia.org/wiki/%EC%9D%B4%EC%84%B8%EA%B3%84%EC%95%84%EC%9D%B4%EB%8F%8C','high'),
  ('isedol','2022-04-05','milestone','전 멤버 개인 채널 10만 구독',
    NULL,'https://namu.wiki/w/%EC%9D%B4%EC%84%B8%EA%B3%84%EC%95%84%EC%9D%B4%EB%8F%8C','high'),
  ('isedol','2022-12-16','milestone','전 멤버 개인 채널 20만 구독',
    NULL,'https://namu.wiki/w/%EC%9D%B4%EC%84%B8%EA%B3%84%EC%95%84%EC%9D%B4%EB%8F%8C','high'),
  ('isedol','2023-06-22','song_release','2nd 싱글 ''LOCKDOWN''',
    NULL,'https://namu.wiki/w/LOCKDOWN','high'),
  ('isedol','2023-08-18','song_release','3rd 싱글 ''KIDDING''',
    NULL,'https://namu.wiki/w/KIDDING(%EC%9D%B4%EC%84%B8%EA%B3%84%EC%95%84%EC%9D%B4%EB%8F%8C)','high'),
  ('isedol','2023-08-24','milestone','멜론 주간인기상 + 명예의 전당 3관왕',
    '버추얼 걸그룹 최초. 빌보드 South Korea Songs 3위','https://www.newstree.kr/newsView/ntr202308240008','high'),
  ('isedol','2023-09-23','first_concert','이세계 페스티벌 2023',
    '첫 오프라인 콘서트','https://namu.wiki/w/%EC%9D%B4%EC%84%B8%EA%B3%84%EC%95%84%EC%9D%B4%EB%8F%8C/%EA%B3%B5%EC%97%B0%20%EB%B0%8F%20%ED%96%89%EC%82%AC','high'),
  ('isedol','2023-12-21','milestone','전 멤버 개인 채널 30만 구독',
    NULL,'https://namu.wiki/w/%EC%9D%B4%EC%84%B8%EA%B3%84%EC%95%84%EC%9D%B4%EB%8F%8C','high'),
  ('isedol','2024-07-12','tour','LILPACON: Going Out (릴파 단독)',
    '7/12-13 경희대 평화의 전당','https://namu.wiki/w/%EC%9D%B4%EC%84%B8%EA%B3%84%EC%95%84%EC%9D%B4%EB%8F%8C/%EA%B3%B5%EC%97%B0%20%EB%B0%8F%20%ED%96%89%EC%82%AC','high'),
  ('isedol','2025-05-16','tour','이세계 페스티벌 서울 2025',
    '5/16-17 고척 스카이돔','https://isegye-festival.com/','high');

-- ─── STELLIVE (confederation 서브컬처, seeded debut 2023-03-08) ─────
-- Note: subagent flagged seeded date as unverified. Real anchors below;
-- DebutCurve consumers should treat 2023-01-07 (1st-gen Kanna debut)
-- as the de-facto debut for trajectory comparison purposes.
INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence) VALUES
  ('stellive','2022-08-01','predecessor','YUME Percent 출범',
    '강지 주도, 아이리 칸나·아야츠노 유니 첫 데뷔 (월 단위)','https://virtualyoutuber.fandom.com/wiki/StelLive','medium'),
  ('stellive','2023-01-07','1st_gen_debut','1기 ''Mystic'' 데뷔 — 아이리 칸나',
    '1호 멤버','https://virtualyoutuber.fandom.com/wiki/StelLive','high'),
  ('stellive','2023-01-08','1st_gen_debut','아야츠노 유니 데뷔',
    '1기 Mystic 완성','https://virtualyoutuber.fandom.com/wiki/StelLive','high'),
  ('stellive','2023-04-01','company_launch','StelLive Inc. 법인 설립',
    '대표: 강지 (월 단위)','https://bravegroup.co.jp/en/news/9757/','high'),
  ('stellive','2023-06-10','2nd_gen_debut','2기 ''Universe'' — 시라유키 히나·네네코 마시로',
    NULL,'https://www.beginstart.co.kr/news/articleView.html?idxno=4029','high'),
  ('stellive','2023-06-11','2nd_gen_debut','2기 ''Universe'' — 아카네 리제·아라하시 타비',
    NULL,'https://www.beginstart.co.kr/news/articleView.html?idxno=4029','high'),
  ('stellive','2024-05-17','3rd_gen_debut','3기 ''Cliché'' — 텐코 시부키·아오쿠모 린',
    NULL,'https://www.g-enews.com/article/ICT/2024/05/202405151806151001c5fa75ef86_1','high'),
  ('stellive','2024-05-18','3rd_gen_debut','3기 ''Cliché'' — 하나코 나나·유즈하 리코',
    NULL,'https://www.g-enews.com/article/ICT/2024/05/202405151806151001c5fa75ef86_1','high'),
  ('stellive','2024-07-01','milestone','StelLive 공식 채널 100K 구독자',
    '월 단위','https://www.topcelev.co.kr/news/articleView.html?idxno=219','high'),
  ('stellive','2024-11-04','graduation_announcement','아이리 칸나 졸업 발표',
    NULL,'https://www.g-enews.com/article/ICT/2024/11/202411041515524907c5fa75ef86_1','high'),
  ('stellive','2024-12-02','graduation','아이리 칸나 최종 졸업',
    'LAST CONCERT ''The finale'' — 1호 졸업생','https://www.topcelev.co.kr/news/articleView.html?idxno=785','high'),
  ('stellive','2025-07-16','merger','Brave group의 StelLive 인수',
    '''Brave group Korea'' 출범','https://bravegroup.co.jp/en/news/9757/','high'),
  ('stellive','2025-09-20','1st_gen_transfer_debut','사키하네 후야 데뷔',
    '아야츠노 유니와 유닛 ''Everys'' 결성','https://www.kmjournal.net/news/articleView.html?idxno=3671','high'),
  ('stellive','2026-05-08','song_release','1st Album ''STAR TRAIL'' 디지털 발매',
    'KST 18:00 예정','https://x.com/StelLive_kr/status/1977985471407144976','medium');

-- ─── SKINZ (corporate K-POP, debut 2025-04-10) ──────────────────────
INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence) VALUES
  ('skinz','2024-12-23','announcement','Bridge Entertainment, SKINZ 공식 론칭',
    '7인 디지털 아바타 라인업 티저','https://kstationtv.com/2024/12/23/skinz-new-virtual-idols/?lang=en','high'),
  ('skinz','2025-01-31','pre_debut','자작곡 ''The Way Back'' OST 공개',
    '드라마 ''러브스카웃'' OST','https://kpop.fandom.com/wiki/The_Way_Back','high'),
  ('skinz','2025-02-15','pre_debut','자작곡 ''Poison Ivy'' 믹스테이프 공개',
    '월 단위','https://www.kcrush.com/who-is-skinz-redefining-virtual-k-pop/','medium'),
  ('skinz','2025-03-24','member_reveal','도빈(Dovin) 공개',
    NULL,'https://kprofiles.com/skinz-members-profile/','high'),
  ('skinz','2025-03-25','member_reveal','율(Yull), 태오(Theo) 공개',
    NULL,'https://kprofiles.com/skinz-members-profile/','high'),
  ('skinz','2025-03-26','member_reveal','다엘(Dael), 핀(Finn) 공개',
    NULL,'https://kprofiles.com/skinz-members-profile/','high'),
  ('skinz','2025-03-27','member_reveal','재온(Jaon), 권이랑(Ilang Kwon) 공개',
    NULL,'https://kprofiles.com/skinz-members-profile/','high'),
  ('skinz','2025-04-10','debut','공식 데뷔 — 디지털 싱글 ''YOUNG & LOUD''',
    'EL CAPITXN 협업, 얼터너티브 록','https://www.kpopwise.com/2025/04/virtual-boy-group-skinz-makes-debut.html','high'),
  ('skinz','2025-04-10','first_release','데뷔 디지털 싱글 ''YOUNG & LOUD''',
    NULL,'https://kpop.fandom.com/wiki/SKINZ','high'),
  ('skinz','2025-04-10','mv_release','''YOUNG & LOUD'' Official MV',
    NULL,'https://www.youtube.com/watch?v=afRJOsLz2M8','high'),
  ('skinz','2025-11-29','single_release','''The Way Back'' 정식 디지털 싱글 발매',
    NULL,'https://kpop.fandom.com/wiki/The_Way_Back','high'),
  ('skinz','2026-02-04','single_release','''Why U Mad'' 선공개',
    '첫 미니앨범 프리릴리스','https://thestardustmag.com/music/skinz-pre-release-single-why-u-mad','high'),
  ('skinz','2026-03-11','album_release','첫 미니앨범 ''SKINZ is SKINZ''',
    NULL,'https://kprofiles.com/skinz-members-profile/','high');

-- ─── MY:RAKL (corporate K-POP, debut 2026-01-26) ────────────────────
-- subagent note: debut release is digital single, not EP per public press.
INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence) VALUES
  ('myrakl','2026-01-26','debut','MY:RAKL 공식 데뷔',
    'ACCORD Entertainment 산하 5인조 버추얼 보이그룹','https://kprofiles.com/myrakl-members-profile/','high'),
  ('myrakl','2026-01-26','first_release','데뷔 디지털 싱글 ''별들에게 물어봐 (Wish Upon The Stars)''',
    NULL,'https://kprofiles.com/myrakl-members-profile/','high'),
  ('myrakl','2026-01-26','mv_release','''Wish Upon The Stars'' MV',
    '데뷔일 동시 공개','https://www.youtube.com/channel/UCbtBtgyXbmgvZPUSRoNBeZQ','medium'),
  ('myrakl','2026-02-26','single_release','2nd 디지털 싱글 ''Good Time (좋을때야)''',
    '18:00 KST','https://kprofiles.com/myrakl-members-profile/','high'),
  ('myrakl','2026-03-25','single_release','3rd 디지털 싱글 ''Sunshine on Demand''',
    '전 멤버 작사 크레딧','https://kprofiles.com/myrakl-members-profile/','high');

-- ─── OWIS (corporate K-POP, debut 2026-03-23) ──────────────────────
INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence) VALUES
  ('owis','2026-01-10','pre_debut','제40회 골든디스크어워즈 데뷔 트레일러 공개',
    '타이베이 돔','https://namu.wiki/w/OWIS','high'),
  ('owis','2026-01-13','announcement','ama 설립 + OWIS 제작 공식 발표',
    '이해인 CCO·김재이 CEO','https://www.newsis.com/view/NISX20260113_0003474358','high'),
  ('owis','2026-02-23','pre_debut','본체 멤버 데뷔 티징 시작',
    '이해인·이루리·아도라·류수정·지니 SNS 오브제 ''MUSEUM 티켓''','https://namu.wiki/w/OWIS','medium'),
  ('owis','2026-02-27','pre_debut','데뷔 앨범 ''MUSEUM'' 스케줄러 공개',
    NULL,'https://www.starnewskorea.com/en/music/2026/02/27/2026022708025226399','high'),
  ('owis','2026-03-03','pre_debut','''Eternal Exhibition: OWIS'' 1챕터 공개',
    '세계관 프로젝트','https://www.kmjournal.net/news/articleView.html?idxno=8977','high'),
  ('owis','2026-03-11','pre_debut','데뷔 앨범 하이라이트 메들리 공개',
    'MUSEUM 8트랙','https://www.koreadaily.com/article/20260311160934507','high'),
  ('owis','2026-03-20','pre_debut','타이틀곡 ''MUSEUM'' MV 티저',
    '소프트 빈티지 무드','https://www.koreadaily.com/article/20260320182343752','high'),
  ('owis','2026-03-23','debut','데뷔 미니앨범 ''MUSEUM'' 발매',
    '1st 미니앨범 8트랙. KST 18:00','https://thestardustmag.com/music/owis-enchanting-k-pop-debut-museum','high'),
  ('owis','2026-03-23','first_release','1st 미니앨범 ''MUSEUM''',
    NULL,'https://kpopofficial.com/album/owis-museum/','high'),
  ('owis','2026-03-23','mv_release','''MUSEUM'' Official MV',
    NULL,'https://www.starnewskorea.com/en/music/2026/03/24/2026032407263147538','high'),
  ('owis','2026-03-26','first_show','Mnet 엠카운트다운 데뷔 무대',
    '데뷔 첫 음악방송','https://www.etnews.com/20260326000108','high'),
  ('owis','2026-04-04','first_show','MBC 쇼! 음악중심 데뷔 무대',
    NULL,'https://www.starnewskorea.com/en/music/2026/04/05/2026040508114127651','medium');

-- ─── MiiWAN (corporate K-POP, debut 2026-06-01 planned) ─────────────
-- subagent note: external press attributes to Abyss Company solo.
-- IPX involvement is internal-only per public records. Subagent
-- could not surface 임온/안석우/원주율 reveal dates externally —
-- operator-side internal records preferred.
INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence) VALUES
  ('miiwan','2026-04-06','announcement','어비스컴퍼니 미완소년 공식 론칭',
    '체인소맨 감독 나카야마 류 협업, 5인 솔로곡 데뷔 전략','https://www.stardailynews.co.kr/news/articleViewAmp.html?idxno=530489','high'),
  ('miiwan','2026-04-07','member_reveal','나이선(Naison) 서사 애니메이션 공개',
    'Laftel 동시 공개','https://sports.khan.co.kr/article/202604100941003/','high'),
  ('miiwan','2026-04-08','pre_debut','나이선 첫 라이브 방송',
    NULL,'https://www.heraldmuse.com/article/10714607','high'),
  ('miiwan','2026-04-09','pre_debut','솔로곡 ''너로부터의 도파민'' 티저',
    '나이선 솔로곡','https://sports.khan.co.kr/article/202604100941003/','high'),
  ('miiwan','2026-04-27','member_reveal','마하진(Mahajin) 서사 ''Piece 4'' 공개',
    '나는 불타는 소년이다','https://sports.khan.co.kr/article/202604290750003/','high'),
  ('miiwan','2026-06-01','debut','정식 데뷔 (예정)',
    '월 단위 외부 공식, 일자는 내부 타겟','https://www.heraldmuse.com/article/10714607','medium'),
  ('miiwan','2026-06-01','first_release','데뷔 솔로곡 5곡 동시 공개 (예정)',
    'EP가 아닌 멤버 5인 솔로곡 동시 발표 형식','https://www.stardailynews.co.kr/news/articleViewAmp.html?idxno=530489','medium');

-- ─── B:DAWN (corporate K-POP, debut 2026-05-06) ─────────────────────
-- subagent note: debut release is digital single ''범(BEOM)'', not EP.
INSERT OR IGNORE INTO group_events
  (group_key, event_date, event_type, title, description, source_url, confidence) VALUES
  ('bdawn','2026-03-03','announcement','Duri Entertainment, B:DAWN 공식 발표',
    '로고 모션 공개. 그룹명: Before the DAWN','https://www.topcelev.news/bdawn-logo-motion/','high'),
  ('bdawn','2026-03-22','member_reveal','송우림(Song Woorim) 공개',
    '메인 댄서, 1st 멤버','https://kpop.fandom.com/wiki/B:DAWN','high'),
  ('bdawn','2026-03-23','member_reveal','임이온(Im Ion) 공개',
    '메인 래퍼','https://kpop.fandom.com/wiki/B:DAWN','high'),
  ('bdawn','2026-04-01','member_reveal','서도진(Seo Dojin) 공개',
    '리더/메인 보컬','https://kpop.fandom.com/wiki/B:DAWN','high'),
  ('bdawn','2026-04-02','member_reveal','이한솔(Lee Hansol) 공개',
    '막내','https://kpop.fandom.com/wiki/B:DAWN','high'),
  ('bdawn','2026-04-03','member_reveal','강호(Kangho) 공개',
    '래퍼. 5인 라인업 확정','https://kpop.fandom.com/wiki/B:DAWN','high'),
  ('bdawn','2026-04-20','pre_debut','공식 데뷔 스케줄러 공개',
    NULL,'https://www.tenasia.co.kr/article/2026042032684','high'),
  ('bdawn','2026-04-29','pre_debut','데뷔곡 ''범(BEOM)'' 타이틀 포스터',
    NULL,'https://sports.khan.co.kr/article/202604290246003/','high'),
  ('bdawn','2026-05-01','pre_debut','''범(BEOM)'' MV 티저 공개',
    NULL,'https://sports.khan.co.kr/article/202605010250003/','high'),
  ('bdawn','2026-05-06','debut','공식 데뷔 — 1st 디지털 싱글 ''범(BEOM)''',
    NULL,'https://kpop.fandom.com/wiki/Beom_(B:DAWN)','high'),
  ('bdawn','2026-05-06','first_release','1st Digital Single ''범(BEOM)''',
    NULL,'https://kpop.fandom.com/wiki/Beom_(B:DAWN)','high'),
  ('bdawn','2026-05-06','mv_release','''범(BEOM)'' Official MV',
    '데뷔일 동시 공개','https://kpop.fandom.com/wiki/Beom_(B:DAWN)','medium'),
  ('bdawn','2026-05-06','showcase','온라인 데뷔 쇼케이스',
    '네이버 치지직 라이브 독점 송출','https://www.ajunews.com/view/20260430101325246','high');
