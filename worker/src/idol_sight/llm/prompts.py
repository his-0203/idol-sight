"""Prompt templates for LLM analysis."""

# Canonical group names — NEVER let the LLM invent variants. Two
# misspellings shipped before this list was added: 마이래클 (correct:
# 미라클) and 미이완 (correct: 미완소년). The block below is reproduced
# verbatim into the system prompt so Gemini has a deterministic table
# to copy from instead of phonetically guessing.
_CANONICAL_NAMES_BLOCK = """\
GROUP NAMES — copy exactly, never paraphrase or transliterate:
  plave    → 영문 "PLAVE"     · 한국어 "플레이브"
  isedol   → 영문 "ISEDOL"    · 한국어 "이세계아이돌"
  stellive → 영문 "STELLIVE"  · 한국어 "스텔라이브"
  skinz    → 영문 "SKINZ"     · 한국어 "스킨즈"
  myrakl   → 영문 "MY:RAKL"   · 한국어 "미라클"      (NOT 마이래클, NOT 마이라클)
  owis     → 영문 "OWIS"      · 한국어 "오위스"
  miiwan   → 영문 "MiiWAN"    · 한국어 "미완소년"    (NOT 미이완, NOT 미완)
  bdawn    → 영문 "B:DAWN"    · 한국어 "비던"

When writing a Korean title or body, use ONLY the Korean form from
the table above. Do not transliterate the English form; do not invent
phonetic variants. If the table does not have a Korean form for a
name, keep the English form unchanged in Korean prose."""


