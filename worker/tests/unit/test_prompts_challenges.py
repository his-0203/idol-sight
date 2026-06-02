from idol_sight.llm.prompts import (
    CHALLENGE_CLASSIFY_SYSTEM,
    CHALLENGE_DISCOVERY_PROMPT,
    CHALLENGE_SCHEMA,
    CHALLENGE_STRUCTURE_SYSTEM,
)


def test_classify_system_prompt():
    s = CHALLENGE_CLASSIFY_SYSTEM
    assert "video_id" in s              # 풀의 video_id 에서만 예시 선택
    assert "example_video_ids" in s
    assert "원곡 아티스트" in s          # 원곡자 본인 클립 우선
    assert "dance" in s and "meme" in s


def test_classify_system_count_and_longtail_target():
    # V2 풍부화 — 개수 목표(최대 10) + 중소·신생 그룹 롱테일 포함 + 최신성 3개월 완화.
    s = CHALLENGE_CLASSIFY_SYSTEM
    assert "10" in s                    # 최대 10개 개수 목표
    assert "중소" in s or "신생" in s    # 롱테일(떠오르는 중소·신생) 포함 지시
    assert "1.5개월" in s                # 최신성 게이트 1개월 → 1.5개월 완화


def test_discovery_prompt_has_core_constraints():
    p = CHALLENGE_DISCOVERY_PROMPT
    assert "7일" in p
    assert "출처" in p
    assert "K-POP" in p
    assert "챌린지" in p
    assert "Shorts" in p   # 챌린지 클립 URL 요구
    assert "MV" in p       # 공식 MV 제외 명시


def test_discovery_prompt_recency_and_lifecycle():
    p = CHALLENGE_DISCOVERY_PROMPT
    assert "{today}" in p and "{week_ago}" in p   # 날짜 주입 placeholder
    assert "제외" in p                              # 오래된 챌린지 제외
    assert "momentum" in p                          # 생애주기 추정 요구
    assert "발매일" in p                            # 원곡 발매일 게이트(옛 곡 배제)
    assert "그룹명_곡명" in p                        # 해시태그 실제 형식 지침
    assert "원곡 아티스트" in p                       # 예시는 원곡자 본인 클립 우선
    assert "곡명" in p                               # 이름에 가수명-곡명 포함 지침


def test_structure_system_mentions_miiwan_and_tag():
    s = CHALLENGE_STRUCTURE_SYSTEM
    assert "MiiWAN" in s
    assert "dance" in s and "meme" in s   # tag: 댄스/밈
    assert "example_urls" in s   # 챌린지 클립 URL 추출 지시
    assert "momentum" in s       # 생애주기 추출 지시


def test_challenge_schema_shape():
    props = CHALLENGE_SCHEMA["properties"]["challenges"]["items"]["properties"]
    for key in ("name", "tag", "description", "hashtags", "source_urls",
                "example_urls", "started_around", "momentum", "valid_until",
                "confidence", "miiwan_fit"):
        assert key in props
    assert props["tag"]["enum"] == ["dance", "meme"]
    assert props["momentum"]["enum"] == ["rising", "peaking", "declining", "unknown"]
