"""Persist Scrapling adaptive-selector state in D1's selectors_cache table."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol


class _Executor(Protocol):
    def execute(self, sql: str, params: list | None = ...) -> list[dict]: ...


_UPSERT = """
INSERT INTO selectors_cache(site, selector_key, serialized, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(site, selector_key) DO UPDATE SET
  serialized=excluded.serialized,
  updated_at=excluded.updated_at
""".strip()


_SELECT = """
SELECT serialized FROM selectors_cache WHERE site=? AND selector_key=?
""".strip()


class SelectorsStore:
    def __init__(self, client: _Executor):
        self._c = client

    def save(self, site: str, selector_key: str, serialized: str) -> None:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self._c.execute(_UPSERT, [site, selector_key, serialized, now])

    def load(self, site: str, selector_key: str) -> str | None:
        rows = self._c.execute(_SELECT, [site, selector_key])
        if not rows:
            return None
        return rows[0].get("serialized")
