"""Thin wrapper around google-genai for structured JSON outputs.

Tested via dependency injection: pass a fake `client` object exposing
`.models.generate_content(...)` to bypass the real SDK in unit tests.
"""

from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger(__name__)


# JSON Schema used by weekly insight generation. Frontend renders source_refs
# as inline back-link badges.
INSIGHT_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "scope": {"type": "string"},     # 'market' | <group_key>
                    "type":  {"type": "string"},     # 'insight' | 'ipx_action' | 'weekly'
                    "title": {"type": "string"},
                    "body":  {"type": "string"},
                    "source_refs": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "table": {"type": "string"},
                                "pk":    {"type": "string"},
                                "label": {"type": "string"},
                            },
                            "required": ["table", "pk", "label"],
                        },
                    },
                },
                "required": ["scope", "type", "title", "body", "source_refs"],
            },
        },
    },
    "required": ["items"],
}


class GeminiClient:
    def __init__(self, api_key: str, client: Any | None = None,
                 model: str = "gemini-2.5-flash"):
        if client is None:
            from google import genai                       # local import to keep tests fast
            client = genai.Client(api_key=api_key)
        self._client = client
        self._model = model

    def generate(
        self,
        *,
        system_prompt: str,
        context: dict[str, Any],
        response_schema: dict[str, Any],
    ) -> dict[str, Any]:
        from google.genai.types import GenerateContentConfig
        config = GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=response_schema,
            system_instruction=system_prompt,
            temperature=0.2,
        )
        resp = self._call_with_retry(
            contents=json.dumps(context, ensure_ascii=False),
            config=config,
        )
        return json.loads(resp.text)

    def _call_with_retry(self, *, contents: str, config: Any) -> Any:
        """Retry transient Gemini errors (5xx, RESOURCE_EXHAUSTED, UNAVAILABLE).

        Gemini Flash routinely returns 503 'high demand' bursts that resolve
        within seconds. Retry up to 5 times with exponential backoff.
        """
        import time
        delays = [2, 5, 10, 20, 40]
        last_exc: Exception | None = None
        for attempt, delay in enumerate(delays + [0], start=1):
            try:
                return self._client.models.generate_content(
                    model=self._model,
                    contents=contents,
                    config=config,
                )
            except Exception as e:                  # noqa: BLE001
                last_exc = e
                msg = str(e)
                transient = (
                    "503" in msg or "UNAVAILABLE" in msg
                    or "RESOURCE_EXHAUSTED" in msg or "429" in msg
                    or "500" in msg or "INTERNAL" in msg
                )
                if not transient or attempt > len(delays):
                    raise
                log.warning("gemini transient error (attempt %d/%d): %s; sleeping %ss",
                            attempt, len(delays) + 1, msg.split("\n")[0][:120], delay)
                time.sleep(delay)
        raise last_exc if last_exc else RuntimeError("gemini unknown failure")
