# P2a — MiiWAN 찐팬 활동량 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MiiWAN 라이브 채팅(measured)과 영상 참여(estimated)를 재가공해 찐팬 활동량 지표를 산출·저장·노출한다 — 신규 수집 0.

**Architecture:** loyalty(0084)의 raw→summary 분리 + basis 3단계 + full DELETE rebuild 패턴을 미러. worker(migration 0096 + analysis/live_activity.py + cli)에서 산출, frontend(miiwan.ts API + FanActivityCard + MiiWANBriefing)에서 노출. MiiWAN 단독.

**Tech Stack:** Python 3.12 + pytest(uv) + Cloudflare D1(SQLite), TypeScript + Preact + vitest.

## Global Constraints

- **신규 수집 0**: 전부 기존 `live_chat_messages`·`youtube_video_stats`·`agg_summary` 재가공. 새 수집기·API 호출 금지.
- **MiiWAN 단독**: build_live_activity는 group 파라미터(기본 `miiwan`)로 호출. 타 그룹 확대는 비목표.
- **measured vs estimated 구분**: (A) 라이브 채팅 = 측정값, (B) 영상 좋아요/댓글 = **추정치**(공개 외형 신호, 인간 판단 대체 아님). 카드에서 '추정' 배지로 구분.
- **인터페이스 고정**: `build_live_activity(client, *, group_key, window_days=56) -> CollectionResult`; `median`은 `idol_sight.analysis.loyalty.median` 재사용.
- **basis 3단계**: 방송 0=`insufficient`(summary만), 1=`low_confidence`(returning/core 미산정), ≥2=`scored`.
- **스키마(0096)**: `agg_live_activity`(방송별, PK group_key+video_id) + `agg_live_activity_summary`(그룹별, PK group_key). 정수 median 컬럼은 round() 정수화.
- **추정 정의(설계 grounding)**: est_engaged_fans=median(likes)(좋아요=영상당 1인1회→고유 반응팬 근사), est_active_core=median(comments)(적극참여 상한), view_through=median(views)/구독자.
- **테스트 실행**: worker `cd worker && uv run python -m pytest …`; frontend `cd frontend && npx vitest run …` / `npx tsc -b --noEmit`.
- **커밋 trailer**: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**구현 순서(의존성)**: 마이그레이션 0096 → live_activity.py 모듈 → (기존회귀 검증) → cli 커맨드 → 워크플로 → miiwan.ts API → FanActivityCard → MiiWANBriefing 삽입.

> 설계서: `docs/superpowers/specs/2026-06-27-p2a-miiwan-fan-activity-design.md`

---

### Task 1: 마이그레이션 0096_live_activity.sql — agg_live_activity(방송별) + agg_live_activity_summary(그룹별)

**Files:** /Users/user/Desktop/idol-sight/migrations/0096_live_activity.sql (신규)
**Test:** `/Users/user/Desktop/idol-sight/worker/tests/unit/test_live_activity.py (test_migration_creates_live_activity_tables, test_migration_agg_live_activity_pk_composite)`

**Interfaces:** 생산: 테이블 agg_live_activity(컬럼: group_key,video_id,ended_at,unique_chatters,total_messages,msgs_per_chatter REAL,peak_msgs_per_min,returning_rate REAL,basis,generated_at; PK(group_key,video_id)) + agg_live_activity_summary(group_key PK,generated_at,window_days,broadcast_count,median_unique_chatters,median_msgs_per_chatter REAL,median_returning_rate REAL,median_peak_msgs_per_min,core_fan_count,core_fan_share REAL,est_engaged_fans,est_active_core,view_through REAL,like_rate REAL,comment_rate REAL,basis). 소비처: live_activity.py의 INSERT, frontend miiwan.ts 조회.

**Notes:** 설계 §4 컬럼 그대로. est_engaged_fans/est_active_core/median_unique_chatters/median_peak_msgs_per_min는 INTEGER(소수 median은 모듈에서 round 정수화). groups(key) REFERENCES는 0001에서 생성됨. _apply_all이 0096 포함 전 체인을 :memory:에 적용 — test_schema.py도 동일 경로라 깨지면 즉시 드러남(현재 green).

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/worker/tests/unit/test_live_activity.py (test_migration_creates_live_activity_tables, test_migration_agg_live_activity_pk_composite)`)

```
# (test_live_activity.py 하단, 전 마이그레이션 :memory: 적용 — test_live_chat_migration.py 미러)
import sqlite3
from pathlib import Path
import pytest

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"

def _apply_all():
    conn = sqlite3.connect(":memory:")
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        conn.executescript(f.read_text())
    return conn

def test_migration_creates_live_activity_tables():
    conn = _apply_all()
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"agg_live_activity", "agg_live_activity_summary"} <= tables
    ala_cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_live_activity)")}
    assert {"group_key","video_id","ended_at","unique_chatters","total_messages","msgs_per_chatter","peak_msgs_per_min","returning_rate","basis","generated_at"} <= ala_cols
    sum_cols = {r[1] for r in conn.execute("PRAGMA table_info(agg_live_activity_summary)")}
    assert {"group_key","generated_at","window_days","broadcast_count","median_unique_chatters","median_msgs_per_chatter","median_returning_rate","median_peak_msgs_per_min","core_fan_count","core_fan_share","est_engaged_fans","est_active_core","view_through","like_rate","comment_rate","basis"} <= sum_cols

def test_migration_agg_live_activity_pk_composite():
    conn = _apply_all()
    ins = ("INSERT INTO agg_live_activity (group_key, video_id, basis, generated_at) "
           "VALUES ('miiwan','v1','scored','2026-06-27T00:00:00Z')")
    conn.execute(ins)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(ins)
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && uv run python -m pytest tests/unit/test_live_activity.py -q -k migration
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
-- 0096_live_activity.sql — P2a: MiiWAN 찐팬 활동량 지표.
--
-- 동기:
--   live_chat_messages(방송별 raw 채팅, author 완전 채워짐) + youtube_video_stats
--   를 재가공해 (A) 라이브 채팅 measured 지표 + (B) 영상 참여 estimated 지표를
--   산출·저장한다. 신규 수집 0 — 전부 기존 데이터 재가공. MiiWAN 단독(자사 심층).
--
-- loyalty(0084)의 raw→summary 분리 패턴 미러:
--   agg_live_activity         — 방송별 1행(추이), (group_key, video_id) PK.
--   agg_live_activity_summary — 그룹별 1행(카드 헤드라인 + 추정), group_key PK.
--   build_live_activity 가 group_key 범위 full DELETE+rebuild (멱등).

CREATE TABLE IF NOT EXISTS agg_live_activity (
  group_key         TEXT NOT NULL REFERENCES groups(key),
  video_id          TEXT NOT NULL,
  ended_at          TEXT,             -- 방송 종료 시각 ISO8601 (live_chat_reports)
  unique_chatters   INTEGER,          -- COUNT(DISTINCT author), author 비어있지 않은 것
  total_messages    INTEGER,          -- 방송 메시지 총량 (live_chat_messages COUNT)
  msgs_per_chatter  REAL,             -- total_messages / unique_chatters (1자리)
  peak_msgs_per_min INTEGER,          -- offset_ms//60000 분버킷 최대 COUNT (NULL offset 제외)
  returning_rate    REAL,             -- |chatters ∩ 직전방송| / chatters, 첫 방송 NULL
  basis             TEXT NOT NULL,    -- 'scored'|'low_confidence'|'insufficient'
  generated_at      TEXT NOT NULL,
  PRIMARY KEY (group_key, video_id)
);
CREATE INDEX IF NOT EXISTS idx_ala_group ON agg_live_activity (group_key);

CREATE TABLE IF NOT EXISTS agg_live_activity_summary (
  group_key                 TEXT NOT NULL PRIMARY KEY REFERENCES groups(key),
  generated_at              TEXT NOT NULL,
  window_days               INTEGER NOT NULL DEFAULT 56,
  broadcast_count           INTEGER NOT NULL DEFAULT 0,
  -- (A) 윈도우 헤드라인 — 방송별 값의 중앙값.
  median_unique_chatters    INTEGER,
  median_msgs_per_chatter   REAL,
  median_returning_rate     REAL,
  median_peak_msgs_per_min  INTEGER,
  -- (A-rollup) 윈도우 코어팬 — 2개 이상 방송 등장 author.
  core_fan_count            INTEGER,
  core_fan_share            REAL,     -- core_fan_count / 윈도우 고유 챗터
  -- (B) 영상 참여 estimated — 최신 스냅샷 median 기반(추정치, 인간 판단 대체 아님).
  est_engaged_fans          INTEGER,  -- median(likes per video) — 고유 반응 팬 근사
  est_active_core           INTEGER,  -- median(comments per video) — 적극 참여 상한
  view_through              REAL,     -- median(views) / yt_subscribers
  like_rate                 REAL,     -- median(likes/views)
  comment_rate              REAL,     -- median(comments/views)
  basis                     TEXT NOT NULL  -- 'scored'|'low_confidence'|'insufficient'
);
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && uv run python -m pytest tests/unit/test_live_activity.py -q -k migration
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2a): 마이그레이션 0096_live_activity.sql — agg_live_activity(방송별) + agg_live_activity_summary(그룹별)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: analysis/live_activity.py — build_live_activity + 순수 컴퓨트(방송별 A지표·코어팬·B영상추정·basis 3단계·full DELETE rebuild)

