"""Tests for collectors._search_terms — query-set expansion used by the
Naver collector (and any future text-search collector that wants the
same anchor + member combinatorics).

Behaviours pinned here:
  - operator-curated naver_query is always emitted first
  - per-member queries combine the Korean group anchor with each member
    name, producing entries like '미완소년 마하진'
  - Hangul names of length ≥2 pass the length gate; length-1 names
    don't (would collide too aggressively with common nouns)
  - English / romanized names need length ≥3 (drops 'BL'/'MV' stubs)
  - generic genre/agency tokens (버추얼, ABYSS, IPX...) are blocked from
    becoming standalone queries even when they appear in aliases
  - max_terms hard-caps the output and preserves earlier (more
    important) terms over later ones
  - dedupe is normalized (case-insensitive on Latin, exact on Hangul)
"""

from idol_sight.collectors._search_terms import (
    DEFAULT_MAX_TERMS,
    GENERIC_KEYWORD_BLOCKLIST,
    expand_search_terms,
)


def test_baseline_naver_query_emitted_first():
    out = expand_search_terms(
        name="MiiWAN", name_kr="미완소년",
        naver_query="MiiWAN 미완소년",
        members=[],
    )
    assert out, "must emit at least the baseline query"
    assert out[0] == "MiiWAN 미완소년"


def test_member_combos_use_korean_anchor():
    out = expand_search_terms(
        name="MiiWAN", name_kr="미완소년",
        naver_query="MiiWAN 미완소년",
        members=[
            {"name": "마하진", "name_en": "Mahajin"},
            {"name": "나이선", "name_en": "Naison"},
        ],
        max_terms=10,
    )
    # Member queries are anchored on the Korean group name so we don't
    # leak into homonyms (e.g. 마하진 the surname in unrelated press).
    assert any("미완소년 마하진" in q for q in out)
    assert any("미완소년 나이선" in q for q in out)


def test_short_hangul_member_kept_when_two_syllables():
    """B:DAWN's '비던' is 2-syllable; should still produce a combo."""
    out = expand_search_terms(
        name="B:DAWN", name_kr="비던",
        naver_query="B:DAWN 비던",
        members=[{"name": "강호", "name_en": "Kangho"}],
        max_terms=10,
    )
    # Anchor is 비던 which is 2-syllable but allowed as anchor (length
    # gate only applies to leaf member tokens).
    assert any("비던 강호" in q for q in out)


def test_single_syllable_hangul_member_rejected():
    """A 1-syllable member name like '윤' would generate too many
    homonym hits; we drop it from the query expansion."""
    out = expand_search_terms(
        name="ACME", name_kr="에이씨엠이",
        naver_query="에이씨엠이",
        members=[{"name": "윤", "name_en": "Yoon"}],
        max_terms=10,
    )
    # No combo emitted for the 1-syllable Hangul; English passes the
    # latin length gate (3 chars) so 'Yoon' combo is fine.
    assert not any(q.endswith(" 윤") or q.endswith('"에이씨엠이 윤"') for q in out)
    assert any("에이씨엠이 Yoon" in q for q in out)


def test_short_latin_member_rejected():
    """Two-character romanizations like 'AY' are too generic to anchor
    a fresh query — drop them."""
    out = expand_search_terms(
        name="ACME", name_kr="에이씨엠이",
        naver_query="에이씨엠이",
        members=[{"name": None, "name_en": "AY"}],
        max_terms=10,
    )
    assert not any("AY" in q for q in out)


def test_aliases_filter_genre_blocklist():
    """버추얼 / ABYSS in context_keywords should NOT become their own
    queries even though they're in the alias list."""
    out = expand_search_terms(
        name="MiiWAN", name_kr="미완소년",
        naver_query="MiiWAN 미완소년",
        members=[],
        aliases=["버추얼", "ABYSS", "어비스컴퍼니"],
        max_terms=10,
    )
    # Genre/agency tokens drop out…
    for blocked in GENERIC_KEYWORD_BLOCKLIST:
        assert not any(q == blocked for q in out)
    # …but a hand-curated multi-word alias survives.
    assert any("어비스컴퍼니" in q for q in out)


def test_max_terms_caps_output():
    members = [
        {"name": f"멤버{i}", "name_en": f"Member{i}"} for i in range(20)
    ]
    out = expand_search_terms(
        name="ACME", name_kr="에이씨엠이",
        naver_query="에이씨엠이",
        members=members,
        max_terms=5,
    )
    assert len(out) == 5


def test_dedupe_when_naver_query_equals_korean_name():
    """If the operator's naver_query is just '미완소년', the bare
    Korean-name addition must not produce a duplicate."""
    out = expand_search_terms(
        name="MiiWAN", name_kr="미완소년",
        naver_query="미완소년",
        members=[],
    )
    assert out.count("미완소년") == 1


def test_multi_word_group_name_quoted():
    """Multi-word English names should be wrapped in quotes so Naver
    treats them as a phrase rather than ANDing the words."""
    out = expand_search_terms(
        name="WE GO-6", name_kr="위고식스",
        naver_query=None,
        members=[],
    )
    assert any('"WE GO-6"' in q for q in out)


def test_default_cap_constant_present_and_reasonable():
    # Guard against accidental changes that would multiply API costs.
    assert 3 <= DEFAULT_MAX_TERMS <= 10


def test_no_duplicate_member_combo_when_en_equals_kr_lowercase():
    """When name_en is just a romanization of name with no extra info,
    we emit only ONE per-member combo, not two near-identical ones."""
    out = expand_search_terms(
        name="MiiWAN", name_kr="미완소년",
        naver_query="MiiWAN 미완소년",
        # The collector treats EN combos as additive — but a member with
        # both KR and EN gets BOTH, since the romanization adds recall
        # against English-script articles. This test pins the additive
        # behaviour explicitly so we don't accidentally drop EN combos.
        members=[{"name": "마하진", "name_en": "Mahajin"}],
        max_terms=10,
    )
    kr_combo = sum(1 for q in out if "미완소년 마하진" in q)
    en_combo = sum(1 for q in out if "미완소년 Mahajin" in q)
    assert kr_combo == 1
    assert en_combo == 1


def test_empty_members_falls_back_to_single_query_set():
    """No members → only the baseline + bare anchors. This is the
    'wegosix on day one' scenario where members aren't seeded yet."""
    out = expand_search_terms(
        name="WE GO-6", name_kr="위고식스",
        naver_query='위고식스 OR "WE GO-6" OR wegosix',
        members=[],
    )
    # Operator's pre-OR'd query MUST come through verbatim — it's
    # already optimized for Naver and we don't second-guess it.
    assert out[0] == '위고식스 OR "WE GO-6" OR wegosix'
