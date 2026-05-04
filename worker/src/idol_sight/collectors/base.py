"""Collector protocol and shared result types.

Each collector reads a GroupConfig and produces a CollectionResult containing
SQL statements ready for D1Client.batch(). Collectors do NOT touch D1 directly —
the orchestrator (orchestrator.py) is the only writer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from idol_sight.config import GroupConfig


@dataclass
class CollectionResult:
    rows_inserted: int
    rows_updated: int
    statements: list[tuple[str, list[Any]]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    runtime_ms: int = 0

    def merge(self, other: "CollectionResult") -> "CollectionResult":
        return CollectionResult(
            rows_inserted=self.rows_inserted + other.rows_inserted,
            rows_updated=self.rows_updated + other.rows_updated,
            statements=self.statements + other.statements,
            errors=self.errors + other.errors,
            runtime_ms=self.runtime_ms + other.runtime_ms,
        )


class Collector(Protocol):
    source: str        # 'naver' | 'dc' | 'theqoo' | 'instiz' | ...

    def collect(
        self,
        group: GroupConfig,
        since: str | None = None,
    ) -> CollectionResult:
        """Fetch and parse data for this (source, group), returning statements
        ready to write to D1. The `since` argument is the ISO 8601 timestamp of
        the previous successful run, used by collectors that support
        incremental fetching. Collectors that always fetch the same window may
        ignore `since`.
        """
        ...