**Files:** /Users/user/Desktop/idol-sight/worker/src/idol_sight/analysis/live_activity.py (신규)
**Test:** `/Users/user/Desktop/idol-sight/worker/tests/unit/test_live_activity.py`

**Interfaces:** 생산 함수 시그니처: build_live_activity(client, *, group_key: str, window_days: int = 56) -> CollectionResult(statements=[(sql, params)...]); compute_live_activity(broadcasts, videos, subscribers, *, window_days=56) -> (per_broadcast: list[dict], summary: dict); compute_broadcast_activity(messages, *, prev_chatters) -> dict(+chatters set); window_core_fans(list[set]) -> (count, share); estimate_video_engagement(videos, subscribers) -> dict. 소비: cli.py 가 build_live_activity(client, group_key='miiwan') 호출해 statements를 D1 batch. 의존: idol_sight.analysis.loyalty.median 재사용, collectors.base.CollectionResult. D1 입력 컬럼 — live_chat_reports(video_id,ended_at), live_chat_messages(video_id,author,offset_ms), youtube_videos+youtube_video_stats latest(views,likes,comments), agg_summary(yt_subscribers).

**Notes:** 엣지케이스 처리됨: offset_ms NULL→peak 버킷만 제외(고유/총량 포함), author NULL/''→고유 제외, unique 0→msgs_per_chatter None·row basis insufficient, 첫 방송 returning None→row low_confidence, subscribers≤0/None→view_through None, views=0 영상→like/comment_rate 비율에서만 제외. total_messages는 live_chat_messages COUNT(len)으로 산정(설계 grounding '저장=수집'이라 reports.total_messages와 동일, 분모 일관성). DELETE는 group_key 범위(per-group rebuild, MiiWAN 단독 호출이라 full과 동치). 영상 is_short 필터 없음(설계 §3 '발행 영상' 전체). median 정수컬럼은 round() 정수화. cli.py 배선(build-live-activity --group miiwan 커맨드 + 워크플로 1줄)은 본 task 범위 밖(설계 §5) — 별도 task.

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/worker/tests/unit/test_live_activity.py`)

```
# test_live_activity.py — 순수함수 + _FakeClient 섹션 (test_loyalty.py 미러)
import pytest
from idol_sight.analysis.live_activity import (
    build_live_activity, compute_broadcast_activity, compute_live_activity,
    estimate_video_engagement, window_core_fans,
)

def test_compute_broadcast_activity_basic_and_peak_excludes_null_offset():
    messages = [{"author":"a","offset_ms":1000},{"author":"b","offset_ms":2000},
        {"author":"a","offset_ms":3000},{"author":"c","offset_ms":65000},{"author":"d","offset_ms":None}]
    out = compute_broadcast_activity(messages, prev_chatters=None)
    assert out["total_messages"] == 5
    assert out["unique_chatters"] == 4
    assert out["msgs_per_chatter"] == pytest.approx(1.2)
    assert out["peak_msgs_per_min"] == 3
    assert out["returning_rate"] is None
    assert out["chatters"] == {"a","b","c","d"}

def test_compute_broadcast_activity_returning_rate_intersection():
    messages = [{"author":x,"offset_ms":1000} for x in ("a","b","c","d")]
    out = compute_broadcast_activity(messages, prev_chatters={"a","b","x"})
    assert out["returning_rate"] == pytest.approx(0.5)

def test_compute_broadcast_activity_no_chatters():
    out = compute_broadcast_activity([{"author":None,"offset_ms":1000},{"author":"","offset_ms":2000}], prev_chatters={"a"})
    assert out["unique_chatters"] == 0 and out["msgs_per_chatter"] is None
    assert out["returning_rate"] is None and out["peak_msgs_per_min"] == 2

def test_window_core_fans_two_or_more_broadcasts():
    count, share = window_core_fans([{"a","b","c"},{"a","b","d"},{"a","e"}])
    assert count == 2 and share == pytest.approx(0.4)

def test_estimate_video_engagement_medians_and_rates():
    videos = [{"views":1000,"likes":100,"comments":10},{"views":2000,"likes":200,"comments":20},{"views":3000,"likes":300,"comments":30}]
    out = estimate_video_engagement(videos, subscribers=100_000)
    assert out["est_engaged_fans"]==200 and out["est_active_core"]==20
    assert out["view_through"]==pytest.approx(0.02) and out["like_rate"]==pytest.approx(0.1) and out["comment_rate"]==pytest.approx(0.01)

def test_estimate_subscribers_nonpositive_and_zero_view():
    assert estimate_video_engagement([{"views":1000,"likes":100,"comments":10}], 0)["view_through"] is None
    out = estimate_video_engagement([{"views":1000,"likes":100,"comments":10},{"views":0,"likes":0,"comments":0},{"views":1000,"likes":100,"comments":10}], 100_000)
    assert out["like_rate"]==pytest.approx(0.1)

def _bc(vid, ended, ao):
    return {"video_id":vid,"ended_at":ended,"messages":[{"author":a,"offset_ms":o} for a,o in ao]}

def test_compute_live_activity_scored_two_broadcasts():
    bc = [_bc("v1","2026-06-16T12:00:00Z",[("a",1000),("b",2000),("c",3000)]),
          _bc("v2","2026-06-17T12:00:00Z",[("a",1000),("b",2000),("d",3000)])]
    videos = [{"views":1000,"likes":100,"comments":10},{"views":2000,"likes":200,"comments":20},{"views":3000,"likes":300,"comments":30}]
    per_b, s = compute_live_activity(bc, videos, 100_000)
    assert [r["basis"] for r in per_b] == ["low_confidence","scored"]
    assert per_b[1]["returning_rate"] == pytest.approx(0.6667, abs=1e-4)
    assert s["basis"]=="scored" and s["median_unique_chatters"]==3 and s["median_peak_msgs_per_min"]==3
    assert s["core_fan_count"]==2 and s["core_fan_share"]==pytest.approx(0.5) and s["est_engaged_fans"]==200

def test_compute_live_activity_low_confidence_single():
    per_b, s = compute_live_activity([_bc("v1","2026-06-16T12:00:00Z",[("a",1000),("b",2000)])], [], 100_000)
    assert s["basis"]=="low_confidence" and s["median_returning_rate"] is None and s["core_fan_count"] is None

def test_compute_live_activity_insufficient_no_broadcast():
    per_b, s = compute_live_activity([], [{"views":1000,"likes":100,"comments":10}], 100_000)
    assert per_b==[] and s["basis"]=="insufficient" and s["broadcast_count"]==0 and s["est_engaged_fans"]==100

class _FakeClient:
    def __init__(self, reports, messages, videos, subs):
        self._r, self._m, self._v, self._s = reports, messages, videos, subs
    def execute(self, sql, params=None):
        if "live_chat_reports" in sql: return self._r
        if "live_chat_messages" in sql: return self._m
        if "youtube_videos" in sql: return self._v
        if "agg_summary" in sql: return self._s
        return []

def _miiwan_client():
    return _FakeClient(
        reports=[{"video_id":"v1","ended_at":"2026-06-16T12:00:00Z"},{"video_id":"v2","ended_at":"2026-06-17T12:00:00Z"}],
        messages=[{"video_id":"v1","author":a,"offset_ms":o} for a,o in [("a",1000),("b",2000),("c",3000)]]
                +[{"video_id":"v2","author":a,"offset_ms":o} for a,o in [("a",1000),("b",2000),("d",3000)]],
        videos=[{"video_id":"y1","views":1000,"likes":100,"comments":10},{"video_id":"y2","views":2000,"likes":200,"comments":20},{"video_id":"y3","views":3000,"likes":300,"comments":30}],
        subs=[{"yt_subscribers":100_000,"snapshot_at":"2026-06-20T00:00:00Z"}])

def test_build_live_activity_statements_shape():
    stmts = build_live_activity(_miiwan_client(), group_key="miiwan").statements
    assert len(stmts)==5
    assert stmts[0][0].startswith("DELETE FROM agg_live_activity ") and stmts[0][1]==["miiwan"]
    sql, params = stmts[-1]
    assert "agg_live_activity_summary" in sql and params[3]==2 and params[8]==2 and params[10]==200 and params[-1]=="scored"

def test_build_live_activity_idempotent_row_count():
    r1 = build_live_activity(_miiwan_client(), group_key="miiwan")
    r2 = build_live_activity(_miiwan_client(), group_key="miiwan")
    assert len(r1.statements)==len(r2.statements)
    s1 = next(p for s,p in r1.statements if "agg_live_activity_summary" in s)
    s2 = next(p for s,p in r2.statements if "agg_live_activity_summary" in s)
    assert s1[2:]==s2[2:]

