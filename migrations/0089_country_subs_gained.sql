-- 0089: 국가별 구독 유입(subscribersGained) 저장.
--
-- 도넛(지역별 구독 유입 분포)용. 절대 구독자수는 API가 국가별로 안 주지만,
-- 기간 내 '구독 증가'는 country 리포트에 있어(이미 sub_per_1k 계산에 fetch 중)
-- 저장만 추가. "어디 지역에서 구독이 많이 생기나"를 보여준다.

ALTER TABLE agg_youtube_analytics_country ADD COLUMN subs_gained INTEGER;
