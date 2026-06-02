from unittest.mock import MagicMock
from idol_sight.llm.gemini import GeminiClient


def _fake_client(text: str, uris: list[str]):
    resp = MagicMock()
    resp.text = text
    chunk = MagicMock()
    chunk.web.uri = uris[0] if uris else None
    cand = MagicMock()
    cand.grounding_metadata.grounding_chunks = [chunk] if uris else []
    resp.candidates = [cand]
    fake = MagicMock()
    fake.models.generate_content = MagicMock(return_value=resp)
    return fake


def test_generate_grounded_returns_text_and_sources():
    fake = _fake_client("리서치 결과 텍스트", ["https://example.com/a"])
    c = GeminiClient(api_key="x", client=fake)
    out = c.generate_grounded(prompt="조사해줘")
    assert out.text == "리서치 결과 텍스트"
    assert out.sources == ["https://example.com/a"]
    _, kwargs = fake.models.generate_content.call_args
    assert kwargs["model"]
    assert kwargs["config"] is not None


def test_generate_grounded_handles_no_sources():
    fake = _fake_client("텍스트만", [])
    c = GeminiClient(api_key="x", client=fake)
    out = c.generate_grounded(prompt="조사")
    assert out.text == "텍스트만"
    assert out.sources == []
