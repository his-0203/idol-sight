-- 0097_awareness.sql — P2b: 인지도 지수 (Awareness Index).
--
-- 동기:
--   "버추얼 아이돌 인지도 순위" 요청에 직접 답하는 신규 표시 지표. 신규 수집 0 —
--   agg_summary 의 그룹별 최신 신호(구독·조회·뉴스)를 카테고리(K-POP/서브컬처)
--   리더 대비 log1p 정규화·가중(0.5/0.35/0.15)해 0~100 점수화하고, 카테고리별로
--   분리 랭킹한다. Health Score 와 독립된 1차원 지표(Health Reach 와 입력은
--   겹치나 목적이 다름) — 점수 산식 변경이 아니라 신규 표시 지표.
--
--   agg_awareness — 그룹·스냅샷별 1행, build_awareness 가 스냅샷별 멱등 쓰기
--   (DELETE FROM agg_awareness WHERE snapshot_at=? 후 INSERT). 과거 스냅샷은
--   보존해 인지도 시계열을 남긴다.

CREATE TABLE IF NOT EXISTS agg_awareness (
  group_key       TEXT NOT NULL,
  snapshot_at     TEXT NOT NULL,
  category        TEXT,             -- 'kpop' | 'subculture' (_category_of)
  awareness_score REAL,            -- 0~100, basis='insufficient' 면 NULL
  category_rank   INTEGER,          -- 카테고리 내 score 내림차순 순위(1=최고), insufficient 면 NULL
  sub_n           REAL,             -- 구독 정규화값 (log1p, 카테고리 리더 대비 0~1)
  view_n          REAL,             -- 조회 정규화값
  news_n          REAL,             -- 뉴스 정규화값
  basis           TEXT NOT NULL,    -- 'scored' | 'insufficient'
  generated_at    TEXT NOT NULL,
  PRIMARY KEY (group_key, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_aw_snapshot ON agg_awareness (snapshot_at);
