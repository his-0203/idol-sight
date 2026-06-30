-- 0103_naver_articles_match_score.sql — 뉴스 기사 그룹 귀속 정확도.
--
-- 동기:
--   그룹 상세 PR/리스크 탭에 다른 그룹(예: ISEDOL 탭에 BTHD·비던) 기사가
--   섞였다. 원인은 NewsFilter 가 context_keywords 를 anchor 없이 단순
--   substring 매칭해, "버추얼" 같은 공유 장르어 하나만으로 통과시킨 것.
--   relevance.py(커뮤니티) 는 이미 generic-blocklist + anchor 게이트로
--   막아둔 동일 누수를 뉴스 경로만 빠뜨렸다.
--
--   forward 수정: NewsFilter 에 anchor/generic 게이트를 이식하고, 기사가
--   어느 그룹의 "주제"인지 점수(match_score)를 매긴다. url_hash 는 PK 라
--   한 기사 = 한 행 = 한 group_key 이므로, 라운드업 기사는 점수가 가장
--   높은(=주제) 그룹에만 귀속되도록 collector 의 ON CONFLICT 가 중재한다.
--
--   이 마이그레이션은 그 중재에 필요한 match_score 컬럼만 추가한다(신규
--   수집 0). 기존 적재분 재평가/재귀속은 별도 백필
--   (`reeval-naver-relevance` CLI) 가 title 기준으로 멱등 재계산한다.

ALTER TABLE naver_articles ADD COLUMN match_score INTEGER NOT NULL DEFAULT 0;
