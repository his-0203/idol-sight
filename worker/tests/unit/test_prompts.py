"""Smoke tests for the weekly LLM system prompt.

We don't try to validate the *content* of LLM output here — that lives
in eval. These tests guard the static structure: the prompt must
mention each constraint that other code relies on (canonical names,
ai_comment field, ipx_action discipline) so a refactor that drops a
section fails CI loudly.
"""

from idol_sight.llm.prompts import (
    PROMPT_WEEKLY,
    PROMPT_WEEKLY_TAIL_AI_COMMENT,
)


def test_prompt_weekly_includes_canonical_names_block():
    # If 마이래클/미이완 sneak back into the prompt, the dashboard
    # tabs render with mismatched display names. The canonical table
    # is the single source of truth.
    for token in ("PLAVE", "ISEDOL", "MiiWAN", "미라클", "미완소년"):
        assert token in PROMPT_WEEKLY, f"missing canonical token: {token}"


def test_prompt_weekly_includes_ai_comment_guidelines():
    # Migration 0039 added the ai_comment column. The prompt must also
    # train the model on when/how to emit it, otherwise the column
    # stays NULL forever and the new UI slot looks broken.
    assert "ai_comment" in PROMPT_WEEKLY
    assert "60자 이내" in PROMPT_WEEKLY_TAIL_AI_COMMENT
    # Anti-pattern guard MUST be reused for ai_comment too — same
    # vocabulary that ruined ipx_action would ruin the badge.
    for anti in ("전략적", "면밀히"):
        assert anti in PROMPT_WEEKLY_TAIL_AI_COMMENT, (
            f"ai_comment guideline must call out anti-pattern: {anti}"
        )


def test_prompt_weekly_keeps_ipx_action_discipline():
    # Sanity: adding the ai_comment block must not have displaced the
    # existing ipx_action 5-element discipline.
    for token in ("VERB-FIRST", "DUE", "OWNER", "MEASURABLE", "EXEMPLARS"):
        assert token in PROMPT_WEEKLY, f"missing ipx_action section: {token}"
