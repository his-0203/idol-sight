-- 0007_group_model.sql — entity-type taxonomy for the 8 tracked groups.
--
-- Anthropologist's V2 finding: PLAVE / ISEDOL / STELLIVE are not the
-- same kind of social entity. Treating them with one identical Health
-- Score formula structurally under-rates V-tuber-style groups (whose
-- core KPI is intimacy/livestream, not album sales) while over-
-- attributing PLAVE-style metrics to corporate-K-pop groups. We
-- classify each group into one of three models so the 4-factor Health
-- Score can apply different weights per model:
--
--   corporate    K-pop 정통 — group channel = primary entity, member
--                 metrics decompose from group totals. Weights favor
--                 RitualVictory (음방 1위) + Mobilization (초동).
--                 Default. Members may have no solo presence at all.
--                 Examples: PLAVE, SKINZ, MY:RAKL, OWIS, MiiWAN, B:DAWN.
--
--   segmentary   왁타버스 / patron-IP satellite — group is a
--                 situational aggregation of solo activity. Solo:group
--                 ratio ~80:20. Weights favor Mobilization + Intimacy
--                 (live, member channels). Member channel data is
--                 first-class; group totals must aggregate them.
--                 Example: ISEDOL.
--
--   confederation V-tuber-style umbrella — each member is a strong
--                 individual brand; the group is informational.
--                 Weights heavily favor Intimacy (slot views, super
--                 chat, collab frequency). Group score is best read
--                 alongside a member-portfolio view.
--                 Example: STELLIVE.
--
-- Default 'corporate' so any future group inserted without the column
-- being set still gets a sane evaluation. We seed the three known
-- exceptions explicitly.

ALTER TABLE groups ADD COLUMN group_model TEXT DEFAULT 'corporate';

UPDATE groups SET group_model='segmentary'   WHERE key='isedol';
UPDATE groups SET group_model='confederation' WHERE key='stellive';
