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
