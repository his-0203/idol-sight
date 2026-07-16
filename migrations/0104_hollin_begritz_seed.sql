-- migrations/0104_hollin_begritz_seed.sql
--
-- 새 추적 그룹 2팀 추가: WhOLLiN (홀린) / BEGRITZ (비그릿츠). 사용자
-- 요청 2026-07-16.
--
-- 두 팀 모두 데뷔 전(pre-launch) 버추얼 아이돌 — 멤버 명단·데뷔곡·전용
-- DC 갤러리·공식 SNS 핸들이 아직 미공개다. 확인된 사실만 시드하고,
-- 멤버/갤러리/핸들은 공개 후 후속 마이그레이션에서 채운다 (MiiWAN 0002
-- → 0031/0061 패턴, wegosix 0034 → 0037/0064/0068 패턴과 동일).
--
-- context_keywords / blacklist_phrases 는 반드시 JSON 배열 문자열로
-- 넣는다. _load_group (cli.py) 이 json.loads 로 파싱하므로 콤마-string
-- 은 로더에서 크래시한다 (0034 wegosix CSV → 0037 JSON 수정 이력 참고).
--
-- ── 1. WhOLLiN (홀린, hollin) ──────────────────────────────────────
--   소속: 플레이리스트(Playlist) — 네이버웹툰·스노우 출자 콘텐츠 스튜디오
--         의 첫 버추얼 보이그룹. 광학식 모션캡처 기반 3D 5인조.
--   데뷔: 2026-09-01 정식 데뷔 (음원 데뷔 여부는 기사 미명시 — 일자는
--         확정 보도라 debut_date 세팅. 음원/채널 데뷔 구분은 공개 후 정정).
--   yt_channel_id: UCQZ5dfVSTui3yfhkHtw0kEg (@WhOLLiN_official externalId).
--   group_model: corporate (PLAVE/MiiWAN 형 회사 주도 데뷔).
--   DC: 전용 갤러리 미개설 → dc_gallery_id NULL. 버추얼 보이그룹 통합갤
--       'vboyband' 를 supplemental 로 등록 (miiwan/wegosix 와 동일 허브).
--       단, "홀린" 은 동사 홀리다 활용형("홀린 듯이") + 가수 효린 음차와
--       충돌이 극심 → relevance.py GENERIC_KEYWORD_BLOCKLIST 에 "홀린"
--       (+"플레이리스트"/"Playlist") 등재(별도 커밋)로 strict 모드에서
--       anchor-required. supplemental 매치는 WhOLLiN / 네이버웹툰 등
--       고유 anchor 동반 시에만 성립.
--   naver_query: 단독 "홀린" 금지 — 반드시 anchor 결합.
--
-- ── 2. BEGRITZ (비그릿츠, begritz) ─────────────────────────────────
--   제작: 디네이블(DNABLE). 음악 총괄 알티(R.Tee, 블랙핑크/빅뱅/에스파),
--         A&R·보컬 디렉터 블락비 태일. 버추얼 아이돌 5인.
--   론칭: 2026-08 공식 론칭 예정. 정확한 음원 데뷔일 미확정 → debut_date
--         NULL (wegosix 와 동일 pre-debut 처리; is_pre_debut True).
--   yt_channel_id: UCrzghjaLT0BTRICYQl7EI0Q (@BEGRITZ externalId).
--   group_model: corporate.
--   DC: 전용 갤러리 미개설 → NULL. 성별 구성(보이/걸) 미공개라 vboyband
--       (버추얼 보이그룹 전용) supplemental 은 보류 — 오분류 방지. 공개 후
--       후속 마이그레이션에서 적합한 허브 갤러리 등록.
--   naver_query: "비그릿츠" 는 일반어 충돌 낮아 anchor 가능. 로마자
--       BEGRITZ 는 blitz/Bretz 등 오탈자 잡음 → 정확 표기만.

INSERT OR IGNORE INTO groups
  (key, name, name_kr, debut_date, yt_channel_id, group_model, is_active)
VALUES
  ('hollin',  'WhOLLiN', '홀린',     '2026-09-01',
   'UCQZ5dfVSTui3yfhkHtw0kEg', 'corporate', 1),
  ('begritz', 'BEGRITZ', '비그릿츠', NULL,
   'UCrzghjaLT0BTRICYQl7EI0Q', 'corporate', 1);

UPDATE groups
   SET dc_supplemental_galleries = '["vboyband"]',
       naver_query = 'WhOLLiN OR "홀린 플레이리스트" OR "홀린 버추얼" OR "홀린 데뷔"',
       context_keywords = '["홀린","WhOLLiN","Whollin","whollin","WHOLLIN","플레이리스트","Playlist","네이버웹툰","버추얼","버추얼보이그룹"]',
       blacklist_phrases = '["양도","팝니다","[광고]","도배"]'
 WHERE key = 'hollin';

UPDATE groups
   SET naver_query = '비그릿츠 OR BEGRITZ OR "비그릿츠 디네이블"',
       context_keywords = '["비그릿츠","BEGRITZ","Begritz","begritz","BEGRITS","디네이블","DNABLE","알티","R.Tee","태일","버추얼"]',
       blacklist_phrases = '["양도","팝니다","[광고]","도배"]'
 WHERE key = 'begritz';

-- 멤버는 미공개 — members INSERT 없음. 공개 후 후속 마이그레이션에서
-- (group_key, name, name_en, yt_channel_id) 로 추가. members 가 비어도
-- context_keywords 앵커로 그룹 단위 수집은 정상 동작한다.