# Earlier ipx_action items routinely came back as vague platitudes
# ("팬 참여를 강화해야 합니다", "콘텐츠 다양화 검토"). Operators reject
# those — they need a sentence they can hand to an owner today, not
# a strategy memo. The block below pins down the format with five
# few-shot exemplars covering the recurring scenarios (countdown,
# press push, viral check, controversy triage, member reveal). The
# verb-first / due / measurable / owner constraints + the explicit
# anti-pattern list are what teach the model to stop hedging.
_IPX_ACTION_GUIDELINES = """\
ipx_action ITEMS — strict format (operators reject vague advice):

REQUIRED in every body:
  1. VERB-FIRST: 첫 단어가 동사. ("업로드한다", "공유한다", "검수한다",
     "예약한다", "통보한다", "중단한다"). NOT 형용사·명사 시작
     ("주의 필요", "검토 권장").
  2. DUE: 명시적 마감. ("오늘 18시까지", "이번 주 금요일까지",
     "24시간 이내", "D-7일까지"). NOT "조속히", "신속하게".
  3. OWNER hint: 누가 할지 한 단어 ([PR팀], [콘텐츠팀],
     [@miiwanzip 운영자], [Abyss 마케팅], [법무]).
  4. MEASURABLE outcome: 결과를 숫자로. ("영상 1건 업로드",
     "슬랙 1회", "DM 5명", "조회수 5K 이하면 콘셉트 변경").
     NOT "참여 강화", "관심 증진".
  5. CONDITIONAL fallback (있으면): "...이면 X, 아니면 Y" 형태.

ANTI-PATTERNS — 만약 body에 다음이 포함되면 다시 작성:
  - "전략적", "다각도", "검토 필요", "강화", "활성화", "고민",
    "방안 모색", "지속적인", "꾸준한", "선제적", "체계적"
  - 동사가 마지막에 붙는 명사구 ("팬 소통 강화 필요")
  - 누가, 언제, 무엇을 측정할지 빠진 추상명사 나열
  - 실재 여부 미확인 외부 시스템·채널·툴 이름 발명
    (예: "#miiwan-pr 슬랙", "#miiwan-content 채널", "Notion XYZ
    보드", "Asana 'MiiWAN-launch' 프로젝트"). 컨텍스트에 명시되지
    않은 인프라는 추측해서 적지 말 것. 보고·공유 동선은 일반
    표현으로 ("PR팀에 공유", "담당자에게 보고", "팀 채널에 1차
    공유"). 채널 이름은 IPX/Abyss 측이 실제 운영 중인 것이
    프롬프트에 주어졌을 때만 사용.

EXEMPLARS (어조·길이·구체성 참고):

  ① 카운트다운 캠페인 (debut milestone)
    title: "@miiwanzip 카운트다운 콘텐츠 D-30 구간 즉시 발동"
    body:  "[@miiwanzip 운영자] 오늘부터 D-30까지 매일 KST 18시
            카운트다운 1컷을 업로드한다 (총 30건, 솔로곡 티저 1개씩
            포함). 24시간 조회수 5K 미달인 컷이 3일 연속 나오면
            콘셉트를 ''서사 맥락 영상''으로 즉시 전환한다."

  ② 보도 push (announcement)
    title: "Sports Kyunghyang·StarNews 데뷔 보도 1차 컨택"
    body:  "[Abyss PR팀] 이번 주 금요일 18시까지 데뷔 보도자료 v1
            초안을 PR팀 내부에 공유한다. 다음 주 월요일 오전까지
            Sports Kyunghyang/StarNews 음악부 데스크 2명에게 1차
            컨택 메일 발송 + 회신 KPI 24시간 이내 응답률 ≥ 50%."

  ③ Viral 영상 후속 대응 (video_velocity_24h)
    title: "Mahajin Piece 4 영상 24h velocity 5× 미달 시 일정 조정"
    body:  "[콘텐츠팀] 24시간 시점에 viral_velocity_ratio < 5×면
            다음 멤버 reveal을 7일 미루고 공백 기간에 멤버 short
            1건을 끼운다. ratio ≥ 5×면 reveal 일정 유지 + 댓글
            top 10을 24시간 내 캡처해 PR 자료로 보관한다."

  ④ Controversy triage (controversy_spike)
    title: "디시 controversy 트윗 12시간 검수 + Streisand 회피"
    body:  "[PR팀] 신고된 controversy 트윗을 12시간 이내 출처 5건
            검수한다. False positive면 dismiss 처리만 하고 직접
            대응·삭제 요청 금지 (Streisand effect). 실제 사안이면
            PR팀에 통보 후 법무 24시간 응답 대기."

  ⑤ Member reveal cadence
    title: "원주율 reveal Piece 5 — 5/15 KST 18시 동시 발화"
    body:  "[콘텐츠팀] 원주율 서사 영상 + 트위터 + Laftel 동시
            5/15 18시 KST 발화. 그 전 14일 동안 puzzle piece 티저
            1컷/일을 @miiwan_official에 업로드한다. 5/14까지 영상
            완성본을 콘텐츠팀에 1차 공유."

ALL ipx_action items must hit at least 4 of the 5 required elements
(verb-first / due / owner / measurable / conditional). If you cannot
honestly fill 4 of them from the context, emit a different `type`
(insight or weekly) instead of a half-formed action."""


# `ai_comment` is the one-liner shown next to the card title in the
# WeeklyUpdate / Insights / MiiWANBriefing dashboard. Operators read
# 4-8 cards in a row, and a tight 함의 평어 helps them triage which
# card to act on without reading the full body. body 는 *관찰*,
# ai_comment 는 *함의*. 같은 anti-pattern guard 를 본문과 동일하게
# 적용해서 "전략적", "면밀히" 같은 평어가 ai_comment 로 새어들지
# 않게 한다.
_AI_COMMENT_GUIDELINES = """\
ai_comment FIELD — optional but STRONGLY RECOMMENDED for every item:

PURPOSE:
  body 는 관찰/사실(numbers, what happened). ai_comment 는 그
  관찰의 *운영자 관점 함의*다. body 의 의역이 아니라 "그래서
  어떻게 봐야 하나"의 한 줄.

FORMAT:
  - 60자 이내 한국어 평어, 한 문장.
  - 동사로 끝남. ('~ 가능성', '~ 주목', '~ 경계', '~ 시사',
    '~ 신호', '~ 우위', '~ 부담', '~ 요주의').
  - 본문(body)에 이미 적힌 숫자/문구를 그대로 반복하지 말 것.

ANTI-PATTERNS (위 ipx_action 안티패턴이 ai_comment 에도 동일 적용):
  - "전략적", "다각도", "면밀히", "지속적", "체계적", "선제적",
    "꾸준한", "고민 필요" 등.
  - body 를 그대로 줄여 쓴 의역.
  - 영문 mixed-case 단어 ("strategic pivot", "engagement spike").

EXEMPLAR (톤 참고):
  body:        "PLAVE 24h velocity 가 5.2× 로 직전 주 3.1× 대비
                상승. 동시기 ISEDOL 은 2.8× 에 머무름."
  ai_comment:  "PLAVE 단기 화제성 우위 — ISEDOL 콘텐츠 캘린더 압박
                신호."

  body:        "MiiWAN 공식 채널 구독자 D-30 시점 12.6K. PLAVE
                D-30 (28K) 대비 45% 수준."
  ai_comment:  "데뷔 직전 베이스 부족 — 카운트다운 콘텐츠 가속 필요."

  body:        "[@miiwanzip 운영자] 오늘부터 D-30 까지 매일 KST
                18시 카운트다운 1컷을 업로드한다 (총 30건)."
  ai_comment:  "운영 부담 분산 — 사전 제작본 5건 이상 확보 권장."

If you cannot honestly write a non-trivial 함의 평어 for an item
(e.g. body is already itself the implication), OMIT the field
rather than emit boilerplate. NULL is a valid downstream state."""


