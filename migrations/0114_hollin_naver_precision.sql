-- migrations/0114_hollin_naver_precision.sql
--
-- WhOLLiN(홀린) 네이버 뉴스 오탐 정화 — 0112(MYRAKL '미라클')와 동일 병리.
-- name_kr '홀린'이 동사 활용("2030 홀린 갤럭시", "말레이시아 홀린 K-푸드")과
-- 충돌하는 데다, context_keywords에 '플레이리스트'·'네이버웹툰'(초광범위
-- 일반어·기업명)까지 trusted 로 들어 있어 수집 169건 중 139건이 관련성
-- 필터를 통과 — SoV 뉴스 축(백분위)을 오염시켜 시장 위치 순위를 왜곡.
--
-- 조치(2026-08-04, 저장 169건 제목 전수 시뮬레이션): '홀린'·'플레이리스트'·
-- 'Playlist'·'네이버웹툰' 단독 신뢰 제거 → 8/169 (전부 진짜 데뷔 기사,
-- 리콜 역검증 8/8 일치). 진짜 기사는 '버추얼'(generic)+앵커(name_kr '홀린')
-- 경로로 계속 매칭된다. blacklist 불변.
--
-- 소급 적용: 마이그레이션 후 backfill-naver-relevance(apply) 재실행.
UPDATE groups
   SET context_keywords = '["WhOLLiN","Whollin","whollin","WHOLLIN","버추얼","버추얼보이그룹"]'
 WHERE key = 'hollin';
