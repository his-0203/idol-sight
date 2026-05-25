"""weekly_diagnosis — 가설 분류 + confidence + 메타가드."""

import math

from idol_sight.analysis.weekly_diagnosis import (
    HYPOTHESIS_KEYS, CONFIDENCE_LEVELS,
    Evidence, Hypothesis, GroupSignals,
)


def test_hypothesis_keys_complete():
    """spec rev 2 의 11 가설 (insufficient_signal 포함) 모두 enum 에 존재."""
    expected = {
        "organic_growth", "paid_youtube_ads", "subscriber_purchase",
        "comeback_cycle", "broadcast_appearance", "community_word_of_mouth",
        "controversy_spike", "platform_concentrated_promo",
        "member_centric_spike", "insufficient_signal",
    }
    assert set(HYPOTHESIS_KEYS) == expected


def test_confidence_levels_order():
    """confidence 등급 high → medium → low (감점 시 인덱스 +1)."""
    assert CONFIDENCE_LEVELS == ("high", "medium", "low")


def test_group_signals_empty_defaults():
    gs = GroupSignals(group_key="plave")
    assert gs.hypotheses == []
    assert gs.meta_guards == []
    assert gs.organicity is None
