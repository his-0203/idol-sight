-- migrations/0061_miiwan_dc_gallery_and_keywords.sql — V2.26
--
-- MiiWAN 커뮤니티 수집 보완.
--
-- 1) dc_gallery_id 등록
--    0002_seed 시점(2026-05-04)에는 미완소년 디시 갤러리가 아직
--    개설되지 않아 dc_gallery_id 를 NULL 로 두고 "revisit in a 0003_*
--    migration once the gallery opens" 라는 주석을 남겨두었다.
--    2026-05-21 마이너 갤러리 'miiwansonyeon' 개설 확인
--    (https://gall.dcinside.com/mgallery/board/lists/?id=miiwansonyeon).
--    DcCollector 가 canonical URL 패턴 (/board/lists/?id=<gid>) 으로
--    fetch 후 JS redirect 로 mgallery 에 도달하므로, gid 만 등록하면
--    기존 collector 코드를 수정하지 않아도 동작한다.
--
-- 2) context_keywords 확장 — 영문/약어 표기 변형 보강
--    is_relevant 의 long-token fast path 는 case-sensitive substring
--    매칭이고(코드 디자인: 운영자가 두 표기를 모두 시드하는 컨벤션,
--    test_relevance.py 가 명시적으로 검증), 데뷔 전 그룹인 MiiWAN 은
--    팬들이 자유로운 표기를 쓰기 때문에 더쿠 / 인스티즈 / 네이버에서
--    아래 변형들이 누락되고 있었다:
--      - "miiwan" (소문자) — 가장 흔한 일반 사용자 표기
--      - "MIIWAN" (대문자) — 강조 표기
--      - "ㅁㅇㅅㄴ"      — 한국 커뮤니티 초성 약자
--    "ㅁㅇㅅㄴ" 4자모 시퀀스는 자연어 단어 / 타 그룹 초성과 충돌하지
--    않는다(PLAVE=ㅍㄹㅇㅂ, ISEDOL=ㅇㅅㄷ, STELLIVE=ㅅㅌㄹㅇㅂ,
--    OWIS=ㅇㅇㅅ, B:DAWN=ㅂㄷ — 모두 상이). 글로벌 키워드로 안전.
--
-- 영향 범위
--   - DC: MiiWAN 디시 갤러리 24/7 수집 활성화. orchestrator 가 다음
--     실행부터 community_posts / community_post_stats 적재.
--   - TheQoo / Instiz: 핫보드 기반 필터링이라 구조적 한계(데뷔 전
--     그룹은 핫에 잘 안 오름)는 남지만, 위 3개 변형으로 case / 약자
--     누락 표제 매칭률이 상승.
--   - Naver: _search_terms.expand_search_terms 가 context_keywords 를
--     aliases 로 전달하지만 GENERIC_KEYWORD_BLOCKLIST + length gate 로
--     필터되므로 위 변형들은 검색 쿼리 확장 후보로 일부 추가될 수
--     있다(영향 미미, 본 마이그레이션의 주 의도는 hot-board 필터).
--
-- Rollback
--   UPDATE groups SET dc_gallery_id = NULL,
--          context_keywords = '["MiiWAN","미완소년","나이선","임온","마하진","안석우","원주율","어비스컴퍼니","ABYSS","IPX","버추얼"]'
--    WHERE key = 'miiwan';

UPDATE groups
   SET dc_gallery_id = 'miiwansonyeon',
       context_keywords = '["MiiWAN","miiwan","MIIWAN","미완소년","ㅁㅇㅅㄴ","나이선","임온","마하진","안석우","원주율","어비스컴퍼니","ABYSS","IPX","버추얼"]'
 WHERE key = 'miiwan';
