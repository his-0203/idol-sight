import json
from unittest.mock import MagicMock

from idol_sight.llm.gemini import INSIGHT_OUTPUT_SCHEMA, GeminiClient


def test_generate_returns_parsed_dict_from_response_text():
    fake_response = MagicMock()
    fake_response.text = json.dumps({
        "items": [{
            "scope": "market", "type": "insight",
            "title": "X", "body": "Y",
            "source_refs": [{"table": "agg_summary", "pk": "plave|2026-05-04",
                             "label": "PLAVE summary"}],
        }],
    })

    fake_models = MagicMock()
    fake_models.generate_content = MagicMock(return_value=fake_response)

    fake_genai = MagicMock()
    fake_genai.models = fake_models

    c = GeminiClient(api_key="fake", client=fake_genai)
    parsed = c.generate(
        system_prompt="you are an analyst",
        context={"foo": "bar"},
        response_schema=INSIGHT_OUTPUT_SCHEMA,
    )
    fake_models.generate_content.assert_called_once()
    args, kwargs = fake_models.generate_content.call_args
    config = kwargs.get("config") or args[-1]
    # Config must specify JSON output and the schema.
    assert "application/json" in str(config)

    assert "items" in parsed
    assert parsed["items"][0]["title"] == "X"


def test_schema_constant_has_expected_shape():
    s = INSIGHT_OUTPUT_SCHEMA
    assert s["type"] == "object"
    assert "items" in s["properties"]
    items_schema = s["properties"]["items"]
    assert items_schema["type"] == "array"
    item_props = items_schema["items"]["properties"]
    for k in ("scope", "type", "title", "body", "source_refs"):
        assert k in item_props


def test_schema_includes_optional_ai_comment():
    """ai_comment is in `properties` (so Gemini structured output can
    emit it) but NOT in `required` (so dropping the key on retries does
    not invalidate the response)."""
    s = INSIGHT_OUTPUT_SCHEMA
    item_schema = s["properties"]["items"]["items"]
    assert "ai_comment" in item_schema["properties"]
    assert item_schema["properties"]["ai_comment"]["type"] == "string"
    assert "ai_comment" not in item_schema["required"]
