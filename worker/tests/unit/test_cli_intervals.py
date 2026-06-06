"""Structural guard: collector registry ↔ expected-interval map coverage.

A collector missing from _INTERVALS_H silently falls back to 24h
(cli.py: `_INTERVALS_H.get(source, 24)`), which desyncs the health-check
freshness audit (threshold = interval * 4) from the real cron cadence and
produces false-positive (or suppressed) staleness alerts. Catch the omission
here instead of in production.
"""

from idol_sight.cli import _COLLECTORS, _INTERVALS_H


def test_every_collector_has_an_expected_interval():
    missing = set(_COLLECTORS) - set(_INTERVALS_H)
    assert not missing, f"collectors without an _INTERVALS_H entry: {missing}"


def test_no_orphan_interval_entries():
    orphan = set(_INTERVALS_H) - set(_COLLECTORS)
    assert not orphan, f"_INTERVALS_H entries with no collector: {orphan}"


def test_intervals_are_positive_hours():
    assert all(isinstance(h, int) and h > 0 for h in _INTERVALS_H.values())
