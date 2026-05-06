"""Smoke tests for the weekly LLM system prompt.

We don't try to validate the *content* of LLM output here — that lives
in eval. These tests guard the static structure: the prompt must
mention each constraint that other code relies on (canonical names,
ai_comment field, ipx_action discipline) so a refactor that drops a
section fails CI loudly.
"""

from idol_sight.llm.prompts import (
    PROMPT_WEEKLY,
    PROMPT_WEEKLY_BODY_FORMATTING,
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


def test_prompt_weekly_includes_body_formatting_guidelines_block():
    # Frontend agent owns the lexicon-aware insight formatter
    # (insightFormat.ts). The system prompt must therefore train Gemini
    # on the contract — group-name fidelity, conservative `**bold**`
    # usage, and tone-bearing vocabulary — so cards arrive in a shape
    # the frontend can actually decorate. If this block disappears, the
    # cards regress to colorless walls of text.
    assert "BODY FORMATTING" in PROMPT_WEEKLY
    # The body formatting block itself must be exposed as a module
    # constant so other call sites (eval, prompt-version log) can pin
    # the exact text without re-parsing the full prompt.
    assert PROMPT_WEEKLY_BODY_FORMATTING in PROMPT_WEEKLY
    assert "BODY FORMATTING" in PROMPT_WEEKLY_BODY_FORMATTING


def test_body_formatting_guidelines_lists_group_lexicon():
    # The badge color for each group is keyed off an EXACT spelling
    # match in the frontend (PLAVE → indigo, ISEDOL → fuchsia, …).
    # If the LLM drifts to "플라브" / "이세돌" / "미완완" the cards
    # render as plain black text and the dashboard looks broken.
    # Pin every canonical pair so a refactor can't quietly drop one.
    pairs = [
        ("PLAVE", "플레이브"),
        ("ISEDOL", "이세계아이돌"),
        ("STELLIVE", "스텔라이브"),
        ("SKINZ", "스킨즈"),
        ("MY:RAKL", "미라클"),
        ("OWIS", "오위스"),
        ("MiiWAN", "미완소년"),
        ("B:DAWN", "비던"),
    ]
    for en, ko in pairs:
        assert en in PROMPT_WEEKLY_BODY_FORMATTING, (
            f"body formatting block must list canonical English form: {en}"
        )
        assert ko in PROMPT_WEEKLY_BODY_FORMATTING, (
            f"body formatting block must list canonical Korean form: {ko}"
        )
    # The two recurring hallucinations the IPX team caught in eval —
    # 마이래클 (correct: 미라클) and 미이완 (correct: 미완소년) — are
    # already negative-listed in _CANONICAL_NAMES_BLOCK; the body
    # formatting block calls them out a second time so the rule is
    # local to the formatting context too.
    for hallucination in ("마이래클", "미이완"):
        assert hallucination in PROMPT_WEEKLY_BODY_FORMATTING, (
            f"body formatting block must explicitly forbid: {hallucination}"
        )


def test_body_formatting_guidelines_explains_markdown_bold_usage():
    # Frontend renders `**...**` as a heavier weight + tone class. The
    # rule is "≤3 spans per card, reserve for numbers / milestones /
    # contrast subjects". Without this guidance Gemini either bolds
    # nothing (frontend has nothing to emphasize) or bolds every
    # group name (visual noise that fights the badge color).
    # Token presence — the literal markdown markers must appear so
    # Gemini sees an example of the syntax it's supposed to emit.
    assert "**" in PROMPT_WEEKLY_BODY_FORMATTING
    # Quantitative cap — operators repeatedly flagged 5+ bold spans
    # per card as visually broken. The "3" budget must stay in the
    # prompt.
    assert "3" in PROMPT_WEEKLY_BODY_FORMATTING
    # Semantic cues for what TO bold (numbers / milestones) and what
    # NOT to (every group name / generic verbs).
    for cue in ("number", "milestone", "every group name"):
        assert cue.lower() in PROMPT_WEEKLY_BODY_FORMATTING.lower(), (
            f"body formatting block must mention bold-usage cue: {cue}"
        )


def test_body_formatting_guidelines_lists_tone_lexicon_terms():
    # Frontend tints these terms automatically. Listing them in the
    # prompt gives Gemini a concrete vocabulary to draw from instead
    # of falling back on color-less verbs ("기록했다", "나타났다") that
    # leave the card visually flat.
    positive_terms = ("상승", "돌파", "신기록", "가속", "약진", "견인")
    negative_terms = ("하락", "둔화", "급락", "부진", "리스크", "논란")
    for term in positive_terms + negative_terms:
        assert term in PROMPT_WEEKLY_BODY_FORMATTING, (
            f"body formatting block must list tone lexicon term: {term}"
        )


def test_prompt_weekly_includes_good_vs_bad_exemplars():
    # The exemplars are the cheapest way to teach formatting because
    # Gemini imitates shape more reliably than it follows abstract
    # rules. Pin both a positive and a negative pattern so a refactor
    # can't silently drop the negative anti-example (which is what
    # actually stops the typo regressions).
    assert "GOOD" in PROMPT_WEEKLY
    assert "BAD" in PROMPT_WEEKLY
    # The anti-example specifically calls out the two typo modes
    # frontend cannot recover from (group-name hallucinations).
    assert "플라브" in PROMPT_WEEKLY
    assert "이세돌" in PROMPT_WEEKLY
