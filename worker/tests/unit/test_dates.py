from datetime import datetime, timedelta

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
    # No date and no Korean relative-time phrase → None.
    assert parse_safe("아무 의미없는 텍스트입니다") is None


def test_empty_returns_none():
    assert parse_safe("") is None
    assert parse_safe(None) is None


def test_invalid_calendar_returns_none():
    # Month 13 doesn't exist
    assert parse_safe("2026-13-01") is None


# ─── Korean relative-time fallback ──────────────────────────────────


NOW = datetime(2026, 5, 4, 12, 0, 0)


def test_relative_minutes_ago():
    assert parse_safe("30분 전", now=NOW) == NOW - timedelta(minutes=30)


def test_relative_hours_ago():
    assert parse_safe("3시간 전", now=NOW) == NOW - timedelta(hours=3)


def test_relative_days_ago():
    assert parse_safe("5일 전", now=NOW) == NOW - timedelta(days=5)


def test_relative_yesterday():
    assert parse_safe("어제", now=NOW) == NOW - timedelta(days=1)


def test_relative_today():
    assert parse_safe("오늘", now=NOW) == NOW


def test_relative_day_before_yesterday():
    assert parse_safe("그제", now=NOW) == NOW - timedelta(days=2)


def test_relative_just_now():
    assert parse_safe("방금", now=NOW) == NOW


def test_absolute_date_takes_precedence_over_relative():
    # If both an absolute date AND a relative phrase appear in the head,
    # prefer the absolute one.
    s = "2026-03-12 게시 (3시간 전 댓글)"
    assert parse_safe(s, now=NOW) == datetime(2026, 3, 12)


def test_kst_to_utc_subtracts_9_hours():
    from datetime import datetime
    from idol_sight.utils.dates import kst_to_utc
    # 14:04 KST → 05:04 UTC (same day)
    assert kst_to_utc(datetime(2026, 6, 8, 14, 4)) == datetime(2026, 6, 8, 5, 4)
    # 06:00 KST → 21:00 UTC previous day (crosses midnight)
    assert kst_to_utc(datetime(2026, 6, 8, 6, 0)) == datetime(2026, 6, 7, 21, 0)
    assert kst_to_utc(None) is None
