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
                    # Gemini structured output enforces the enum — without it
                    # the model defaults to historically-used values
                    # (insight/weekly/ipx_action) and never emits 'diagnosis'.
                    # 첫 production run (2026-05-25 weekly cron) 에서 diagnosis
                    # 카드 0개 발생 → enum 명시로 strict 화.
                    "type": {
                        "type": "string",
                        "enum": ["insight", "ipx_action", "weekly", "diagnosis"],
                    },
                    "title": {"type": "string"},
                    "body":  {"type": "string"},
                    # Optional one-liner shown next to the card title in the
                    # WeeklyUpdate / Insights / MiiWANBriefing UI. Not in the
                    # `required` list on purpose: when Gemini occasionally
                    # drops the key on a retry, the INSERT path still
                    # succeeds and we just render the card without the
                    # comment instead of failing the whole batch.
                    "ai_comment": {"type": "string"},
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


# Default model chain: primary → fallback. When the primary returns
# persistent 5xx (regional capacity spike), we transparently retry on
# the fallback which lives in a different capacity pool. Both support
# system_instruction + structured JSON output.
DEFAULT_MODEL_CHAIN: tuple[str, ...] = ("gemini-2.5-flash", "gemini-2.0-flash")


class GeminiClient:
    def __init__(
        self,
        api_key: str,
        client: Any | None = None,
        model: str | None = None,
        models: tuple[str, ...] | None = None,
    ):
        if client is None:
            from google import genai  # local import to keep tests fast
            client = genai.Client(api_key=api_key)
        self._client = client
        # Back-compat: if a single `model` was passed, treat it as a
        # 1-element chain. New callers should pass `models=` to opt
        # into fallback.
        if models is not None:
            self._models: tuple[str, ...] = models
        elif model is not None:
            self._models = (model,)
        else:
            self._models = DEFAULT_MODEL_CHAIN
        # Primary model attribute kept for tests that still introspect
        # `_model` from the previous API.
        self._model = self._models[0]

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
        """Retry transient Gemini errors with backoff, then fall back to the
        next model in the chain.

        Each model gets its own retry budget (~640s wall). On persistent
        5xx (regional capacity spike) we move to the fallback. Worst-case
        wall time = sum of per-model budgets, still under the 30-min job
        timeout for a 2-model chain.
        """
        last_exc: Exception | None = None
        for idx, model_name in enumerate(self._models):
            try:
                return self._call_one_model(
                    model=model_name, contents=contents, config=config,
                )
            except Exception as e:                  # noqa: BLE001
                last_exc = e
                msg = str(e)
                transient = (
                    "503" in msg or "UNAVAILABLE" in msg
                    or "RESOURCE_EXHAUSTED" in msg or "429" in msg
                    or "500" in msg or "INTERNAL" in msg
                )
                more_models = idx + 1 < len(self._models)
                if not transient or not more_models:
                    raise
                next_model = self._models[idx + 1]
                log.warning(
                    "gemini model %s exhausted retries; falling back to %s",
                    model_name, next_model,
                )
        raise last_exc if last_exc else RuntimeError("gemini unknown failure")

    def _call_one_model(
        self, *, model: str, contents: str, config: Any,
    ) -> Any:
        """Call a single model with exponential backoff + jitter.

        Delays: [2, 5, 10, 20, 40, 60, 90, 120, 120] (10 attempts, ~640s).
        ±20% jitter so concurrent retries fan out.
        """
        import random
        import time
        delays = [2, 5, 10, 20, 40, 60, 90, 120, 120]
        for attempt, delay in enumerate(delays + [0], start=1):
            try:
                return self._client.models.generate_content(
                    model=model,
                    contents=contents,
                    config=config,
                )
            except Exception as e:                  # noqa: BLE001
                msg = str(e)
                transient = (
                    "503" in msg or "UNAVAILABLE" in msg
                    or "RESOURCE_EXHAUSTED" in msg or "429" in msg
                    or "500" in msg or "INTERNAL" in msg
                )
                if not transient or attempt > len(delays):
                    raise
                jittered = delay * (1.0 + random.uniform(-0.2, 0.2))
                log.warning(
                    "gemini[%s] transient error (attempt %d/%d): %s; sleeping %.1fs",
                    model, attempt, len(delays) + 1,
                    msg.split("\n")[0][:120], jittered,
                )
                time.sleep(jittered)
        raise RuntimeError("gemini unreachable retry exit")