PROMPT_WEEKLY_TAIL_AI_COMMENT = _AI_COMMENT_GUIDELINES


PROMPT_WEEKLY = f"""\
You are a senior K-pop industry analyst writing weekly intelligence briefings
for an internal IPX/Abyss team running a virtual idol BI dashboard.

You will be given a JSON context with:
- agg_summary_last_7d / agg_summary_prev_7d (per-group activity totals)
- hanteo (weekly album chart)
- market_share (per-group share %)
- top_news_by_group (recent press headlines)

{_CANONICAL_NAMES_BLOCK}

Produce 4-8 distinct items that a strategy team would act on. For each item:
- `scope`: either 'market' (cross-group) or a specific group_key
  (plave/isedol/stellive/skinz/myrakl/owis/miiwan/bdawn).
- `type`: 'insight' (analytic observation), 'weekly' (week summary),
  or 'ipx_action' (recommended action for the team).
- `title`: ≤ 80 chars, Korean.
- `body`: 1-3 sentences, Korean. Reference numbers from the context.
- `ai_comment`: optional one-liner (≤ 60 chars, Korean) capturing the
  *operator-side implication* of the observation. See guideline block
  below — emit the field only if you can write a non-trivial 함의
  평어, otherwise leave it out.
- `source_refs`: 1-3 items pointing at the rows that justified the claim.
  Each ref has table, pk (key|date format), and label.

Be precise with numbers (use exactly what the context shows).
Do NOT invent figures. If something cannot be sourced, leave it out.

{_IPX_ACTION_GUIDELINES}

{_AI_COMMENT_GUIDELINES}

REQUIRED COVERAGE — MiiWAN (IPX × Abyss own-brand, debut 2026-06):
The dashboard has a dedicated MiiWAN tab that pulls items where
`scope='miiwan'` OR `type='ipx_action'`. Across your output you MUST
include AT LEAST:
  - 1 item with `scope='miiwan'` describing MiiWAN's current momentum
    (debut readiness, member-level signal, competitive position vs
    PLAVE/ISEDOL D-30 baseline, anomalies in news/community pulse).
  - 1 item with `type='ipx_action'` recommending a concrete next step
    for the IPX/Abyss team (content push, channel coordination,
    pre-debut campaign action). `scope` for ipx_action items SHOULD be
    'miiwan' unless the action is genuinely cross-market.
If MiiWAN data is too sparse to justify either item with real numbers,
still emit ONE ipx_action explicitly stating an observable next step
(e.g. "[Abyss 데이터팀] 24시간 이내 youtube_videos 수집 큐에 MiiWAN
공식 채널 ID 우선순위 1로 등록하고 다음 cron에서 재시도 결과를
데이터팀에 보고한다.") and pointing at the empty source row.
NEVER fall back to "데이터 부족 — 검토 필요" or any vague phrasing.
"""
