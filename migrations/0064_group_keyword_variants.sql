-- migrations/0064_group_keyword_variants.sql — V2.30
--
-- 그룹별 context_keywords 표기 변형 보강 + wegosix DC 갤러리 등록.
--
-- 배경
-- ----
-- V2.26 (migration 0061) 에서 MiiWAN 의 표기 변형 누락을 보완했다
-- ("miiwan" 소문자 / "MIIWAN" 대문자 / "ㅁㅇㅅㄴ" 초성). 같은 문제가
-- 다른 그룹에도 존재한다 — analysis.relevance.is_relevant 의 long-token
-- fast path 는 case-sensitive substring 매칭이라 운영자가 모든 케이스를
-- 명시적으로 시드해야 하고, 데뷔 전/신생 그룹일수록 팬들이 자유 표기를
-- 사용해 누락률이 높아진다. 사용자 보고(2026-05-25): WeGoSix 의 경우
-- "wegosix" / "we go six" / "wego6" / "ㅇㄱㅅㅅ" 등 다양하게 호명되는데
-- 그 중 일부만 시드되어 있음.
--
-- 본 마이그레이션은 두 가지 범주의 변경을 묶는다:
--
--   A. 모든 8개 그룹 context_keywords 표기 변형 추가
--   B. WeGoSix 마이너 갤러리 등록(0034 시점에는 미개설 → 현재 개설 확인)
--      + DC supplemental 갤러리 ['vboyband'] (트래픽 적은 신생 마이너갤
--        한계 보완, MiiWAN 패턴 동일)
--
-- 어떤 변형을 추가하는가
-- --------------------
-- 각 그룹에 대해 다음 4 카테고리를 검토:
--   1. 영문 소문자 / 대문자 / Title case 변형 — 더쿠/인스티즈 글쓴이별
--      습관 차이 흡수.
--   2. 콜론·하이픈·공백을 다르게 처치한 변형 — "MY:RAKL" / "MY RAKL" /
--      "MYRAKL", "B:DAWN" / "BDAWN" / "B-DAWN" / "B DAWN", "WE GO-6" /
--      "WE GO 6" / "WeGo6" / "WEGO6" 등.
--   3. 영어 숫자 표기 — "WE GO 6" vs "we go six" (영문 number word).
--   4. 한글 초성 약자 — "ㅁㅇㅅㄴ" / "ㅍㄹㅇㅂ" / "ㅅㅋㅈ" / "ㅇㅇㅅ" /
--      "ㅇㄱㅅㅅ" 등. 4자모 이상은 다른 그룹/일반어 충돌 가능성이
--      현저히 낮아 안전.
--
-- 의도적으로 제외한 변형
-- --------------------
--   - "이세돌"  → 바둑기사 이세돌과 강한 충돌. ISEDOL 글이 묻혀도
--     안 추가하는 게 합리적.
--   - "이세계"  → 만화/소설 장르명과 충돌. 너무 일반적.
--   - "위고"    → 2자 일반어 ("위고 보드" 등) 와 충돌. anchor 게이트가
--     있긴 하지만 short token 정책상 회피.
--   - "스텔"    → 2자라 anchor 필요 + "스텔라" 같은 화장품/일반어와
--     충돌. 추가 효용 낮음.
--
-- 사용자 명시 포함 (short token, anchor 필요)
-- ------------------------------------------
--   - "ㅂㄷ"    → 2자 한글 초성. is_relevant 의 short-token 게이트가
--     anchor (B:DAWN 또는 비던) 동시 출현을 강제하므로 "ㅂㄷㅂㄷ"
--     (부들부들) / "받침" 같은 일반어 충돌은 차단된다. 사용자 요청
--     2026-05-25 에 따라 anchor 동반 short token 으로 시드.
--   - "ㅁㄹㅋ"  → 3자 한글 초성 ("미라클"). 3자라 long-token fast path
--     로 자동 매치되지만 한글 일반 단어와 충돌 빈도 낮음 ("머루크" /
--     "메리크" 류는 빈도 매우 낮고 ㅁㄹㅋ 형태 단독 사용은 드물다).
--
-- 충돌 안전성 (한글 초성)
-- -----------------------
-- 추가된 초성 약자들은 서로 + 일반어 + 타 그룹 초성과 모두 상이:
--   PLAVE   = ㅍㄹㅇㅂ (4자)   ↔ 미완 ㅁㅇㅅㄴ / 위고 ㅇㄱㅅㅅ 등 충돌 없음
--   SKINZ   = ㅅㅋㅈ   (3자)
--   OWIS    = ㅇㅇㅅ   (3자)   — "응응시" 같은 약자 빈도 매우 낮음
--   위고식스 = ㅇㄱㅅㅅ (4자)
-- ISEDOL / STELLIVE / MY:RAKL / B:DAWN 은 초성 약자를 추가하지 않았다
-- (각각 충돌 위험 OR 본 그룹 anchor 강도가 충분).
--
-- WeGoSix 의 DC 갤러리 등록
-- -------------------------
-- 0034 시드 (2026-05-06) 시점에는 wegosix 마이너 갤러리가 미개설이라
-- dc_gallery_id 를 비워뒀다. 2026-05-25 확인 결과 마이너 갤러리가
-- 개설되어 정상 응답한다 (HTTP 200, 제목 "위고식스 마이너 갤러리",
-- https://gall.dcinside.com/mgallery/board/lists/?id=wegosix). DcCollector
-- 가 canonical URL (/board/lists/?id=<gid>) 로 fetch 후 JS redirect 로
-- mgallery 에 도달하므로 gid 만 등록하면 기존 코드 변경 없이 동작.
--
-- WeGoSix 의 dc_supplemental_galleries
-- ----------------------------------
-- 신생 마이너 갤러리라 본 갤 트래픽이 데뷔 전 단계로 낮을 가능성이
-- 높다. MiiWAN 와 동일 패턴으로 'vboyband' (버추얼 보이그룹 통갤) 을
-- supplemental 로 추가 — DcCollector 는 strict_generic_blocklist=True
-- 옵션을 적용해 supplemental 결과를 필터링하므로 PLAVE / B:DAWN 등
-- 타 그룹 글은 차단된다 (V2.27.1 검증 완료).
--
-- 다른 보이그룹(PLAVE / SKINZ / MY:RAKL / B:DAWN) 도 vboyband 적용
-- 가치는 있으나 자체 mgallery 트래픽이 충분하므로 본 마이그레이션
-- 에서는 보류 (0062 가이드라인 따름).
--
-- 영향 / 비용
-- -----------
-- - DC fetch 횟수: wegosix 가 1회 → 2회로 증가 (primary + vboyband).
--   collect-6h 잡 시간 약 +10s. 다른 그룹은 변화 없음.
-- - TheQoo / Instiz / Naver: context_keywords 확장만으로 동작 (코드
--   변경 없음). is_relevant long-token fast path 가 새 변형을 case-
--   sensitive substring 매칭으로 흡수.
-- - Naver query 확장 (_search_terms.expand_search_terms): aliases 로
--   context_keywords 가 전달되지만 length gate (HANGUL_MIN=2,
--   LATIN_MIN=3) 와 GENERIC_KEYWORD_BLOCKLIST 로 필터링되므로 검색
--   쿼리 수는 max_terms (기본 6) 까지만 사용. 변형들이 신규 쿼리로
--   소수 추가될 수 있으나 API quota 영향 미미.
-- - 스키마 변화 없음. agg / community_posts 테이블 그대로.
--
-- Rollback
-- --------
--   UPDATE groups
--      SET context_keywords = '["플레이브","PLAVE","노아","예준","하민","밤비","은호","버추얼","VLAST"]'
--    WHERE key = 'plave';
--   (각 그룹별로 0002_seed.sql 의 원본 + 후속 마이그레이션 값으로 되돌리기)
--   UPDATE groups
--      SET dc_gallery_id = NULL,
--          dc_supplemental_galleries = NULL
--    WHERE key = 'wegosix';

-- ============================================================
-- A. context_keywords 표기 변형 확장
-- ============================================================

-- PLAVE: 영문 소문자/Title case + 한글 초성 'ㅍㄹㅇㅂ' (4자모).
UPDATE groups
   SET context_keywords = '["플레이브","PLAVE","plave","Plave","ㅍㄹㅇㅂ","노아","예준","하민","밤비","은호","버추얼","VLAST"]'
 WHERE key = 'plave';

-- ISEDOL: 영문 소문자/Title case 만. "이세돌"(바둑기사) / "이세계"(장르)
-- 충돌 회피로 한글 변형은 보강하지 않는다.
UPDATE groups
   SET context_keywords = '["이세계아이돌","ISEGYE IDOL","ISEDOL","isedol","Isedol","릴파","아이네","징버거","주르르","고세구","비챤","버추얼","왁타버스"]'
 WHERE key = 'isedol';

-- STELLIVE: 영문 소문자/대문자/Title case. "스텔" 단독은 2자 충돌 회피로
-- 보강하지 않는다 (anchor 동반 시 어차피 다른 키워드로 잡힘).
UPDATE groups
   SET context_keywords = '["스텔라이브","StelLive","stellive","STELLIVE","Stellive","유니","후야","시부키","히나","마시로","리제","타비","나나","린","리코","버추얼"]'
 WHERE key = 'stellive';

-- SKINZ: 영문 소문자/Title case + 한글 초성 'ㅅㅋㅈ' (3자모).
UPDATE groups
   SET context_keywords = '["SKINZ","skinz","Skinz","ㅅㅋㅈ","스킨즈","도빈","다엘","태오","핀","재온","이랑","율","버추얼","Bridge"]'
 WHERE key = 'skinz';

-- MY:RAKL: 콜론 변형이 핵심. 검색 엔진/사용자 표기가 콜론을 누락하거나
-- 공백으로 치환하는 경우가 흔함. 영문 소문자/대문자/Title case 모두 시드.
-- "ㅁㄹㅋ"(미라클 초성, 3자) 사용자 요청 2026-05-25 으로 추가.
UPDATE groups
   SET context_keywords = '["MY:RAKL","my:rakl","myrakl","MYRAKL","Myrakl","MY RAKL","마이라클","미라클","ㅁㄹㅋ","새온","유성","하이든","제하","설","ACCORD","버추얼"]'
 WHERE key = 'myrakl';

-- OWIS: 영문 소문자/Title case + 한글 초성 'ㅇㅇㅅ' (3자모).
UPDATE groups
   SET context_keywords = '["OWIS","owis","Owis","ㅇㅇㅅ","오위스","Only When I Sleep","썸머","소이","세린","하루","유니","ama","버추얼"]'
 WHERE key = 'owis';

-- WeGoSix: 가장 표기 변형이 많은 그룹. 영문 case/하이픈/공백/숫자 변형
-- 전부 + 한글 초성 'ㅇㄱㅅㅅ'(4자모) + 한글+숫자 '위고6'. 사용자 보고
-- 2026-05-25 에 따른 핵심 변경.
--   - "WE GO-6" (시드) / "WEGO6" (시드) / "wegosix" (시드) / "위고식스" (시드)
--   - 추가: "WeGoSix"(camelCase), "WEGOSIX"(대문자 no-hyphen),
--           "Wegosix"(Title), "WE GO 6"(공백), "WeGo6"(camelCase 숫자),
--           "wego6"(소문자 no-hyphen), "we go six"(소문자 영문 number),
--           "WE GO SIX"(대문자 영문 number), "위고6"(한글+숫자),
--           "ㅇㄱㅅㅅ"(초성 4자모).
UPDATE groups
   SET context_keywords = '["23rd Century Kids","wegosix","위고식스","WE GO-6","WEGO6","WeGoSix","WEGOSIX","Wegosix","WE GO 6","WeGo6","wego6","we go six","WE GO SIX","위고6","ㅇㄱㅅㅅ","시우","해일","산호","진휘","우연"]'
 WHERE key = 'wegosix';

-- B:DAWN: MY:RAKL 와 같은 콜론 변형 + 하이픈/공백 변형. "ㅂㄷ"(2자,
-- 비던 초성) 사용자 요청 2026-05-25 으로 추가 — short-token 게이트가
-- anchor (B:DAWN / 비던) 동시 출현을 강제하므로 일반어 충돌 차단됨.
UPDATE groups
   SET context_keywords = '["B:DAWN","b:dawn","bdawn","BDAWN","Bdawn","B-DAWN","B DAWN","비던","ㅂㄷ","BEOM","범","강호","서도진","임이온","이한솔","송우림","Duri","IPX","버추얼"]'
 WHERE key = 'bdawn';

-- ============================================================
-- B. WeGoSix DC 갤러리 등록 + supplemental
-- ============================================================

UPDATE groups
   SET dc_gallery_id = 'wegosix',
       dc_supplemental_galleries = '["vboyband"]'
 WHERE key = 'wegosix';
