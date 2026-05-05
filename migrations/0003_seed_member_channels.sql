-- 0003_seed_member_channels.sql — populate members.yt_channel_id for the
-- groups whose solo activity dominates over the group channel.
--
-- Why: ISEDOL (Waktaverse) and STELLIVE (V-tuber model) members are far
-- more active on their personal channels than on the group channel.
-- Without these IDs the channel-stats collector never fetches member
-- subscribers, the YouTube collector never indexes member videos, and
-- the agg_summary / member_popularity layers ignore most of the actual
-- audience. The group channel alone shows ~120K subs for ISEDOL while
-- members' combined subscribers exceed 8M — a ~70× under-count.
--
-- All channel IDs verified 2026-05-04 by curling
-- https://www.youtube.com/@<handle>/about and reading the externalId
-- field, with the page <title> cross-checked against the Korean stage
-- name. Sources cited inline.

-- ─── ISEDOL (Waktaverse, 6 members) ────────────────────────────────
-- @lilpa0309    title="릴파 LILPA"      → UCvs0Brn0-cc9Nu8U5h8tnfQ
-- @INE_         title="아이네 INE"      → UCroM00J2ahCN6k-0-oAiDxg
-- @jingburger   title="징버거 JINGBURGER" → UCHE7GBQVtdh-c1m3tjFdevQ
-- @jururu7      title="주르르 JURURU"   → UCUKN9rymgfWI9Zy4naPSLJw
-- @gosegu       title="고세구 GOSEGU"   → UCV9WL7sW6_KjanYkUUaIDfQ
-- @viichan6     title="비챤 VIICHAN"    → UCkUk0vX2Y5lKYbBKmiyTJEw
UPDATE members SET yt_channel_id='UCvs0Brn0-cc9Nu8U5h8tnfQ' WHERE group_key='isedol' AND name='릴파';
UPDATE members SET yt_channel_id='UCroM00J2ahCN6k-0-oAiDxg' WHERE group_key='isedol' AND name='아이네';
UPDATE members SET yt_channel_id='UCHE7GBQVtdh-c1m3tjFdevQ' WHERE group_key='isedol' AND name='징버거';
UPDATE members SET yt_channel_id='UCUKN9rymgfWI9Zy4naPSLJw' WHERE group_key='isedol' AND name='주르르';
UPDATE members SET yt_channel_id='UCV9WL7sW6_KjanYkUUaIDfQ' WHERE group_key='isedol' AND name='고세구';
UPDATE members SET yt_channel_id='UCkUk0vX2Y5lKYbBKmiyTJEw' WHERE group_key='isedol' AND name='비챤';

-- ─── STELLIVE (10 members across 1기 EVERYS / 2기 UNIVERSE / 3기 cliché) ─
-- @ayatsunoyuni       "아야츠노 유니 AYATSUNO YUNI"  → UClbYIn9LDbbFZ9w2shX3K0g
-- @Sakihanechannel    "사키하네 후야 SAKIHANE HUYA"  → UC0YQnenKBCu5sGb7H61n6HA
-- @shirayukihina      "시라유키 히나 SHIRAYUKI HINA" → UC1afpiIuBDcjYlmruAa0HiA
-- @neneko_mashiro     "네네코 마시로 NENEKO MASHIRO" → UC_eeSpMBz8PG4ssdBPnP07g
-- @akanelize          "아카네 리제 AKANE LIZE"       → UC7-m6jQLinZQWIbwm9W-1iw
-- @arahashitabi       "아라하시 타비 ARAHASHI TABI"  → UCAHVQ44O81aehLWfy9O6Elw
-- (channel)           "텐코 시부키 TENKO SHIBUKI"    → UCYxLMfeX1CbMBll9MsGlzmw
-- (channel)           "아오쿠모 린 AOKUMO RIN"       → UCQmcltnre6aG9SkDRYZqFIg
-- @hanako_nana        "하나코 나나 HANAKO NANA"      → UCcA21_PzN1EhNe7xS4MJGsQ
-- (channel)           "유즈하 리코 YUZUHA RIKO"      → UCj0c1jUr91dTetIQP2pFeLA
UPDATE members SET yt_channel_id='UClbYIn9LDbbFZ9w2shX3K0g' WHERE group_key='stellive' AND name='아야츠노 유니';
UPDATE members SET yt_channel_id='UC0YQnenKBCu5sGb7H61n6HA' WHERE group_key='stellive' AND name='사키하네 후야';
UPDATE members SET yt_channel_id='UCYxLMfeX1CbMBll9MsGlzmw' WHERE group_key='stellive' AND name='텐코 시부키';
UPDATE members SET yt_channel_id='UC1afpiIuBDcjYlmruAa0HiA' WHERE group_key='stellive' AND name='시라유키 히나';
UPDATE members SET yt_channel_id='UC_eeSpMBz8PG4ssdBPnP07g' WHERE group_key='stellive' AND name='네네코 마시로';
UPDATE members SET yt_channel_id='UC7-m6jQLinZQWIbwm9W-1iw' WHERE group_key='stellive' AND name='아카네 리제';
UPDATE members SET yt_channel_id='UCAHVQ44O81aehLWfy9O6Elw' WHERE group_key='stellive' AND name='아라하시 타비';
UPDATE members SET yt_channel_id='UCcA21_PzN1EhNe7xS4MJGsQ' WHERE group_key='stellive' AND name='하나코 나나';
UPDATE members SET yt_channel_id='UCQmcltnre6aG9SkDRYZqFIg' WHERE group_key='stellive' AND name='아오쿠모 린';
UPDATE members SET yt_channel_id='UCj0c1jUr91dTetIQP2pFeLA' WHERE group_key='stellive' AND name='유즈하 리코';
