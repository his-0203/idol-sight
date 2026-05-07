from unittest.mock import MagicMock

from idol_sight.llm.music_show import (
    GROUP_KEY_ENUM,
    MUSIC_SHOW_WIN_OUTPUT_SCHEMA,
    PROGRAM_ENUM,
    PROMPT_MUSIC_SHOW_WIN,
    _validate_win,
    extract_music_show_wins,
)


# --- schema --------------------------------------------------------------


def test_schema_constant_shape():
    s = MUSIC_SHOW_WIN_OUTPUT_SCHEMA
    assert s["type"] == "object"
    items_schema = s["properties"]["items"]["items"]
    props = items_schema["properties"]
    for k in (
        "article_id", "is_music_show_win", "program", "episode_date",
        "group_key", "song_title", "confidence", "reasoning",
    ):
        assert k in props
    # required 의 minimum set 만 강제 — win=false 가 모든 다른 field
    # 누락 가능해야 하므로.
    assert items_schema["required"] == [
        "article_id", "is_music_show_win", "confidence",
    ]


def test_schema_enums_match_constants():
    item_props = (
        MUSIC_SHOW_WIN_OUTPUT_SCHEMA["properties"]["items"]["items"]["properties"]
    )
    assert set(item_props["program"]["enum"]) == set(PROGRAM_ENUM)
    assert set(item_props["group_key"]["enum"]) == set(GROUP_KEY_ENUM)


# --- prompt --------------------------------------------------------------


def test_prompt_lists_all_six_candidate_groups_and_programs():
    p = PROMPT_MUSIC_SHOW_WIN
    for gk in GROUP_KEY_ENUM:
        assert gk in p, f"group_key {gk!r} missing from prompt"
    for prog in PROGRAM_ENUM:
        assert prog in p, f"program {prog!r} missing from prompt"


def test_prompt_negatively_excludes_non_candidate_groups():
    """ISEDOL / STELLIVE / MiiWAN 은 음방 1위 후보가 아님 — prompt 가
    명시적으로 제외해야 LLM 이 false-positive 매칭을 안 한다."""
    p = PROMPT_MUSIC_SHOW_WIN
    assert "ISEDOL" in p
    assert "STELLIVE" in p
    assert "MiiWAN" in p


def test_prompt_lists_false_positive_guards():
    """사용자 컨텍스트의 hallucination 차단 단어를 명시 — '1위 후보',
    '음원 차트 1위' 같은 표현이 win=false 로 분류돼야 한다."""
    p = PROMPT_MUSIC_SHOW_WIN
    assert "1위 후보" in p
    assert "음원 차트 1위" in p


# --- _validate_win -------------------------------------------------------


def test_validate_win_false_always_passes():
    """is_music_show_win=False 는 모든 다른 field 누락 가능."""
    assert _validate_win({"is_music_show_win": False}) is True


def test_validate_win_true_with_full_fields():
    item = {
        "is_music_show_win": True,
        "program": "쇼챔피언",
        "group_key": "plave",
        "episode_date": "2026-04-23",
        "confidence": 0.92,
    }
    assert _validate_win(item) is True


def test_validate_win_rejects_missing_program():
    item = {
        "is_music_show_win": True,
        "group_key": "plave",
        "episode_date": "2026-04-23",
        "confidence": 0.9,
    }
    assert _validate_win(item) is False


def test_validate_win_rejects_missing_group_key():
    item = {
        "is_music_show_win": True,
        "program": "쇼챔피언",
        "episode_date": "2026-04-23",
        "confidence": 0.9,
    }
    assert _validate_win(item) is False


def test_validate_win_rejects_missing_episode_date():
    item = {
        "is_music_show_win": True,
        "program": "쇼챔피언",
        "group_key": "plave",
        "confidence": 0.9,
    }
    assert _validate_win(item) is False


def test_validate_win_rejects_low_confidence():
    item = {
        "is_music_show_win": True,
        "program": "쇼챔피언",
        "group_key": "plave",
        "episode_date": "2026-04-23",
        "confidence": 0.4,   # < 0.5
    }
    assert _validate_win(item) is False


# --- extract_music_show_wins ---------------------------------------------


def test_extract_empty_articles_skips_llm():
    """입력이 비어 있으면 LLM 호출 자체를 skip — 비용 절감."""
    fake_client = MagicMock()
    out = extract_music_show_wins(client=fake_client, articles=[])
    assert out == []
    fake_client.generate.assert_not_called()


def test_extract_drops_invalid_wins_keeps_valid_records():
    """Mock Gemini 가 1 valid win + 1 win=false + 1 invalid win 반환 →
    2 record (valid win + win=false) 만 유지, invalid win drop."""
    fake_client = MagicMock()
    fake_client.generate.return_value = {
        "items": [
            {
                "article_id": "url1",
                "is_music_show_win": True,
                "program": "쇼챔피언",
                "episode_date": "2026-04-23",
                "group_key": "plave",
                "song_title": "Pump Up The Volume",
                "confidence": 0.92,
                "reasoning": "쇼챔피언 1위 명시",
            },
            {
                "article_id": "url2",
                "is_music_show_win": False,
                "confidence": 0.4,
                "reasoning": "차트 1위 언급, 음방 아님",
            },
            {
                # win=true 인데 group_key 누락 → drop
                "article_id": "url3",
                "is_music_show_win": True,
                "program": "엠카운트다운",
                "episode_date": "2026-04-09",
                "confidence": 0.7,
                "reasoning": "그룹 추정 모호",
            },
        ],
    }
    out = extract_music_show_wins(
        client=fake_client,
        articles=[
            {"article_id": "url1", "title": "...", "snippet": ""},
            {"article_id": "url2", "title": "...", "snippet": ""},
            {"article_id": "url3", "title": "...", "snippet": ""},
        ],
    )
    fake_client.generate.assert_called_once()
    assert len(out) == 2
    win, miss = out
    assert win.article_id == "url1"
    assert win.is_music_show_win is True
    assert win.group_key == "plave"
    assert win.program == "쇼챔피언"
    assert win.song_title == "Pump Up The Volume"
    assert miss.article_id == "url2"
    assert miss.is_music_show_win is False
    assert miss.group_key is None


def test_extract_passes_schema_to_client():
    """LLM client 가 음방 schema 를 받았는지 검증."""
    fake_client = MagicMock()
    fake_client.generate.return_value = {"items": []}
    extract_music_show_wins(
        client=fake_client,
        articles=[{"article_id": "u1", "title": "t", "snippet": ""}],
    )
    _, kwargs = fake_client.generate.call_args
    assert kwargs["response_schema"] is MUSIC_SHOW_WIN_OUTPUT_SCHEMA
    assert "음방 1위" in kwargs["system_prompt"] or "music-show" in kwargs["system_prompt"].lower()
