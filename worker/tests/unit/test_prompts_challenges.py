from idol_sight.llm.prompts import (
    CHALLENGE_DISCOVERY_PROMPT,
    CHALLENGE_STRUCTURE_SYSTEM,
    CHALLENGE_SCHEMA,
)


def test_discovery_prompt_has_core_constraints():
    p = CHALLENGE_DISCOVERY_PROMPT
    assert "7일" in p
    assert "출처" in p
    assert "K-POP" in p
    assert "챌린지" in p


def test_structure_system_mentions_miiwan_and_tag():
    s = CHALLENGE_STRUCTURE_SYSTEM
    assert "MiiWAN" in s
    assert "kpop" in s and "general" in s


def test_challenge_schema_shape():
    props = CHALLENGE_SCHEMA["properties"]["challenges"]["items"]["properties"]
    for key in ("name", "tag", "description", "hashtags",
                "source_urls", "confidence", "miiwan_fit"):
        assert key in props
    assert CHALLENGE_SCHEMA["properties"]["challenges"]["items"]["properties"]["tag"]["enum"] == ["kpop", "general"]
