"""Guard against the recurring blacklist_phrases CSV-vs-JSON seed bug.

groups has several columns the worker json.loads at runtime (config.GroupConfig).
A plain-CSV seed (e.g. `'a,b,c'` instead of `'["a","b","c"]'`) parses fine in
SQL but throws JSONDecodeError when a collector loads the group — and it has
slipped in three times (migrations 0034→0064, 0069→0070, 0075→0078). This test
applies EVERY migration in order into in-memory SQLite (the real cumulative
state, not just 0001/0002) and asserts every JSON column on every group parses
as a JSON list, so the next bad seed fails CI instead of production.
"""

import json
import sqlite3
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"

# Columns on `groups` that GroupConfig json.loads — must be JSON arrays.
JSON_LIST_COLUMNS = (
    "context_keywords",
    "blacklist_phrases",
    "twitter_handles",
    "dc_supplemental_galleries",
    "theqoo_supplemental_boards",
    "instiz_supplemental_boards",
)


def _apply_all_migrations() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn


def _existing_json_columns(conn: sqlite3.Connection) -> list[str]:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(groups)")}
    return [c for c in JSON_LIST_COLUMNS if c in cols]


def test_all_migrations_apply_cleanly():
    conn = _apply_all_migrations()
    assert conn.execute("SELECT COUNT(*) FROM groups").fetchone()[0] > 0


def test_every_group_json_column_parses_as_list():
    conn = _apply_all_migrations()
    cols = _existing_json_columns(conn)
    select = "key, " + ", ".join(cols)
    bad: list[str] = []
    for row in conn.execute(f"SELECT {select} FROM groups"):
        key = row[0]
        for col, raw in zip(cols, row[1:], strict=True):
            if raw is None:
                continue  # NULL is allowed (column simply unset)
            try:
                v = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                bad.append(f"{key}.{col} not JSON: {raw!r}")
                continue
            if not isinstance(v, list):
                bad.append(f"{key}.{col} JSON but not a list: {raw!r}")
    assert not bad, "groups JSON columns must be JSON arrays:\n" + "\n".join(bad)
