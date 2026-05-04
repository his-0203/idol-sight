"""Discord webhook notifier. Failures are logged but never re-raised."""

from __future__ import annotations

import logging

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_fixed

log = logging.getLogger(__name__)


@retry(
    retry=retry_if_exception_type(httpx.HTTPError),
    stop=stop_after_attempt(3),
    wait=wait_fixed(1),
    reraise=True,
)
def _post(webhook_url: str, body: dict) -> None:
    with httpx.Client(timeout=10.0) as c:
        r = c.post(webhook_url, json=body)
        r.raise_for_status()


def notify_failure(*, webhook_url: str, job: str, error: str) -> None:
    body = {
        "content": f":rotating_light: **{job}** failed\n```\n{error[:1500]}\n```",
    }
    try:
        _post(webhook_url, body)
    except Exception as e:
        log.warning("discord notify failed: %s", e)
