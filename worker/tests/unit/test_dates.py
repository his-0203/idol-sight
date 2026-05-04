from datetime import datetime

from idol_sight.utils.dates import parse_safe


def test_iso_with_time():
    assert parse_safe("2026-05-04T08:15:00Z") == datetime(2026, 5, 4, 8, 15)


def test_korean_dot_format():
    assert parse_safe("2026.03.12.") == datetime(2026, 3, 12)


def test_korean_dot_with_time():
    # Time is ignored — only Y/M/D resolution kept.
    assert parse_safe("2026.03.12 14:30") == datetime(2026, 3, 12, 14, 30)


def test_slash_format():
    assert parse_safe("2026/5/04") == datetime(2026, 5, 4)


def test_iso_short():
    assert parse_safe("2026-03-12") == datetime(2026, 3, 12)


def test_text_bleed_caught_by_30char_window():
    # Real failure case from current site:
    # date field contained article body starting "2026.03.12 alice09@newspim.com 오위스는..."
    s = "2026.03.12 alice09@newspim.com 오위스는 첫 번째 미니 앨범을 발매한다."
    # The first 30 chars are "2026.03.12 alice09@newspim.com" — the parser should
    # match the leading date and ignore the rest.
    assert parse_safe(s) == datetime(2026, 3, 12)


def test_garbage_returns_none():
    assert parse_safe("이 글은 어제 작성됨") is None


def test_empty_returns_none():
    assert parse_safe("") is None
    assert parse_safe(None) is None


def test_invalid_calendar_returns_none():
    # Month 13 doesn't exist
    assert parse_safe("2026-13-01") is None