def test_build_live_activity_empty_group_insufficient():
    res = build_live_activity(_FakeClient([],[],[],[]), group_key="plave")
    assert len(res.statements)==3 and res.statements[-1][1][-1]=="insufficient"
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && uv run python -m pytest tests/unit/test_live_activity.py -q  (검증됨: 19 passed)
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
"""MiiWAN 찐팬 활동량 (P2a) — 라이브 채팅 measured + 영상 참여 estimated.

(A) live_chat_messages 재가공: 방송별 고유 챗터·챗터당 메시지·분당 피크·재방문
    비율 + 윈도우 코어팬(≥2방송 등장). measured.
(B) youtube_video_stats 최신 스냅샷 재가공: median likes/comments/views 기반
    추정 관여 팬·적극 코어·시청 전환·참여율. estimated (공개 외형 신호 — 추정치이며
    인간 판단 대체 아님).

신규 수집 0 — 전부 기존 데이터 재가공. loyalty.py 의 build/compute 분리 +
basis 3단계(insufficient/low_confidence/scored) + full DELETE rebuild 패턴을
미러한다. measured 라이브 코어와 estimated 영상은 서로 다른 참여 표면(축).
Heuristic, not ground-truth.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from idol_sight.analysis.loyalty import median
from idol_sight.collectors.base import CollectionResult

__all__ = [
    "WINDOW_DAYS", "MIN_WINDOW_VIDEOS", "VIDEO_FALLBACK_LIMIT", "MS_PER_MINUTE",
    "compute_broadcast_activity", "window_core_fans", "estimate_video_engagement",
    "compute_live_activity", "build_live_activity",
]

WINDOW_DAYS = 56
MIN_WINDOW_VIDEOS = 3       # 윈도우 내 영상 < 3 → 최신 12건 폴백 (소표본 가드)
VIDEO_FALLBACK_LIMIT = 12
MS_PER_MINUTE = 60_000


def compute_broadcast_activity(messages, *, prev_chatters):
    total_messages = len(messages)
    chatters = {m["author"] for m in messages if m.get("author") not in (None, "")}
    unique = len(chatters)
    msgs_per_chatter = round(total_messages / unique, 1) if unique else None
    buckets = {}
    for m in messages:
        off = m.get("offset_ms")
        if off is None:
            continue
        b = int(off) // MS_PER_MINUTE
        buckets[b] = buckets.get(b, 0) + 1
    peak = max(buckets.values()) if buckets else None
    if prev_chatters is None or unique == 0:
        returning = None
    else:
        returning = round(len(chatters & prev_chatters) / unique, 4)
    return {"total_messages": total_messages, "unique_chatters": unique,
            "msgs_per_chatter": msgs_per_chatter, "peak_msgs_per_min": peak,
            "returning_rate": returning, "chatters": chatters}


def window_core_fans(chatters_per_broadcast):
    appearances = {}
    for chatters in chatters_per_broadcast:
        for a in chatters:
            appearances[a] = appearances.get(a, 0) + 1
    core = sum(1 for n in appearances.values() if n >= 2)
    total_unique = len(appearances)
    share = round(core / total_unique, 4) if total_unique else None
    return core, share


def estimate_video_engagement(videos, subscribers):
    base = {"est_engaged_fans": None, "est_active_core": None, "view_through": None,
            "like_rate": None, "comment_rate": None, "video_count": len(videos)}
    if not videos:
        return base
    likes = [float(v.get("likes") or 0) for v in videos]
    comments = [float(v.get("comments") or 0) for v in videos]
    views = [float(v.get("views") or 0) for v in videos]
    base["est_engaged_fans"] = round(median(likes))
    base["est_active_core"] = round(median(comments))
    med_views = median(views)
    if subscribers and subscribers > 0:
        base["view_through"] = round(med_views / subscribers, 4)
    like_ratios = [float(v.get("likes") or 0) / float(v["views"]) for v in videos if v.get("views")]
    comment_ratios = [float(v.get("comments") or 0) / float(v["views"]) for v in videos if v.get("views")]
    if like_ratios:
        base["like_rate"] = round(median(like_ratios), 4)
    if comment_ratios:
        base["comment_rate"] = round(median(comment_ratios), 4)
    return base


def compute_live_activity(broadcasts, videos, subscribers, *, window_days=WINDOW_DAYS):
    per_broadcast = []
    chatters_seq = []
    prev = None
    for b in broadcasts:
        act = compute_broadcast_activity(b.get("messages") or [], prev_chatters=prev)
        if act["unique_chatters"] == 0:
            row_basis = "insufficient"
        elif act["returning_rate"] is None:
            row_basis = "low_confidence"
        else:
            row_basis = "scored"
        per_broadcast.append({"video_id": b["video_id"], "ended_at": b.get("ended_at"),
            "unique_chatters": act["unique_chatters"], "total_messages": act["total_messages"],
            "msgs_per_chatter": act["msgs_per_chatter"], "peak_msgs_per_min": act["peak_msgs_per_min"],
            "returning_rate": act["returning_rate"], "basis": row_basis})
        chatters_seq.append(act["chatters"])
        prev = act["chatters"]
    bc = len(broadcasts)
    est = estimate_video_engagement(videos, subscribers)
    if bc == 0:
        summary = {"window_days": window_days, "broadcast_count": 0,
            "median_unique_chatters": None, "median_msgs_per_chatter": None,
            "median_returning_rate": None, "median_peak_msgs_per_min": None,
            "core_fan_count": None, "core_fan_share": None,
            "est_engaged_fans": est["est_engaged_fans"], "est_active_core": est["est_active_core"],
            "view_through": est["view_through"], "like_rate": est["like_rate"],
            "comment_rate": est["comment_rate"], "basis": "insufficient"}
        return per_broadcast, summary
    uniques = [float(r["unique_chatters"]) for r in per_broadcast]
    mpc = [r["msgs_per_chatter"] for r in per_broadcast if r["msgs_per_chatter"] is not None]
    rets = [r["returning_rate"] for r in per_broadcast if r["returning_rate"] is not None]
    peaks = [float(r["peak_msgs_per_min"]) for r in per_broadcast if r["peak_msgs_per_min"] is not None]
    if bc >= 2:
        core_count, core_share = window_core_fans(chatters_seq)
    else:
        core_count, core_share = None, None
    summary = {"window_days": window_days, "broadcast_count": bc,
        "median_unique_chatters": round(median(uniques)) if uniques else None,
        "median_msgs_per_chatter": round(median(mpc), 1) if mpc else None,
        "median_returning_rate": round(median(rets), 4) if rets else None,
        "median_peak_msgs_per_min": round(median(peaks)) if peaks else None,
        "core_fan_count": core_count, "core_fan_share": core_share,
        "est_engaged_fans": est["est_engaged_fans"], "est_active_core": est["est_active_core"],
        "view_through": est["view_through"], "like_rate": est["like_rate"],
        "comment_rate": est["comment_rate"],
        "basis": "low_confidence" if bc == 1 else "scored"}
    return per_broadcast, summary


class _Executor(Protocol):
    def execute(self, sql, params=...): ...


_CLEAR_BROADCAST_SQL = "DELETE FROM agg_live_activity WHERE group_key = ?"
_CLEAR_SUMMARY_SQL = "DELETE FROM agg_live_activity_summary WHERE group_key = ?"
_REPORTS_SQL = ("SELECT video_id, ended_at FROM live_chat_reports "
    "WHERE group_key = ? AND ended_at IS NOT NULL AND ended_at >= ? ORDER BY ended_at ASC")
_MESSAGES_SQL = "SELECT video_id, author, offset_ms FROM live_chat_messages WHERE group_key = ?"
_VIDEOS_WINDOW_SQL = ("SELECT v.video_id, v.published_at, s.views, s.likes, s.comments "
    "FROM youtube_videos v LEFT JOIN youtube_video_stats s "
    "  ON s.video_id = v.video_id AND s.snapshot_at = ("
    "    SELECT MAX(snapshot_at) FROM youtube_video_stats WHERE video_id = v.video_id) "
    "WHERE v.group_key = ? AND v.published_at IS NOT NULL AND v.published_at >= ? "
    "ORDER BY v.published_at DESC")
_VIDEOS_FALLBACK_SQL = ("SELECT v.video_id, v.published_at, s.views, s.likes, s.comments "
    "FROM youtube_videos v LEFT JOIN youtube_video_stats s "
    "  ON s.video_id = v.video_id AND s.snapshot_at = ("
    "    SELECT MAX(snapshot_at) FROM youtube_video_stats WHERE video_id = v.video_id) "
    "WHERE v.group_key = ? AND v.published_at IS NOT NULL ORDER BY v.published_at DESC LIMIT ?")
_SUBS_SQL = ("SELECT yt_subscribers, snapshot_at FROM agg_summary "
    "WHERE group_key = ? AND yt_subscribers IS NOT NULL ORDER BY snapshot_at DESC LIMIT 1")
_INSERT_BROADCAST_SQL = ("INSERT INTO agg_live_activity\n"
    "  (group_key, video_id, ended_at, unique_chatters, total_messages,\n"
    "   msgs_per_chatter, peak_msgs_per_min, returning_rate, basis, generated_at)\n"
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
_INSERT_SUMMARY_SQL = ("INSERT INTO agg_live_activity_summary\n"
    "  (group_key, generated_at, window_days, broadcast_count,\n"
    "   median_unique_chatters, median_msgs_per_chatter, median_returning_rate,\n"
    "   median_peak_msgs_per_min, core_fan_count, core_fan_share,\n"
    "   est_engaged_fans, est_active_core, view_through, like_rate, comment_rate,\n"
    "   basis)\n"
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")


def build_live_activity(client, *, group_key, window_days=WINDOW_DAYS):
    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff = (datetime.now(UTC) - timedelta(days=window_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    reports = client.execute(_REPORTS_SQL, [group_key, cutoff])
    msgs_by_video = {}
    for m in client.execute(_MESSAGES_SQL, [group_key]):
        msgs_by_video.setdefault(m["video_id"], []).append(m)
    broadcasts = [{"video_id": r["video_id"], "ended_at": r.get("ended_at"),
        "messages": msgs_by_video.get(r["video_id"], [])} for r in reports]
    videos = client.execute(_VIDEOS_WINDOW_SQL, [group_key, cutoff])
    if len(videos) < MIN_WINDOW_VIDEOS:
        videos = client.execute(_VIDEOS_FALLBACK_SQL, [group_key, VIDEO_FALLBACK_LIMIT])
    subs_rows = client.execute(_SUBS_SQL, [group_key])
    subscribers = subs_rows[0]["yt_subscribers"] if subs_rows else None
    per_broadcast, summary = compute_live_activity(broadcasts, videos, subscribers, window_days=window_days)
    statements = [(_CLEAR_BROADCAST_SQL, [group_key]), (_CLEAR_SUMMARY_SQL, [group_key])]
    for r in per_broadcast:
        statements.append((_INSERT_BROADCAST_SQL, [group_key, r["video_id"], r["ended_at"],
            r["unique_chatters"], r["total_messages"], r["msgs_per_chatter"],
            r["peak_msgs_per_min"], r["returning_rate"], r["basis"], now]))
    statements.append((_INSERT_SUMMARY_SQL, [group_key, now, summary["window_days"], summary["broadcast_count"],
        summary["median_unique_chatters"], summary["median_msgs_per_chatter"], summary["median_returning_rate"],
        summary["median_peak_msgs_per_min"], summary["core_fan_count"], summary["core_fan_share"],
        summary["est_engaged_fans"], summary["est_active_core"], summary["view_through"],
        summary["like_rate"], summary["comment_rate"], summary["basis"]]))
    return CollectionResult(rows_inserted=0, rows_updated=len(statements), statements=statements)

# NOTE: 실제 파일은 loyalty.py 컨벤션대로 타입힌트·docstring 풀버전. 위 코드는 검증 통과본의 본문이며,
# 디스크의 /Users/user/Desktop/idol-sight/worker/src/idol_sight/analysis/live_activity.py 에 docstring 포함 풀버전이 이미 작성됨(ruff clean).
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && uv run python -m pytest tests/unit/test_live_activity.py -q  (검증됨: 19 passed)
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2a): analysis/live_activity.py — build_live_activity + 순수 컴퓨트(방송별 A지표·코어팬·B영상추정·basis 3단계·full DELETE rebuild)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: (통합 검증) 기존 테스트 회귀 + ruff

**Files:** 검증만 — 신규 파일 없음
**Test:** `/Users/user/Desktop/idol-sight/worker/tests/unit/test_loyalty.py, test_live_chat_migration.py, test_schema.py`

**Interfaces:** 없음 (검증 task).

**Notes:** 실측 결과: test_loyalty/test_live_chat_migration/test_schema 27 passed, ruff 'All checks passed'. 0096이 전 마이그레이션 체인(_apply_all)에 안전 편입됨을 test_schema가 보증. median을 loyalty에서 import하므로 loyalty 시그니처 변경 시 동반 영향 — 현재 무변경.

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/worker/tests/unit/test_loyalty.py, test_live_chat_migration.py, test_schema.py`)

```
# 신규 테스트 없음 — 기존 스위트 재실행으로 회귀 0 확인 (실측: 27 passed).
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && uv run python -m pytest tests/unit/test_loyalty.py tests/unit/test_live_chat_migration.py tests/unit/test_schema.py -q && uv run ruff check src/idol_sight/analysis/live_activity.py tests/unit/test_live_activity.py
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
# 회귀 검증용 명령 (코드 변경 없음). loyalty.median 재사용·0096 마이그레이션 체인이
# 기존 스모크/스키마 테스트와 충돌하지 않음을 확인한다.
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && uv run python -m pytest tests/unit/test_loyalty.py tests/unit/test_live_chat_migration.py tests/unit/test_schema.py -q && uv run ruff check src/idol_sight/analysis/live_activity.py tests/unit/test_live_activity.py
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2a): (통합 검증) 기존 테스트 회귀 + ruff" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: cli.py에 build-live-activity 커맨드 추가 (analysis.live_activity.build_live_activity wiring)

**Files:** /Users/user/Desktop/idol-sight/worker/src/idol_sight/cli.py (수정: rebuild_live_chat_reports 커맨드 끝 line 1058 직후, backfill-music-show-wins @app.command 시작 line 1061 앞에 신규 커맨드 삽입)
**Test:** `/Users/user/Desktop/idol-sight/worker/tests/unit/test_cli_live_activity.py`

**Interfaces:** [소비] worker 에이전트가 생산할 시그니처와 정확히 일치해야 함: `build_live_activity(client, *, group_key='miiwan', window_days=56) -> CollectionResult` (analysis/live_activity.py). 반환은 loyalty 미러 = `CollectionResult` with `.statements: list[tuple[str, list[Any]]]` (statements[0]은 full DELETE, 이후 per-broadcast/summary INSERT). 커맨드는 `result.statements` 만 사용(client.batch 적재). [생산] CLI 커맨드 `build-live-activity --group <key> --window-days <int>` (typer 함수명 build_live_activity_cmd). 호출 형태: `build_live_activity(client, group_key=group, window_days=window_days)` — 키워드 인자명 group_key/window_days 고정(worker와 합의된 시그니처).

**Notes:** 1) 테스트의 happy-path/error 케이스는 `idol_sight.analysis.live_activity.build_live_activity`를 monkeypatch하므로 worker 에이전트의 analysis/live_activity.py 모듈이 존재해야 import 가능(크로스-에이전트 의존). help 테스트는 모듈 없이도 통과(본문 미실행). 따라서 통합 시점엔 worker 모듈 머지 후 전체 그린. 2) 에러 처리는 youtube_analytics_cmd 미러로 exit 1(단일 그룹 dedicated 커맨드라 가시적 실패가 정답). aggregate 내부 loyalty의 graceful try/except(경고 후 skip)는 '전체 파이프라인 보호'용이라 여기엔 부적합 — 독립 커맨드라 실패를 삼키지 않음. 3) 멱등 rebuild라 신규 방송이 없어도 매일 실행 무해(설계 §5: full DELETE 후 rebuild). 4) group 검증(KNOWN_GROUPS)은 추가하지 않음 — 설계상 live_chat 데이터 있는 그룹만 실질 산출되고 build_live_activity가 빈 윈도우를 basis=insufficient로 자체 처리(youtube_analytics_cmd도 KNOWN_GROUPS 게이트 없음).

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/worker/tests/unit/test_cli_live_activity.py`)

```
# /Users/user/Desktop/idol-sight/worker/tests/unit/test_cli_live_activity.py
# test_cli.py(CliRunner) 컨벤션 미러. build_live_activity 는 커맨드 본문에서
# 함수-로컬 import 되므로 SOURCE 모듈 속성을 monkeypatch 한다
# (idol_sight.analysis.live_activity.build_live_activity).
from typer.testing import CliRunner

from idol_sight.cli import app

runner = CliRunner()


def test_build_live_activity_help_present():
    res = runner.invoke(app, ["build-live-activity", "--help"])
    assert res.exit_code == 0
    assert "group" in res.output.lower()
    assert "miiwan" in res.output.lower()


def test_build_live_activity_invokes_builder_and_batches(monkeypatch):
    """build-live-activity 가 build_live_activity(client, group_key=, window_days=)
    를 호출하고 반환 statements 를 client.batch 로 적재, exit 0."""
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_client = MagicMock()
    fake_client.batch.return_value = MagicMock(
        statements_executed=2, statements_sent=2)
    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    monkeypatch.setattr(cli, "_make_d1_client", lambda s: fake_client)

    fake_result = MagicMock(statements=[("DELETE FROM agg_live_activity", []),
                                        ("INSERT ...", [1])])
    build = MagicMock(return_value=fake_result)
    monkeypatch.setattr(
        "idol_sight.analysis.live_activity.build_live_activity", build)

    res = runner.invoke(app, ["build-live-activity", "--group", "miiwan"])
    assert res.exit_code == 0
    build.assert_called_once()
    args, kwargs = build.call_args
    assert args[0] is fake_client
    assert kwargs["group_key"] == "miiwan"
    assert kwargs["window_days"] == 56
    fake_client.batch.assert_called_once_with(fake_result.statements)


def test_build_live_activity_passes_window_days_override(monkeypatch):
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_client = MagicMock()
    fake_client.batch.return_value = MagicMock(
        statements_executed=1, statements_sent=1)
    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    monkeypatch.setattr(cli, "_make_d1_client", lambda s: fake_client)
    build = MagicMock(return_value=MagicMock(statements=[("X", [])]))
    monkeypatch.setattr(
        "idol_sight.analysis.live_activity.build_live_activity", build)

    res = runner.invoke(
        app, ["build-live-activity", "--group", "miiwan", "--window-days", "28"])
    assert res.exit_code == 0
    assert build.call_args.kwargs["window_days"] == 28


def test_build_live_activity_exits_1_on_builder_error(monkeypatch):
    """build_live_activity 예외(예: 마이그레이션 미적용) → exit 1 + FAIL 메시지."""
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    monkeypatch.setattr(cli, "_make_d1_client", lambda s: MagicMock())

    def boom(*a, **k):
        raise RuntimeError("no such table: agg_live_activity")

    monkeypatch.setattr(
        "idol_sight.analysis.live_activity.build_live_activity", boom)

    res = runner.invoke(app, ["build-live-activity"])
    assert res.exit_code == 1
    assert "FAIL" in res.output


def test_build_live_activity_partial_write_exits_1(monkeypatch):
    """batch 부분쓰기(executed != sent) → exit 1 (backfill 패턴 미러)."""
    from unittest.mock import MagicMock

    import idol_sight.cli as cli

    fake_client = MagicMock()
    fake_client.batch.return_value = MagicMock(
        statements_executed=1, statements_sent=2)
    monkeypatch.setattr(cli, "load_settings", lambda: MagicMock())
    monkeypatch.setattr(cli, "_make_d1_client", lambda s: fake_client)
    monkeypatch.setattr(
        "idol_sight.analysis.live_activity.build_live_activity",
        MagicMock(return_value=MagicMock(statements=[("A", []), ("B", [])])))

    res = runner.invoke(app, ["build-live-activity"])
    assert res.exit_code == 1
    assert "partial live_activity write" in res.output

```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_cli_live_activity.py -v
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
# === cli.py 수정 (INSERT) ===
# 삽입 위치 anchor: rebuild_live_chat_reports 커맨드의 마지막 줄
#   (cli.py:1058) `    raise typer.Exit(code=1 if (reports == 0 and errors) else 0)`
# 와 다음 커맨드 (cli.py:1061) `@app.command(\n    "backfill-music-show-wins",` 사이.
#
# --- BEFORE (해당 경계) ---
#     raise typer.Exit(code=1 if (reports == 0 and errors) else 0)
#
#
# @app.command(
#     "backfill-music-show-wins",
#
# --- AFTER (사이에 아래 블록 삽입) ---
#     raise typer.Exit(code=1 if (reports == 0 and errors) else 0)
#
#
# <<< 여기에 신규 커맨드 삽입 >>>
#
#
# @app.command(
#     "backfill-music-show-wins",

@app.command(
    "build-live-activity",
    help=(
        "MiiWAN 찐팬 활동량 지표 산출 (P2a). 저장된 live_chat_messages"
        "(방송별 고유 챗터·챗터당 메시지·분당 피크·재방문) + youtube_video_stats"
        "(추정 관여 팬/적극 코어/시청 전환) 재가공으로 agg_live_activity / "
        "agg_live_activity_summary 에 멱등 rebuild. 신규 수집 0 — 기존 데이터 "
        "재가공. live_chat 데이터가 있는 그룹만 실질 산출 = miiwan."
    ),
)
def build_live_activity_cmd(
    group: str = typer.Option(
        "miiwan", "--group",
        help="대상 group_key. 현재 live_chat 수집은 miiwan 만.",
    ),
    window_days: int = typer.Option(
        56, "--window-days",
        help="코어팬·추정 영상 참여 윈도(일). 설계 기본 56.",
    ),
) -> None:
    from idol_sight.analysis.live_activity import build_live_activity

    settings = load_settings()
    client = _make_d1_client(settings)
    try:
        result = build_live_activity(
            client, group_key=group, window_days=window_days,
        )
    except Exception as exc:  # noqa: BLE001 — 단일 그룹, 마이그레이션 미적용 등 비치명적.
        typer.echo(f"[{group}] build-live-activity FAIL: {exc}", err=True)
        raise typer.Exit(code=1) from exc

    if result.statements:
        bs = client.batch(result.statements)
        if bs.statements_executed != bs.statements_sent:
            typer.echo(
                f"partial live_activity write: "
                f"{bs.statements_executed}/{bs.statements_sent}",
                err=True,
            )
            raise typer.Exit(code=1)
    typer.echo(
        f"[{group}] build-live-activity: wrote {len(result.statements)} rows"
    )

```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/worker && uv run pytest tests/unit/test_cli_live_activity.py -v
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2a): cli.py에 build-live-activity 커맨드 추가 (analysis.live_activity.build_live_activity wiring)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: collect-live-chat.yml 에 build-live-activity 스텝 1줄 추가 (collect 직후)

**Files:** /Users/user/Desktop/idol-sight/.github/workflows/collect-live-chat.yml (수정: collect-live-chat run 스텝과 notify on failure 스텝 사이에 build-live-activity 스텝 삽입)
**Test:** `N/A (워크플로 YAML — 단위테스트 없음, 수동/CI 검증)`

**Interfaces:** 워크플로 스텝은 task1의 CLI 커맨드 `build-live-activity --group miiwan` 를 정확히 호출. env는 CF_ACCOUNT_ID/CF_D1_DB_ID/CF_API_TOKEN(D1 접근)만 필요 — build_live_activity는 신규 수집 0(D1 재가공)이라 YT_API_KEY/GEMINI_API_KEY 불필요(collect 스텝과 달리 생략).

**Notes:** 1) 스텝 기본 의존: collect-live-chat 스텝이 실패(exit 1: ended && reports==0 && errors)하면 build-live-activity는 자동 skip되고 notify on failure(if: failure())가 발화 — 의도된 동작(가시성). collect가 'no candidate broadcasts'로 exit 0이어도 build는 실행되어 기존 데이터로 멱등 rebuild(무해). 2) 설계 §5 권장안 그대로(독립 커맨드 + 워크플로 1줄, collect 성공 직후 동일 워크플로). aggregate 사이클 편입(_run_aggregate) 대신 collect-live-chat.yml에 두는 이유: 데이터 신선도가 채팅 수집 직후 가장 높고, collect_live_chat과 동일 cron(KST 04/12시)에 묶임. 3) notify-fail --job 인자는 'collect-live-chat'로 유지(워크플로 단위 알림). 4) migrate.yml(agg_live_activity* 마이그레이션)이 이 워크플로 첫 실행 전에 적용돼야 함 — 미적용 시 build 스텝 exit 1(task1 try/except로 명시적 FAIL 메시지). 배포↔마이그레이션 순서는 기존 거버넌스 따름.

- [ ] **Step 1 — Write the failing test(s)** (append to `N/A (워크플로 YAML — 단위테스트 없음, 수동/CI 검증)`)

```
# 수동 검증 절차 (워크플로 — 단위테스트 없음)
#
# 1) YAML lint / 액션 파싱:
#    cd /Users/user/Desktop/idol-sight && python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/collect-live-chat.yml')); print('YAML OK')"
#    (또는 actionlint 설치 시: actionlint .github/workflows/collect-live-chat.yml)
#
# 2) 스텝 순서/이름 확인 (collect → build-live-activity → notify):
#    grep -n 'name:' .github/workflows/collect-live-chat.yml
#    기대: collect-live-chat, build-live-activity, notify on failure 순.
#
# 3) CLI 커맨드가 실제 등록되었는지(워크플로가 호출하는 그대로):
#    cd /Users/user/Desktop/idol-sight/worker && uv run python -m idol_sight build-live-activity --help
#    기대: exit 0, --group/--window-days 옵션 노출.
#
# 4) (선택) GitHub UI workflow_dispatch 수동 실행 → build-live-activity 스텝
#    로그에 '[miiwan] build-live-activity: wrote N rows' 출력, 워크플로 green.
#    (CF_* 시크릿은 collect 스텝과 동일하게 이미 설정됨.)
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight && python -c "import yaml; yaml.safe_load(open('.github/workflows/collect-live-chat.yml')); print('YAML OK')" && cd /Users/user/Desktop/idol-sight/worker && uv run python -m idol_sight build-live-activity --help
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
# === .github/workflows/collect-live-chat.yml 수정 (INSERT) ===
# collect-live-chat 스텝 직후(성공 시에만 실행 — step 기본 의존), notify 스텝 앞에 삽입.
#
# --- BEFORE ---
#         run: uv run python -m idol_sight collect-live-chat --group miiwan
#       - name: notify on failure
#         if: failure()
#
# --- AFTER ---
#         run: uv run python -m idol_sight collect-live-chat --group miiwan
#       - name: build-live-activity
#         working-directory: worker
#         env:
#           CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
#           CF_D1_DB_ID:   ${{ secrets.CF_D1_DB_ID }}
#           CF_API_TOKEN:  ${{ secrets.CF_API_TOKEN }}
#         run: uv run python -m idol_sight build-live-activity --group miiwan
#       - name: notify on failure
#         if: failure()
#
# 삽입할 정확한 YAML 블록(들여쓰기 6칸 — 기존 steps 항목과 동일):
      - name: build-live-activity
        working-directory: worker
        env:
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
          CF_D1_DB_ID:   ${{ secrets.CF_D1_DB_ID }}
          CF_API_TOKEN:  ${{ secrets.CF_API_TOKEN }}
        run: uv run python -m idol_sight build-live-activity --group miiwan

```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight && python -c "import yaml; yaml.safe_load(open('.github/workflows/collect-live-chat.yml')); print('YAML OK')" && cd /Users/user/Desktop/idol-sight/worker && uv run python -m idol_sight build-live-activity --help
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2a): collect-live-chat.yml 에 build-live-activity 스텝 1줄 추가 (collect 직후)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: miiwan.ts 확장 — agg_live_activity_summary(헤드라인)+agg_live_activity(방송별 추이)를 fan_activity 로 응답에 포함

**Files:** /Users/user/Desktop/idol-sight/frontend/functions/api/miiwan.ts (수정: interface 추가 ~L147 뒤, Promise.all 배열·구조분해 ~L184-293, 응답 fan_activity ~L535 뒤)
**Test:** `/Users/user/Desktop/idol-sight/frontend/tests/functions/api_miiwan_fan_activity.test.ts`

**Interfaces:** 생산(API 응답 top-level): `fan_activity: { generated_at:string; window_days:number; broadcast_count:number; basis:'scored'|'low_confidence'|'insufficient'; median_unique_chatters:number|null; median_msgs_per_chatter:number|null; median_returning_rate:number|null; median_peak_msgs_per_min:number|null; core_fan_count:number|null; core_fan_share:number|null; est_engaged_fans:number|null; est_active_core:number|null; view_through:number|null; like_rate:number|null; comment_rate:number|null; broadcasts: Array<{ video_id:string; ended_at:string|null; unique_chatters:number; total_messages:number; msgs_per_chatter:number|null; peak_msgs_per_min:number|null; returning_rate:number|null; basis:string }> } | null`. 소비 테이블: agg_live_activity_summary(group_key='miiwan' 1행), agg_live_activity(group_key='miiwan' N행). Task2(FanActivityCard)·Task3(MiiWANBriefing)가 이 shape 의존.

**Notes:** 엣지: (1) 마이그레이션(worker 담당, 0096 예정) 미적용 시 .catch 로 summary=null/broadcasts=[] → fan_activity=null(회귀 없음). loyalty 의 .catch 패턴과 동일 — 반드시 유지. (2) broadcasts ORDER BY ended_at ASC(오래된→최신) = FanLoyalty 의 '오래된→최신' 계약과 동일, 카드가 reverse. (3) summary SELECT 에서 group_key 생략(loyalty 미러, 항상 miiwan) → spread 깔끔. (4) 응답에 view_through/like_rate/comment_rate 포함(estimated 영상 참여) — 카드 보조 라인용. (5) 신규 수집 0 대원칙: 새 쿼리 2개 전부 기존 테이블 SELECT 만.

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/frontend/tests/functions/api_miiwan_fan_activity.test.ts`)

```
// frontend/tests/functions/api_miiwan_fan_activity.test.ts
//
// /api/miiwan 의 fan_activity 매핑 검증. 워커가 agg_live_activity_summary /
// agg_live_activity 에 적재한 행이 프론트(FanActivityCard)가 먹는 shape 로
// 정확히 실리는지 — D1→API 계약 고정. api_miiwan_decision.test.ts 미러.

import { describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../../functions/api/miiwan";

const MIIWAN = {
  key: "miiwan", name: "MiiWAN", name_kr: "미완소년",
  debut_date: "2026-06-01", yt_channel_id: "UCxxxx",
};

const envWith = (handler: (sql: string) => any[]) => ({
  DB: { prepare: vi.fn((sql: string) => ({
    bind: vi.fn().mockReturnThis(),
    all: vi.fn(async () => ({ results: handler(sql) })),
    first: vi.fn(async () => handler(sql)[0] ?? null),
  })) },
} as any);

function baseHandler(sql: string): any[] {
  if (sql.includes("FROM groups") && sql.includes("key IN")) return [];
  if (sql.includes("FROM groups")) return [MIIWAN];
  return [];
}

const SUMMARY = {
  generated_at: "2026-06-26T19:00:00Z", window_days: 56, broadcast_count: 3,
  median_unique_chatters: 99, median_msgs_per_chatter: 63.5,
  median_returning_rate: 0.42, median_peak_msgs_per_min: 180,
  core_fan_count: 38, core_fan_share: 0.31,
  est_engaged_fans: 220, est_active_core: 23,
  view_through: 2.6, like_rate: 0.08, comment_rate: 0.012, basis: "scored",
};
const BROADCASTS = [
  { video_id: "v_old", ended_at: "2026-06-16T13:00:00Z", unique_chatters: 140,
    total_messages: 8541, msgs_per_chatter: 61.0, peak_msgs_per_min: 210,
    returning_rate: null, basis: "low_confidence" },
  { video_id: "v_new", ended_at: "2026-06-17T13:00:00Z", unique_chatters: 99,
    total_messages: 5987, msgs_per_chatter: 60.5, peak_msgs_per_min: 180,
    returning_rate: 0.42, basis: "scored" },
];

describe("/api/miiwan fan_activity", () => {
  it("summary + broadcasts → fan_activity 로 정확 매핑(찐팬 활동량)", async () => {
    const env = envWith((sql) => {
      // 주의: summary 쿼리 SQL 이 'agg_live_activity' 를 포함하므로 _summary 먼저 분기.
      if (sql.includes("agg_live_activity_summary")) return [SUMMARY];
      if (sql.includes("agg_live_activity")) return BROADCASTS;
      return baseHandler(sql);
    });
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;

    const fa = body.fan_activity;
    expect(fa).not.toBeNull();
    expect(fa.basis).toBe("scored");
    expect(fa.median_unique_chatters).toBe(99);
    expect(fa.core_fan_share).toBe(0.31);
    expect(fa.est_engaged_fans).toBe(220);   // 추정 관여 팬(좋아요)
    expect(fa.est_active_core).toBe(23);     // 추정 적극 코어(댓글)
    // 방송별 추이 — 별도 쿼리 결과를 시간순 그대로 실어 보낸다.
    expect(fa.broadcasts).toHaveLength(2);
    expect(fa.broadcasts[0].video_id).toBe("v_old");
    expect(fa.broadcasts[0].returning_rate).toBeNull(); // 첫 방송
    expect(fa.broadcasts[1].returning_rate).toBe(0.42);
  });

  it("summary 행 없으면 fan_activity=null (프론트 '라이브 데이터 축적 중')", async () => {
    const env = envWith(baseHandler); // 모든 live_activity 쿼리 [] 반환
    const res = await onRequestGet({ env, request: new Request("https://x/") } as any);
    const body = await res.json() as any;
    expect(body.fan_activity).toBeNull();
  });
});
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/frontend && npx vitest run tests/functions/api_miiwan_fan_activity.test.ts
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
// ── 수정 1: interface 추가 (YtAnalyticsCountryRow 정의 직후, `const safeJson` 앞 L148 근처) ──
// AFTER: 아래 두 인터페이스를 삽입

// P2a 찐팬 활동량 — 신규 수집 0(기존 live_chat_messages·youtube_video_stats
// 재가공). agg_live_activity_summary(그룹 1행 헤드라인) + agg_live_activity
// (방송별 추이). 마이그레이션(0096 예정) 미적용이면 쿼리만 실패(.catch)하고
// fan_activity=null → 프론트가 '축적 중' empty-state. loyalty 미러.
interface LiveActivitySummaryRow {
  generated_at: string;
  window_days: number;
  broadcast_count: number;
  median_unique_chatters: number | null;
  median_msgs_per_chatter: number | null;
  median_returning_rate: number | null;
  median_peak_msgs_per_min: number | null;
  core_fan_count: number | null;
  core_fan_share: number | null;
  est_engaged_fans: number | null;
  est_active_core: number | null;
  view_through: number | null;
  like_rate: number | null;
  comment_rate: number | null;
  basis: "scored" | "low_confidence" | "insufficient";
}
interface LiveActivityBroadcastRow {
  video_id: string;
  ended_at: string | null;
  unique_chatters: number;
  total_messages: number;
  msgs_per_chatter: number | null;
  peak_msgs_per_min: number | null;
  returning_rate: number | null;
  basis: string;
}

// ── 수정 2: Promise.all 구조분해 (L184-188) ──
// BEFORE:
//   const [
//     summary, prevSummary, summaryHistory, health, members, insights, alerts,
//     controversyTrend, memberPopularity, ytAnalytics, ytAnalyticsCountries,
//     goodsPreorder,
//   ] = await Promise.all([
// AFTER:
  const [
    summary, prevSummary, summaryHistory, health, members, insights, alerts,
    controversyTrend, memberPopularity, ytAnalytics, ytAnalyticsCountries,
    goodsPreorder, liveActivitySummary, liveActivityBroadcasts,
  ] = await Promise.all([

// ── 수정 3: Promise.all 배열 끝, goodsPreorder 쿼리(`...source`/`[TARGET],),`)와 `]);` 사이에 삽입 (L292-293) ──
// BEFORE:
//         GROUP BY country, member_id, source`,
//       [TARGET],
//     ),
//   ]);
// AFTER: goodsPreorder 쿼리의 닫는 `),` 다음에 아래 두 쿼리를 추가하고 `]);`
    // P2a 찐팬 활동량 — summary(헤드라인) + 방송별 추이. 둘 다 MiiWAN 만 실질
    // 데이터. 테이블 미적용 시 .catch 로 graceful(null/[]) → 카드 '축적 중'.
    d1QueryOne<LiveActivitySummaryRow>(
      env.DB,
      `SELECT generated_at, window_days, broadcast_count,
              median_unique_chatters, median_msgs_per_chatter,
              median_returning_rate, median_peak_msgs_per_min,
              core_fan_count, core_fan_share,
              est_engaged_fans, est_active_core,
              view_through, like_rate, comment_rate, basis
         FROM agg_live_activity_summary WHERE group_key=?`,
      [TARGET],
    ).catch(() => null),
    d1Query<LiveActivityBroadcastRow>(
      env.DB,
      `SELECT video_id, ended_at, unique_chatters, total_messages,
              msgs_per_chatter, peak_msgs_per_min, returning_rate, basis
         FROM agg_live_activity
        WHERE group_key=? ORDER BY ended_at ASC LIMIT 24`,
      [TARGET],
    ).catch(() => [] as LiveActivityBroadcastRow[]),
  ]);

// ── 수정 4: 응답 객체 — decision 블록 닫는 `},` 다음, return jsonResponse 의 마지막 `});` 앞 (L535 근처) ──
// AFTER: decision: {...}, 바로 뒤에 추가
    // P2a 찐팬 활동량 — measured 라이브 코어 + estimated 영상 참여. 점수 아님
    // (현황 표시). summary 행 없으면 null → 카드 '라이브 데이터 축적 중'.
    // broadcasts 는 시간순(오래된→최신), 카드가 최신-위로 reverse.
    fan_activity: liveActivitySummary
      ? { ...liveActivitySummary, broadcasts: liveActivityBroadcasts }
      : null,
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/frontend && npx vitest run tests/functions/api_miiwan_fan_activity.test.ts
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2a): miiwan.ts 확장 — agg_live_activity_summary(헤드라인)+agg_live_activity(방송별 추이)를 fan_activity 로 응답에 포함" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: FanActivityCard.tsx 신설 — 3층위(추정 관여/측정 라이브 코어/추정 적극)+코어팬 비율+방송별 추이. FanLoyaltyCard 패턴 미러, '추정' 배지, 점수 아님

**Files:** /Users/user/Desktop/idol-sight/frontend/src/components/FanActivityCard.tsx (신규)
**Test:** `/Users/user/Desktop/idol-sight/frontend/src/components/FanActivityCard.test.ts`

**Interfaces:** 생산: `export function FanActivityCard({ activity: FanActivity })` — Task3(MiiWANBriefing)가 `<FanActivityCard activity={data.fan_activity} />` 로 소비. `export interface FanActivity`(+FanActivityBroadcast) — Task1 의 fan_activity 응답 shape 와 1:1. export 헬퍼 `fmtRate/fmtInt/fmtDecimal/barWidthPct` — 단위테스트 대상.

**Notes:** 엣지: (1) basis==='insufficient' → '라이브 데이터 축적 중'만 렌더(FanLoyaltyCard 미러). (2) basis==='low_confidence'(방송 1) → 카드 하단 '단발 방송 기준 — 재방문·코어팬 미산정', core_fan_share=null 이라 코어팬 라인 자동 숨김. (3) returning_rate=null(첫 방송) → '재방문 —'. (4) preact JSX(class=, h/import 불필요) — FanLoyaltyCard 와 동일. (5) fmtInt 는 median 이 x.5(짝수 표본) 가능하므로 Math.round. (6) toLocaleString 의 천 단위 구분은 로케일 의존이라 테스트는 구분자 없는 소수만 단언(결정성).

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/frontend/src/components/FanActivityCard.test.ts`)

```
// frontend/src/components/FanActivityCard.test.ts
//
// FanActivityCard 의 순수 포맷/막대 헬퍼 단위 검증 (FanLoyaltyCard.test.ts 미러).
// JSX 렌더는 검증하지 않고 export 헬퍼만 — environment:node 컨벤션 유지.

import { describe, it, expect } from "vitest";
import { fmtRate, fmtInt, fmtDecimal, barWidthPct } from "./FanActivityCard";

describe("fmtRate", () => {
  it("비율을 소수 1자리 %로", () => {
    expect(fmtRate(0.635)).toBe("63.5%");
    expect(fmtRate(0.0008)).toBe("0.1%");
    expect(fmtRate(null)).toBe("—");
    expect(fmtRate(undefined)).toBe("—");
  });
});

describe("fmtInt", () => {
  it("반올림 정수, null/undefined 는 대시", () => {
    expect(fmtInt(99.4)).toBe("99");
    expect(fmtInt(99.5)).toBe("100");   // est_active_core 등 x.5 median 가드
    expect(fmtInt(0)).toBe("0");
    expect(fmtInt(null)).toBe("—");
    expect(fmtInt(undefined)).toBe("—");
  });
});

describe("fmtDecimal", () => {
  it("소수 1자리, null 은 대시", () => {
    expect(fmtDecimal(60.49)).toBe("60.5");
    expect(fmtDecimal(7)).toBe("7.0");
    expect(fmtDecimal(null)).toBe("—");
  });
});

describe("barWidthPct", () => {
  it("max 기준 0~100 정규화", () => {
    expect(barWidthPct(99, 99)).toBe(100);
    expect(barWidthPct(49.5, 99)).toBe(50);
    expect(barWidthPct(0, 99)).toBe(0);
  });
  it("max 가 0/음수면 0 (0 나눗셈 가드)", () => {
    expect(barWidthPct(10, 0)).toBe(0);
    expect(barWidthPct(10, -3)).toBe(0);
  });
});
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/frontend && npx vitest run src/components/FanActivityCard.test.ts
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
// frontend/src/components/FanActivityCard.tsx
//
// P2a 찐팬 활동량 카드 (MiiWAN 전용). FanLoyaltyCard 의 구조/색/막대 컨벤션
// 미러. 점수가 아니라 '현황 표시' — measured 라이브 코어(고유 챗터·재방문)와
// estimated 영상 참여(좋아요·댓글)를 서로 다른 참여 표면으로 병치한다.
// 신규 수집 0(기존 데이터 재가공). 추정 항목엔 '추정' 배지.

import { formatKSTMonthDayWeekday } from "../lib/datetime";

export interface FanActivityBroadcast {
  video_id: string;
  ended_at: string | null;
  unique_chatters: number;
  total_messages: number;
  msgs_per_chatter: number | null;
  peak_msgs_per_min: number | null;
  returning_rate: number | null;
}

export interface FanActivity {
  generated_at: string;
  window_days: number;
  broadcast_count: number;
  basis: "scored" | "low_confidence" | "insufficient";
  median_unique_chatters: number | null;
  median_msgs_per_chatter: number | null;
  median_returning_rate: number | null;
  median_peak_msgs_per_min: number | null;
  core_fan_count: number | null;
  core_fan_share: number | null;
  est_engaged_fans: number | null;
  est_active_core: number | null;
  view_through: number | null;
  like_rate: number | null;
  comment_rate: number | null;
  broadcasts: FanActivityBroadcast[];
}

/** 비율(0~1)을 소수 1자리 %로. null → "—". (FanLoyaltyCard.fmtPct 미러) */
export function fmtRate(rate: number | null | undefined): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/** 정수 카운트 표시(반올림 + 천 단위 구분). null → "—". */
export function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—";
  return Math.round(n).toLocaleString();
}

/** 소수 1자리(챗터당 메시지 등). null → "—". */
export function fmtDecimal(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toFixed(1);
}

/** 막대 폭(0~100): set 의 max 대비 정규화. max<=0 가드. (FanLoyaltyCard 미러) */
export function barWidthPct(value: number, max: number): number {
  if (max <= 0) return 0;
  return (value / max) * 100;
}

function EstBadge() {
  return (
    <span
      title="공개 외형 신호로 가늠한 추정치 — 인간 판단을 대체하지 않음"
      class="ml-1 rounded bg-zinc-800/60 px-1 py-[1px] text-[10px] text-zinc-500"
    >추정</span>
  );
}

function TierCell(
  { label, sub, value, estimated, tip }:
  { label: string; sub: string; value: string; estimated?: boolean; tip?: string },
) {
  return (
    <div class="rounded border border-zinc-800 bg-zinc-900/40 p-2" title={tip}>
      <div class="flex items-center text-hint text-zinc-500">
        {label}{estimated && <EstBadge />}
      </div>
      <div class="text-lg font-bold tabular-nums text-zinc-100">{value}</div>
      <div class="text-[10px] text-zinc-500">{sub}</div>
    </div>
  );
}

export function FanActivityCard({ activity }: { activity: FanActivity }) {
  const {
    basis, window_days, broadcast_count, broadcasts,
    median_unique_chatters, est_engaged_fans, est_active_core,
    core_fan_count, core_fan_share,
    view_through, like_rate, comment_rate,
  } = activity;

  // 추이 ladder: 최신이 위. API 는 오래된→최신 이라 reverse. 막대는 방송별
  // 고유 챗터(단골 코어) 규모를 set max 대비로 정규화.
  const rows = [...broadcasts].reverse();
  const maxChatters = rows.reduce((m, b) => Math.max(m, b.unique_chatters), 0);

  return (
    <section class="rounded-lg border border-zinc-800 p-3">
      <div class="mb-1 flex items-baseline justify-between">
        <h3 class="text-sm font-semibold">찐팬 활동량 (라이브 코어 + 추정 참여)</h3>
        <span class="text-hint text-zinc-500">최근 {window_days}일 · 방송 {broadcast_count}회</span>
      </div>

      {basis === "insufficient" ? (
        <div class="text-data text-zinc-500">라이브 데이터 축적 중</div>
      ) : (
        <>
          {/* 3층위 — 참여 강도별 병치(엄격한 포함관계 아님, 서로 다른 표면) */}
          <div class="grid grid-cols-3 gap-2">
            <TierCell
              label="추정 관여 팬" sub="좋아요 반응" estimated
              value={fmtInt(est_engaged_fans)}
              tip="영상에 좋아요로 반응한 추정 팬 수 — 좋아요는 영상당 1인 1회라 고유 인원 근사"
            />
            <TierCell
              label="측정 라이브 코어" sub="고유 챗터(중앙값)"
              value={fmtInt(median_unique_chatters)}
              tip="라이브 채팅에 실제로 글을 남긴 고유 인원 — 실측값"
            />
            <TierCell
              label="추정 적극 코어" sub="댓글" estimated
              value={fmtInt(est_active_core)}
              tip="영상 댓글 수 — 1인 다회 가능하므로 적극 참여의 상한 추정"
            />
          </div>

          {/* 코어팬 비율 헤드라인 */}
          {core_fan_share != null && (
            <div class="mt-2 flex flex-wrap items-baseline gap-x-2 text-data text-zinc-400">
              <span>코어팬</span>
              <span class="font-semibold text-teal-300">{fmtInt(core_fan_count)}명</span>
              <span>· 윈도우 챗터의</span>
              <span class="font-semibold text-teal-300">{fmtRate(core_fan_share)}</span>
              <span class="text-hint text-zinc-500">(2회 이상 방송에 다시 온 단골)</span>
            </div>
          )}

          {/* 영상 참여율 — 추정(estimated) 보조 라인 */}
          {(like_rate != null || view_through != null) && (
            <div class="mt-1 flex flex-wrap items-center gap-x-3 text-hint text-zinc-500">
              <span class="flex items-center">영상 참여율<EstBadge /></span>
              <span>좋아요율 {fmtRate(like_rate)}</span>
              <span>댓글율 {fmtRate(comment_rate)}</span>
              <span title="구독자 중 실제로 영상을 본 추정 비율">시청 전환 {fmtRate(view_through)}</span>
            </div>
          )}

          {/* 방송별 추이 — 날짜·고유 챗터(막대)·챗터당 메시지·분당 피크·재방문 */}
          {rows.length > 0 && (
            <div class="mt-3 border-t border-zinc-800/70 pt-2.5">
              <div class="mb-1.5 flex justify-between text-hint text-zinc-400">
                <span>방송별 단골 코어 (고유 챗터)</span>
                <span>고유 챗터 수</span>
              </div>
              {rows.map((b, i) => {
                const latest = i === 0;
                return (
                  <div
                    key={b.video_id}
                    class={`rounded px-1 py-1 ${latest ? "bg-teal-500/10" : ""}`}
                  >
                    <div class="grid grid-cols-[56px_1fr_auto] items-center gap-2.5">
                      <span class="text-hint tabular-nums text-zinc-400">
                        {formatKSTMonthDayWeekday(b.ended_at)}
                      </span>
                      <div class="relative h-3.5">
                        <div
                          class={`absolute left-0 top-0 h-full rounded-sm ${
                            latest ? "bg-teal-500/45" : "bg-teal-500/25"
                          }`}
                          style={`width:${barWidthPct(b.unique_chatters, maxChatters)}%`}
                        />
                      </div>
                      <span class={`min-w-[56px] text-right text-data tabular-nums ${
                        latest ? "font-semibold text-teal-300" : "text-zinc-200"
                      }`}>
                        {fmtInt(b.unique_chatters)}명
                      </span>
                    </div>
                    <div class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-[56px] text-hint text-zinc-500">
                      <span title="챗터 1인당 평균 메시지 수 — 코어 밀도">
                        챗터당 {fmtDecimal(b.msgs_per_chatter)}개
                      </span>
                      <span title="분당 최고 채팅량 — 방송 중 가장 뜨거웠던 순간">
                        분당 피크 {fmtInt(b.peak_msgs_per_min)}
                      </span>
                      <span title="이번 방송에 다시 온 단골 비율 (직전 방송 대비)">
                        재방문 {fmtRate(b.returning_rate)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {basis === "low_confidence" && (
        <div class="mt-1 text-hint text-amber-500/80">단발 방송 기준 — 재방문·코어팬 미산정</div>
      )}

      <div class="mt-2 text-hint text-zinc-500">
        '측정'은 라이브 채팅 실측(고유 챗터·재방문), '추정'은 영상 좋아요·댓글로
        가늠한 근사치 — 서로 다른 참여 표면이라 단순 비교는 금물. 점수 아님(현황 표시).
      </div>
    </section>
  );
}
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/frontend && npx vitest run src/components/FanActivityCard.test.ts
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2a): FanActivityCard.tsx 신설 — 3층위(추정 관여/측정 라이브 코어/추정 적극)+코어팬 비율+방송별 추이. FanLoyaltyCard 패턴 미러, '추정' 배지, 점수 아님" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: MiiWANBriefing.tsx 에 FanActivityCard 삽입 — MiiwanData 타입 확장 + 라이브 채팅 카드 직후 렌더

**Files:** /Users/user/Desktop/idol-sight/frontend/src/views/MiiWANBriefing.tsx (수정: import ~L39, MiiwanData 타입 ~L117, 렌더 ~L481)
**Test:** `/Users/user/Desktop/idol-sight/frontend/src/views/MiiWANBriefing.tsx (tsc 타입체크로 검증 — 별도 단위테스트 없음, Task1/Task2 가 로직 커버)`

**Interfaces:** 소비: Task1 의 `body.fan_activity`(api.miiwan() 응답) → MiiwanData.fan_activity. Task2 의 `FanActivityCard`/`FanActivity` import. 신규 생산 인터페이스 없음(조립부).

**Notes:** 엣지: (1) data.fan_activity 가 null 이면 `&&` 단락으로 카드 자체 미노출 — FanLoyaltyCard 가 GroupContent 에서 `{data.fan_loyalty && <FanLoyaltyCard .../>}` 하는 패턴과 동일. (2) MiiWAN 전용 뷰라 노출 그룹 게이트 불필요(설계서 6절). (3) <MiiWANLiveChat /> 직후 배치 = 둘 다 라이브 채팅 파생 지표라 주제적 인접. (4) api.miiwan() 이 이미 fetch 한 data 를 쓰므로 추가 네트워크 호출 없음. (5) tsc -b 는 모노레포 전체를 볼 수 있으니, 빠른 확인은 vitest(Task1·2)로 로직 회귀를 먼저 잡고 tsc 는 prop 정합만 본다.

- [ ] **Step 1 — Write the failing test(s)** (append to `/Users/user/Desktop/idol-sight/frontend/src/views/MiiWANBriefing.tsx (tsc 타입체크로 검증 — 별도 단위테스트 없음, Task1/Task2 가 로직 커버)`)

```
// 별도 단위테스트 없음 — 뷰 조립부는 tsc 타입체크 + 수동확인으로 검증.
//
// [tsc 검증]
//   cd /Users/user/Desktop/idol-sight/frontend && npx tsc -b --noEmit
//   → fan_activity: FanActivity | null 타입과 <FanActivityCard activity=.../>
//     prop 타입이 일치해야 통과(Task2 의 FanActivity export 와 결합).
//
// [수동확인 절차]
//   1. cd frontend && npx vite (또는 wrangler pages dev) 로 로컬 구동.
//   2. MiiWAN 브리핑 탭 → '라이브 채팅' 카드 바로 아래 '찐팬 활동량' 카드 확인.
//   3. 시나리오:
//      - fan_activity=null(테이블 미적용/축적 전): 카드 미노출(회귀 없음).
//      - basis='insufficient': '라이브 데이터 축적 중'.
//      - basis='scored': 3층위(추정 관여/측정 라이브 코어/추정 적극) + 코어팬
//        비율 + 방송별 추이 막대 + '추정' 배지 노출, 날짜는 KST(MM/DD 요일).
```

- [ ] **Step 2 — Run, expect FAIL**

```
cd /Users/user/Desktop/idol-sight/frontend && npx tsc -b --noEmit
```

- [ ] **Step 3 — Apply implementation** (create/modify Files above)

```
// ── 수정 1: import 추가 (L39 `import { CompetitorOrganicityBar } ...` 다음 줄) ──
// AFTER:
import { FanActivityCard, type FanActivity } from "../components/FanActivityCard";

// ── 수정 2: MiiwanData 타입에 fan_activity 추가 (L116-118) ──
// BEFORE:
//   controversy_trend: { current: number; previous: number | null } | null;
//   decision: DecisionData;
// };
// AFTER:
  controversy_trend: { current: number; previous: number | null } | null;
  decision: DecisionData;
  // P2a 찐팬 활동량 — agg_live_activity_summary 행 없으면 null(카드 '축적 중').
  fan_activity: FanActivity | null;
};

// ── 수정 3: 렌더 — <MiiWANLiveChat /> (L481) 직후에 카드 삽입 ──
// BEFORE:
//       {/* 종료된 라이브 방송의 채팅을 긁어 긍/부정 대표 멘트 + 비율 추정을
//           방송별로 보여준다. /api/miiwan-live-chat (live_chat_reports). */}
//       <MiiWANLiveChat />
// AFTER: <MiiWANLiveChat /> 다음 줄에 추가
      {/* 종료된 라이브 방송의 채팅을 긁어 긍/부정 대표 멘트 + 비율 추정을
          방송별로 보여준다. /api/miiwan-live-chat (live_chat_reports). */}
      <MiiWANLiveChat />

      {/* P2a 찐팬 활동량 — 라이브 채팅 measured 코어 + 영상 estimated 참여.
          /api/miiwan 의 fan_activity (신규 수집 0, 기존 데이터 재가공).
          summary 행 없으면 null 이라 카드 자체를 숨긴다. */}
      {data.fan_activity && <FanActivityCard activity={data.fan_activity} />}
```

- [ ] **Step 4 — Run, expect PASS**

```
cd /Users/user/Desktop/idol-sight/frontend && npx tsc -b --noEmit
```

- [ ] **Step 5 — Commit**

```bash
git -C /Users/user/Desktop/idol-sight add -A
git -C /Users/user/Desktop/idol-sight commit -m "feat(p2a): MiiWANBriefing.tsx 에 FanActivityCard 삽입 — MiiwanData 타입 확장 + 라이브 채팅 카드 직후 렌더" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

