-- 0084_fan_loyalty.sql — V2.46: 라이브 CCV 기반 팬 충성도 점수화.
--
-- 동기:
--   live_ccv_samples 데이터가 쌓이면서 "방송 시청자 / 구독자" 전환율로
--   그룹별 팬 충성도(얼마나 팬이 실제로 라이브를 챙겨 보는가)를 점수화한다.
--   데뷔 크리티컬 지표 — MiiWAN 데뷔 후 경쟁사 대비 팬 밀도 비교에 사용.
--
-- 변경 (2):
--   (1) ccv_tracked 확대 — corporate 8개 전부 (segmentary 그룹 제외).
--       기존: miiwan / plave / owis / wegosix (0080)
--       추가: skinz / myrakl / bdawn / bthd
--   (2) agg_fan_loyalty — 그룹당 1행, build_fan_loyalty 가 full DELETE+rebuild.

UPDATE groups SET ccv_tracked=1 WHERE key IN ('skinz','myrakl','bdawn','bthd');

CREATE TABLE IF NOT EXISTS agg_fan_loyalty (
  group_key        TEXT NOT NULL PRIMARY KEY,
  conversion_rate  REAL,            -- median peak CCV / subscribers (0~1)
  peak_ccv_median  REAL,            -- 윈도우 내 방송별 peak CCV 의 중앙값
  broadcast_count  INTEGER NOT NULL DEFAULT 0,
  subscribers      INTEGER,         -- 산정 시점 분모 (감사용)
  score            REAL,            -- 0~100, basis=insufficient 면 NULL
  basis            TEXT NOT NULL,   -- 'scored' | 'low_confidence' | 'insufficient'
  ccv_trend_pct    REAL,            -- 전반부→후반부 median peak 변화율 (표시용)
  trend_basis      TEXT NOT NULL DEFAULT 'unknown',  -- 'rising'|'falling'|'flat'|'unknown'
  window_days      INTEGER NOT NULL DEFAULT 56,
  snapshot_at      TEXT NOT NULL
);
