"""Discord webhook notifier. Failures are logged but never re-raised.

Retry policy:
- 5xx and connection errors are transient → retry up to 3 times with 1s wait
- 4xx is permanent (likely misconfigured URL) → do not retry
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_fixed,
)

KST = timezone(timedelta(hours=9))


def fmt_kst(dt_or_iso: datetime | str | None) -> str:
    """ISO-8601 / datetime → 'YYYY-MM-DD HH:MM KST'. None/parse-fail → 'never'."""
    if dt_or_iso is None or dt_or_iso == "never":
        return "never"
    if isinstance(dt_or_iso, str):
        try:
            dt = datetime.fromisoformat(dt_or_iso.replace("Z", "+00:00"))
        except ValueError:
            return str(dt_or_iso)
    else:
        dt = dt_or_iso
    return dt.astimezone(KST).strftime("%Y-%m-%d %H:%M KST")


log = logging.getLogger(__name__)


@retry(
    retry=retry_if_exception_type((httpx.ConnectError, httpx.HTTPStatusError)),
    stop=stop_after_attempt(3),
    wait=wait_fixed(1),
    reraise=True,
)
def _post(webhook_url: str, body: dict) -> None:
    with httpx.Client(timeout=10.0) as c:
        r = c.post(webhook_url, json=body)
        # Distinguish transient (5xx) vs permanent (4xx).
        if 500 <= r.status_code < 600:
            r.raise_for_status()                 # raises HTTPStatusError → retry
        if 400 <= r.status_code < 500:
            log.warning("discord 4xx (no retry): %s %s", r.status_code, r.text[:200])
            return                               # swallow; do not raise
        r.raise_for_status()                     # any other non-2xx → raise but won't retry


def notify_failure(*, webhook_url: str, job: str, error: str) -> None:
    body = {
        "content": f":rotating_light: **{job}** failed\n```\n{error[:1500]}\n```",
    }
    try:
        _post(webhook_url, body)
    except Exception as e:
        log.warning("discord notify failed: %s", e)


def notify_alert(
    *,
    webhook_url: str,
    title: str,
    body: str,
    severity: str = "info",
) -> None:
    """Push a structured alert to Discord. Distinct from notify_failure
    so the on-call channel can filter "BI-driven alert" vs "job died".
    Severity drives the icon: info / warn / critical.
    """
    icon = {"critical": ":fire:", "warn": ":warning:", "info": ":bell:"}.get(
        severity, ":bell:",
    )
    body_text = f"{icon} **{title}**\n{body[:1500]}"
    try:
        _post(webhook_url, {"content": body_text})
    except Exception as e:
        log.warning("discord alert failed: %s", e)
