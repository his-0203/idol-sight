-- 0013_drop_myrakl_alias.sql — drop the incorrect "마이라클" alias from
-- MY:RAKL's context_keywords. The official Korean name is "미라클";
-- "마이라클" was a misread early in the seed (operator-confirmed
-- 2026-05-05). Keeping it widens the keyword surface for false-positive
-- matches on unrelated 마이/라클 substrings without earning any real
-- signal — the canonical "미라클" already covers Korean content.
--
-- Forward-compat: the JSON list also currently contains "버추얼" (gone
-- already in 0012) and "ACCORD" (legitimate label retained). We only
-- strip the single "마이라클" token here.

UPDATE groups
   SET context_keywords = REPLACE(
                            REPLACE(
                              REPLACE(context_keywords, ',"마이라클"', ''),
                              '"마이라클",', ''
                            ),
                            '"마이라클"', ''
                          )
 WHERE key = 'myrakl' AND context_keywords LIKE '%"마이라클"%';
