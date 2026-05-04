-- 0002_seed.sql — initial group + member seeds for IDOL-SIGHT.
-- Researched 2026-05-04. Update via 0003_*.sql, never edit this file.
--
-- Source notes:
--   - YouTube channel IDs (UC...): extracted from each handle's about page
--     by curling https://www.youtube.com/@<handle> and reading "externalId".
--   - DC galleries verified by HTTP 200 + page <title> at
--     https://gall.dcinside.com/{mgallery,mini}/board/lists/?id=<slug>.
--   - Member rosters cross-checked with kprofiles.com, kpop.fandom.com,
--     and Korean press releases (Sports Kyunghyang, Topcelev, Tenasia).
--   - For groups whose DC gallery does not yet exist (MiiWAN — debut
--     2026-06), dc_gallery_id is left NULL; the row stays is_active=1
--     because the YT channel is verified and naver_query is sufficient.

INSERT INTO groups (
  key, name, name_kr, debut_date, yt_channel_id, dc_gallery_id, naver_query,
  context_keywords, blacklist_phrases, twitter_handles, is_active
) VALUES
  ('plave',    'PLAVE',    '플레이브',     '2023-03-12',
   'UCPZIPuQPrfrUG9Xe_okEmQA', 'plave',
   '플레이브',
   '["플레이브","PLAVE","노아","예준","하민","밤비","은호","버추얼","VLAST"]',
   '[]',
   '["plave_official"]',
   1),
  ('isedol',   'ISEDOL',   '이세계아이돌', '2021-12-17',
   'UCmblbE_WxTaFWcMEGFJ_97w', 'isekaidol',
   '이세계아이돌',
   '["이세계아이돌","ISEGYE IDOL","ISEDOL","릴파","아이네","징버거","주르르","고세구","비챤","버추얼","왁타버스"]',
   '[]',
   '["isegyeidol_ofcl"]',
   1),
  ('stellive', 'STELLIVE', '스텔라이브',   '2023-03-08',
   'UC2b4WRE5BZ6SIUWBeJU8rwg', 'stellive',
   '스텔라이브',
   '["스텔라이브","StelLive","유니","후야","시부키","히나","마시로","리제","타비","나나","린","리코","버추얼"]',
   '[]',
   '["StelLive_kr"]',
   1),
  ('skinz',    'SKINZ',    '스킨즈',       '2025-04-10',
   'UCSo75BQPD0VhDyYa6Sbdmpg', 'skinz',
   'SKINZ 스킨즈',
   '["SKINZ","스킨즈","도빈","다엘","태오","핀","재온","이랑","율","버추얼","Bridge"]',
   '[]',
   '["skinz__official"]',
   1),
  -- MY:RAKL — debut date corrected from plan template (2025-09-15) to the
  -- verified 2026-01-26 ("Wish Upon The Stars", ACCORD Entertainment).
  ('myrakl',   'MY:RAKL',  '미라클',       '2026-01-26',
   'UCbtBtgyXbmgvZPUSRoNBeZQ', 'myrakl',
   'MY:RAKL 미라클 버추얼',
   '["MY:RAKL","마이라클","미라클","새온","유성","하이든","제하","설","ACCORD","버추얼"]',
   '["기적","축구","오마이걸"]',
   '["myrakl_official"]',
   1),
  ('owis',     'OWIS',     '오위스',       '2026-03-23',
   'UC7nzgwXgrT4Po0OEqERZ3vQ', 'owis',
   'OWIS 오위스',
   '["OWIS","오위스","Only When I Sleep","썸머","소이","세린","하루","유니","ama","버추얼"]',
   '[]',
   '["owis_official"]',
   1),
  -- MiiWAN — DC gallery does not yet exist (debut 2026-06). dc_gallery_id
  -- is left NULL; revisit in a 0003_* migration once the gallery opens.
  ('miiwan',   'MiiWAN',   '미완소년',     '2026-06-01',
   'UCZt93hbX0d9Plx3VR-7PnVg', NULL,
   'MiiWAN 미완소년',
   '["MiiWAN","미완소년","나이선","임온","마하진","안석우","원주율","어비스컴퍼니","ABYSS","IPX","버추얼"]',
   '[]',
   '["miiwan_official"]',
   1),
  -- B:DAWN — debut confirmed 2026-05-06 ("BEOM"), Duri Entertainment
  -- (per kprofiles + Tenasia). Plan-template said agency=IPX; we keep
  -- IPX in keywords because Duri is an IPX-invested studio per news.
  ('bdawn',    'B:DAWN',   '비던',         '2026-05-06',
   'UCSIqs6OAVAedCmCo8GtVoHQ', 'bdawn',
   'B:DAWN 비던 버추얼',
   '["B:DAWN","비던","BEOM","범","강호","서도진","임이온","이한솔","송우림","Duri","IPX","버추얼"]',
   '["와이너리","마을"]',
   '["b_dawn_official"]',
   1);

