-- 0092: Debut Window thin-sample 방어 (V2.50).
--
-- organicity 헤드라인(simple mean)은 볼륨과 무관하게 계산돼, scored 영상이
-- 1~2개뿐인 버킷도 자신만만한 organic_strong 을 표시한다 — "적게 올리고
-- 오가닉이라는 이유로 높은 점수"(운영자 지적). 두 컬럼 추가:
--   * scored_video_count        : insufficient_data 를 제외한 실제 표본 수
--                                 (평균/비율의 분모). 프런트 thin-sample 배지용.
--   * organic_score_mean_shrunk : simple mean 을 중립 prior(55)로 수축한
--                                 헤드라인 값 — (n·mean + k·55)/(n+k), k=3.
--                                 raw mean 컬럼은 그대로 보존(catalog/reach 렌즈).
--
-- 둘 다 build_summary 전체 재계산이 다음 cron 에서 채운다(백필 불필요).
-- 기존 행은 채워지기 전까지 NULL → 프런트는 shrunk ?? simple 로 폴백.

ALTER TABLE debut_window_organicity_summary ADD COLUMN scored_video_count INTEGER;
ALTER TABLE debut_window_organicity_summary ADD COLUMN organic_score_mean_shrunk REAL;
