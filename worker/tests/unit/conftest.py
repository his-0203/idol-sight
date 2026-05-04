"""Shared fixtures for unit tests."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def _stub_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Provide harmless defaults for env vars consumed by `load_settings()`.

    Tests that need real values can override these via their own monkeypatch.
    Tests that monkeypatch `cli.load_settings` are unaffected.
    """
    for name, value in {
        "CF_ACCOUNT_ID": "test-account",
        "CF_D1_DB_ID": "test-db",
        "CF_API_TOKEN": "test-token",
        "DISCORD_WEBHOOK": "https://example.invalid/webhook",
    }.items():
        if not os.environ.get(name):
            monkeypatch.setenv(name, value)