INSERT INTO members (group_key, name, name_en, yt_channel_id, active) VALUES
  -- PLAVE — VLAST, 5 members (no public solo YouTube channels).
  ('plave', '노아', 'Noah',   NULL, 1),
  ('plave', '예준', 'Yejun',  NULL, 1),
  ('plave', '하민', 'Hamin',  NULL, 1),
  ('plave', '밤비', 'Bamby',  NULL, 1),
  ('plave', '은호', 'Eunho',  NULL, 1),

  -- ISEDOL — Waktaverse, 6 members. Solo channel IDs to be added in 0003_*.
  ('isedol', '릴파',   'Lilpa',      NULL, 1),
  ('isedol', '아이네', 'Ine',        NULL, 1),
  ('isedol', '징버거', 'Jingburger', NULL, 1),
  ('isedol', '주르르', 'Jururu',     NULL, 1),
  ('isedol', '고세구', 'Gosegu',     NULL, 1),
  ('isedol', '비챤',   'Viichan',    NULL, 1),

  -- STELLIVE — 10 members across multiple generations.
  ('stellive', '아야츠노 유니', 'Ayatsuno Yuni',  NULL, 1),
  ('stellive', '사키하네 후야', 'Sakihane Fuya',  NULL, 1),
  ('stellive', '텐코 시부키',   'Tenko Shibuki',  NULL, 1),
  ('stellive', '시라유키 히나', 'Shirayuki Hina', NULL, 1),
  ('stellive', '네네코 마시로', 'Neneko Mashiro', NULL, 1),
  ('stellive', '아카네 리제',   'Akane Lize',     NULL, 1),
  ('stellive', '아라하시 타비', 'Arahashi Tabi',  NULL, 1),
  ('stellive', '하나코 나나',   'Hanako Nana',    NULL, 1),
  ('stellive', '아오쿠모 린',   'Aokumo Rin',     NULL, 1),
  ('stellive', '유즈하 리코',   'Yuzuha Riko',    NULL, 1),

  -- SKINZ — 7 members (Bridge Entertainment), per kprofiles + fandom.
  ('skinz', '도빈',   'Dovin',      NULL, 1),
  ('skinz', '다엘',   'Dael',       NULL, 1),
  ('skinz', '태오',   'Theo',       NULL, 1),
  ('skinz', '핀',     'Finn',       NULL, 1),
  ('skinz', '재온',   'Jaon',       NULL, 1),
  ('skinz', '권이랑', 'Ilang Kwon', NULL, 1),
  ('skinz', '율',     'Yull',       NULL, 1),

  -- MY:RAKL — 5 members (ACCORD Entertainment). Korean names per kprofiles.
  ('myrakl', '신새온', 'Saeon',   NULL, 1),
  ('myrakl', '유성',   'Yuseong', NULL, 1),
  ('myrakl', '하이든', 'Haydn',   NULL, 1),
  ('myrakl', '은제하', 'Jeha',    NULL, 1),
  ('myrakl', '전설',   'Seol',    NULL, 1),

  -- OWIS — 5 members (ama / All My Anecdotes). Stage names per debut press.
  ('owis', '썸머', 'Summer', NULL, 1),
  ('owis', '소이', 'Soi',    NULL, 1),
  ('owis', '세린', 'Serene', NULL, 1),
  ('owis', '하루', 'Haru',   NULL, 1),
  ('owis', '유니', 'Yuni',   NULL, 1),

  -- MiiWAN — 5 members (ABYSS Company). Member names supplied by group brief.
  ('miiwan', '나이선', 'Naison',    NULL, 1),
  ('miiwan', '임온',   'Imon',      NULL, 1),
  ('miiwan', '마하진', 'Mahajin',   NULL, 1),
  ('miiwan', '안석우', 'AnSeokwoo', NULL, 1),
  ('miiwan', '원주율', 'Wonjuyul',  NULL, 1),

  -- B:DAWN — 5 members (Duri Entertainment). Romanization per kprofiles.
  ('bdawn', '강호',   'Kangho',     NULL, 1),
  ('bdawn', '서도진', 'Seo Dojin',  NULL, 1),
  ('bdawn', '임이온', 'Im Ion',     NULL, 1),
  ('bdawn', '이한솔', 'Lee Hansol', NULL, 1),
  ('bdawn', '송우림', 'Song Woorim', NULL, 1);
