"""weverse_sheet 파서·수집기 테스트.

시트 실물 구조(2026-08-04 확인): 선행 빈 열 1개 + 빈 행 2개 위에
'날짜,총 가입자수,증가수,디지털 멤버십 가입수,증감수,한국,...' 헤더가 오고
날짜는 연도 없는 M/D, 천단위 쉼표가 섞인다.
"""

import pytest

from idol_sight.collectors.weverse_sheet import WeverseSheetCollector, parse_sheet_rows

SHEET_CSV = """,,,,,,,,,,
,,,,,,,,,,
,날짜,총 가입자수,증가수,디지털 멤버십 가입수,증감수,한국,인도네시아,USA,중국,일본
,6/16,713,713,14,14,102,112,48,35,18
,6/17,"1,210",735,23,9,117,234,100,74,24
,7/31,"6,895",120,69,2,900,1900,700,650,300
,8/1,"6,930",35,69,0,905,1910,702,652,301
,,,,,,,,,,
"""


def test_parse_basic_rows():
    rows = parse_sheet_rows(SHEET_CSV)
    assert rows[0] == {
        "day": "2026-06-16",
        "total_members": 713,
        "digital_membership": 14,
        "countries": {"한국": 102, "인도네시아": 112, "USA": 48, "중국": 35, "일본": 18},
    }
    # 천단위 쉼표 제거
    assert rows[1]["total_members"] == 1210
    # 빈 꼬리 행은 스킵
    assert len(rows) == 4


def test_parse_year_rollover():
    csv_text = (
        ",날짜,총 가입자수,증가수,디지털 멤버십 가입수,증감수,한국\n"
        ",12/31,100,1,5,0,50\n"
        ",1/1,101,1,5,0,51\n"
    )
    rows = parse_sheet_rows(csv_text)
    assert rows[0]["day"] == "2026-12-31"
    assert rows[1]["day"] == "2027-01-01"


def test_parse_no_header_returns_empty():
    assert parse_sheet_rows("a,b,c\n1,2,3\n") == []


def test_collect_builds_upsert_statements():
    class FakeResp:
        text = SHEET_CSV

        def raise_for_status(self):
            pass

    class FakeClient:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url):
            return FakeResp()

    coll = WeverseSheetCollector(sheet_id="SHEET123", http_factory=lambda: FakeClient())

    class G:  # GroupConfig 대역 — collect는 key만 사용
        key = "miiwan"

    res = coll.collect(G())
    assert res.rows_inserted == 4
    assert not res.errors
    sql, params = res.statements[0]
    assert "INSERT INTO weverse_stats" in sql
    assert "ON CONFLICT(group_key, day)" in sql
    assert params[0] == "miiwan"
    assert params[1] == "2026-06-16"
    assert params[2] == 713          # total_members
    assert params[3] == 14           # digital_membership
    assert "한국" in params[4]        # countries JSON
