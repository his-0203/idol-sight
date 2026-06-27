import json

from idol_sight.analysis.live_chat_report import SAMPLE, _sample, build_report


class _FakeGemini:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def generate(self, *, system_prompt, context, response_schema):
        self.calls.append(context)
        return self.payload


def _msgs(n):
    return [{"msg_id": f"m{i}", "offset_ms": i * 1000, "author": "u",
             "message": f"msg {i}"} for i in range(n)]


def test_sample_dedups_and_caps():
    raw = [{"message": "같은말"}, {"message": "같은말"}, {"message": " 같은말 "},
           {"message": "ㅋ"}, {"message": "다른말"}]
    s = _sample(raw)
    texts = sorted(m["message"].strip() for m in s)
    assert texts == ["같은말", "다른말"]  # dedup(normalize) + 너무 짧은 'ㅋ' 제외


def test_sample_strides_when_over_cap():
    s = _sample(_msgs(SAMPLE * 3))
    assert len(s) == SAMPLE


def test_build_report_returns_insert_statement_with_counts():
    gem = _FakeGemini({
        "positive_ratio": 0.7, "negative_ratio": 0.2,
        "positive_quotes": [{"quote": "최고"}], "negative_quotes": [{"quote": "별로"}],
        "themes": [{"label": "무대", "polarity": "positive"}],
        "summary": "대체로 호평",
    })
    stmt = build_report(
        gem, video_id="vid", group_key="miiwan", group_name_kr="미완소년",
        title="첫 라이브", ended_at="2026-06-16T01:00:00Z", messages=_msgs(10),
        now_iso="2026-06-16T04:00:00Z",
    )
    assert stmt is not None
    sql, params = stmt
    assert sql.startswith("INSERT INTO live_chat_reports")
    assert "ON CONFLICT(video_id)" in sql
    # params order: video_id, group_key, title, ended_at, generated_at,
    #               total_messages, sampled, positive_ratio, negative_ratio, report_json
    assert params[0] == "vid" and params[1] == "miiwan"
    assert params[5] == 10                # total_messages
    assert params[6] == 10                # sampled (<= cap)
    assert params[7] == 0.7 and params[8] == 0.2
    rj = json.loads(params[9])
    assert rj["positive"][0]["quote"] == "최고"
    assert rj["summary"] == "대체로 호평"


def test_build_report_none_on_empty_messages():
    gem = _FakeGemini({})
    assert build_report(gem, video_id="v", group_key="miiwan", group_name_kr="미완소년",
                        title=None, ended_at=None, messages=[],
                        now_iso="2026-06-16T04:00:00Z") is None


def test_build_report_splits_full_sample_by_index():
    # LLM 이 표본 인덱스로 긍/부정 전체를 분류 → 워커가 원문(verbatim)으로 해석해 저장
    gem = _FakeGemini({
        "positive_ratio": 0.5, "negative_ratio": 0.3,
        "positive_quotes": [{"quote": "msg 0"}], "negative_quotes": [{"quote": "msg 9"}],
        "summary": "혼재",
        "positive_idx": [0, 2, 4], "negative_idx": [9, 7],
    })
    stmt = build_report(
        gem, video_id="vid", group_key="miiwan", group_name_kr="미완소년",
        title=None, ended_at=None, messages=_msgs(10),
        now_iso="2026-06-16T04:00:00Z",
    )
    assert stmt is not None
    rj = json.loads(stmt[1][9])
    assert rj["positive_all"] == ["msg 0", "msg 2", "msg 4"]
    assert rj["negative_all"] == ["msg 9", "msg 7"]  # 입력 순서 보존


def test_build_report_ignores_out_of_range_index():
    gem = _FakeGemini({
        "positive_ratio": 0.5, "negative_ratio": 0.0,
        "positive_quotes": [], "negative_quotes": [], "summary": "",
        "positive_idx": [0, 99, -1], "negative_idx": [],
    })
    stmt = build_report(
        gem, video_id="vid", group_key="miiwan", group_name_kr="미완소년",
        title=None, ended_at=None, messages=_msgs(3),
        now_iso="2026-06-16T04:00:00Z",
    )
    assert stmt is not None
    rj = json.loads(stmt[1][9])
    assert rj["positive_all"] == ["msg 0"]   # 99, -1 은 범위 밖 → 무시
    assert rj["negative_all"] == []


def test_build_report_full_sample_absent_defaults_empty():
    # 구버전 페이로드(idx 키 없음)도 graceful — positive_all/negative_all 빈 배열
    gem = _FakeGemini({
        "positive_ratio": 0.7, "negative_ratio": 0.2,
        "positive_quotes": [{"quote": "최고"}], "negative_quotes": [],
        "summary": "호평",
    })
    stmt = build_report(
        gem, video_id="vid", group_key="miiwan", group_name_kr="미완소년",
        title=None, ended_at=None, messages=_msgs(5),
        now_iso="2026-06-16T04:00:00Z",
    )
    assert stmt is not None
    rj = json.loads(stmt[1][9])
    assert rj["positive_all"] == []
    assert rj["negative_all"] == []
