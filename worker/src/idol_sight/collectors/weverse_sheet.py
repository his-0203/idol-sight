"""Weverse stats collector (Google Sheet CSV).

미완소년 위버스 가입자·디지털 멤버십은 공개 API가 없어 운영자가 구글
시트에 일별 기록한다. 이 수집기는 그 시트의 공개 CSV export를 읽어
weverse_stats 전량 upsert 문을 생성한다(멱등 — 시트에서 과거 값을
고치면 다음 수집 때 반영). 시트엔 연도가 없어 START_YEAR에서 시작해
월이 줄어드는 지점마다 +1로 롤오버한다.
"""

from __future__ import annotations

import csv
import io
import json
from collections.abc import Callable
from datetime import UTC, datetime
from time import perf_counter
from typing import Any

import httpx

from idol_sight.collectors.base import CollectionResult
from idol_sight.config import GroupConfig

EXPORT_URL = "https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=csv&gid=0"
START_YEAR = 2026  # 시트 첫 데이터 행(6/16 = 데뷔일)의 연도
_META_COLS = {"날짜", "총 가입자수", "증가수", "디지털 멤버십 가입수", "증감수"}


def _num(cell: str | None) -> int | None:
    s = (cell or "").strip().replace(",", "")
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def parse_sheet_rows(text: str) -> list[dict]:
    rows = list(csv.reader(io.StringIO(text)))
    header_idx = date_col = None
    for i, row in enumerate(rows):
        # 변수명 c: 아래 내부 함수 cell 과의 심볼 충돌(pyright) 회피.
        for j, c in enumerate(row):
            if c.strip() == "날짜":
                header_idx, date_col = i, j
                break
        if header_idx is not None:
            break
    if header_idx is None or date_col is None:
        return []

    col = {name.strip(): idx for idx, name in enumerate(rows[header_idx]) if name.strip()}
    country_cols = [(n, i) for n, i in col.items() if n not in _META_COLS]

    def cell(row: list[str], name: str) -> str | None:
        idx = col.get(name)
        return row[idx] if idx is not None and idx < len(row) else None

    out: list[dict] = []
    year, prev_month = START_YEAR, None
    for row in rows[header_idx + 1:]:
        raw = (row[date_col] if date_col < len(row) else "").strip()
        if "/" not in raw:
            continue
        try:
            m, d = (int(p) for p in raw.split("/", 1))
        except ValueError:
            continue
        if prev_month is not None and m < prev_month:
            year += 1
        prev_month = m
        total = _num(cell(row, "총 가입자수"))
        if total is None:  # 날짜만 미리 깔린 빈 행
            continue
        countries = {}
        for name, idx in country_cols:
            v = _num(row[idx] if idx < len(row) else None)
            if v is not None:
                countries[name] = v
        out.append({
            "day": f"{year:04d}-{m:02d}-{d:02d}",
            "total_members": total,
            "digital_membership": _num(cell(row, "디지털 멤버십 가입수")),
            "countries": countries,
        })
    return out


class WeverseSheetCollector:
    source = "weverse-sheet"

    def __init__(self, sheet_id: str, http_factory: Callable[[], Any] | None = None):
        self._sheet_id = sheet_id
        self._http_factory = http_factory or (
            lambda: httpx.Client(timeout=30.0, follow_redirects=True))

    def collect(self, group: GroupConfig, since: str | None = None) -> CollectionResult:
        started = perf_counter()
        with self._http_factory() as client:
            r = client.get(EXPORT_URL.format(sheet_id=self._sheet_id))
            r.raise_for_status()
            text = r.text

        now_iso = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        statements: list[tuple[str, list[Any]]] = []
        for p in parse_sheet_rows(text):
            statements.append((
                """
                INSERT INTO weverse_stats
                  (group_key, day, total_members, digital_membership, countries, collected_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(group_key, day) DO UPDATE SET
                  total_members=excluded.total_members,
                  digital_membership=excluded.digital_membership,
                  countries=excluded.countries,
                  collected_at=excluded.collected_at
                """.strip(),
                [group.key, p["day"], p["total_members"], p["digital_membership"],
                 json.dumps(p["countries"], ensure_ascii=False), now_iso],
            ))

        runtime_ms = int((perf_counter() - started) * 1000)
        return CollectionResult(
            rows_inserted=len(statements), rows_updated=0,
            statements=statements, runtime_ms=runtime_ms,
        )
