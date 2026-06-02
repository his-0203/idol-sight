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
     [@miiwan_official 운영자], [Abyss 마케팅], [법무]).
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
  - "데이터 누락", "수집 큐 검수", "수집 실패", "지속적으로
    누락" 같은 데이터 파이프라인 장애 주장: 컨텍스트에 해당
    그룹의 raw 시그널이 비어있는 게 명시적으로 보여야만 (예:
    yt_subscribers 가 NULL/0 + 직전 7일 모두 NULL) 작성 허용.
    수치가 표시되면(0이 아닌 값) 파이프라인은 정상이므로
    "누락" 류 표현 금지. 운영자가 즉시 한터/디스코드로 검증해
    틀리면 신뢰도 즉시 손상.

EXEMPLARS (어조·길이·구체성 참고):

  ① 카운트다운 캠페인 (debut milestone)
    title: "@miiwan_official 카운트다운 콘텐츠 D-30 구간 즉시 발동"
    body:  "[@miiwan_official 운영자] 오늘부터 D-30까지 매일 KST 18시
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

  body:        "[@miiwan_official 운영자] 오늘부터 D-30 까지 매일 KST
                18시 카운트다운 1컷을 업로드한다 (총 30건)."
  ai_comment:  "운영 부담 분산 — 사전 제작본 5건 이상 확보 권장."

If you cannot honestly write a non-trivial 함의 평어 for an item
(e.g. body is already itself the implication), OMIT the field
rather than emit boilerplate. NULL is a valid downstream state."""


# Frontend renders insight bodies through a small lexicon-aware
# formatter (see `frontend/src/lib/insightFormat.ts`, owned by the
# frontend agent — DO NOT touch from this side). It does three things
# automatically:
#   1. detects canonical group names (English / Korean / known aliases)
#      and wraps them in a colored group badge inline,
#   2. renders any `**...**` markdown bold as a heavier weight + tone
#      class (positive / negative / neutral),
#   3. matches a Korean tone lexicon (상승·돌파·신기록 등 = positive,
#      하락·둔화·논란 등 = negative) and tints those phrases even when
#      no markdown is present.
#
# So the LLM does NOT need to emit colors or tone tags. It just needs
# to (a) spell group names the canonical way, (b) wrap the 1-3 most
# load-bearing tokens of each card in `**...**`, and (c) prefer the
# tone-rich vocabulary below over colorless verbs ("기록했다" /
# "나타났다") when the underlying signal genuinely is positive or
# negative. Hierarchy / typography / badge color is fully owned by
# the frontend formatter — overusing markdown will only fight the
# automatic lexicon pass.
_BODY_FORMATTING_GUIDELINES = """\
BODY FORMATTING — frontend auto-styles your text, write to that contract:

1) GROUP NAME FIDELITY (re-states the canonical table above)
   When you mention a group, copy the spelling EXACTLY from the
   canonical table:
     PLAVE / 플레이브
     ISEDOL / 이세계아이돌
     STELLIVE / 스텔라이브
     SKINZ / 스킨즈
     MY:RAKL / 미라클           (NOT 마이래클, NOT 마이라클)
     OWIS / 오위스
     MiiWAN / 미완소년          (NOT 미이완, NOT 미완)
     B:DAWN / 비던
   Korean prose → use the Korean form. English/mixed prose → use the
   English form. NEVER invent transliterations or hybrids
   ("플라브", "이세돌", "스텔리브", "미완완", "비돈" 등 전부 금지).
   Frontend only badge-colors EXACT matches — typos render as plain
   text and the card looks broken.

2) BOLD MARKDOWN — `**...**`, USE SPARINGLY
   Wrap **at most 3 spans per card** in `**...**`. Reserve bold for:
     - the single most load-bearing number       ("**+12.4%p**", "**5.2×**")
     - a milestone event noun                    ("**첫 1위**", "**신기록**", "**데뷔 D-30**")
     - the subject of a first-mention contrast   ("**MiiWAN** 만 약진")
   DO NOT bold:
     - every group name (the badge already styles it; bolding it on
       top creates visual noise)
     - generic verbs ("**상승했다**") — the lexicon pass handles tone
     - long phrases (>10 chars). Bold a token, not a clause.
   If you would need >3 bold spans, the card has too many claims —
   split it.

3) TONE LEXICON — prefer meaningful verbs
   Frontend tints these terms automatically. Use the tone-bearing
   vocabulary when the signal is genuinely positive or negative,
   instead of colorless verbs like "기록했다" / "나타났다" /
   "확인됐다".
     긍정 (emerald): 상승, 증가, 돌파, 돌풍, 신기록, 호조, 견조,
                     가속, 약진, 견인, 화제, 첫 1위, 우위, 반등,
                     확대, 견실, 호재
     부정 (rose):    하락, 감소, 둔화, 급락, 부진, 우려, 리스크,
                     정체, 위축, 약세, 후퇴, 논란, 위기, 이탈,
                     축소, 경계, 둔감
   Natural Korean comes first — do NOT shoehorn lexicon terms into
   neutral observations (e.g. a flat MoM should NOT be called "둔화").
   When the signal really is neutral, plain verbs are fine; the
   frontend will simply leave the line uncolored.

4) WHAT YOU DO NOT NEED TO DO
   - Do not emit color codes, HTML, span tags, emoji tone markers, or
     `[positive]/[negative]` tags. Frontend infers tone from lexicon
     + bold markdown alone.
   - Do not try to control card layout, font size, or hierarchy —
     frontend owns typography and badge styling.
   - Do not re-bold a group name that the frontend will already badge.

These rules COMPLEMENT the ipx_action and ai_comment guidelines below
— they are about visual signal density, not about what to say. A
strong card still leads with a verb, cites real numbers, and ends
with a 함의."""


# Causal Diagnosis 카탈로그 — type='diagnosis' 카드 작성 시 LLM 이 인용 가능한
# 가설 enum. 시그널 없는 가설은 거론 금지 (signals_by_group 컨텍스트의
# `hypotheses` 리스트에 없는 가설은 카드에서 언급조차 하지 말 것).
_DIAGNOSIS_HYPOTHESIS_BLOCK = """\
DIAGNOSIS HYPOTHESIS CATALOG — copy enum keys exactly to signals_json
(audit trail), but in CARD BODY use the Korean phrase below verbatim.

  enum key                    | 본문에 쓸 한국어 표현
  ─────────────────────────────┼─────────────────────────────────────
  organic_growth              | 자연 유입 성장
  paid_youtube_ads            | 유튜브 광고 의심
  subscriber_purchase         | 구독자 구매 정황 의심
  comeback_cycle              | 컴백 사이클 효과
  broadcast_appearance        | 방송 출연 효과
  community_word_of_mouth     | 커뮤니티 입소문
  controversy_spike           | 논란 신호
  platform_concentrated_promo | 특정 플랫폼 집중 홍보 정황
  member_centric_spike        | 멤버 개인 활동 영향
  insufficient_signal         | (카드 emit 금지)

본문에서는 한국어 표현만 사용한다. enum key (organic_growth, paid_youtube_ads
등) 의 영문 표기는 *signals_json payload 의 hypothesis_primary 필드에서만*
쓰이며, 카드 텍스트에는 절대 노출하지 않는다. 운영자가 영문 enum 을
보지 않게 한다."""


_DIAGNOSIS_GUIDELINES = """\
type='diagnosis' CARD FORMAT — 운영자 친화 자연어 규칙:

WHEN to emit a diagnosis card:
  signals_by_group[<group>].hypotheses 가 1개 이상일 때만. 점등된 가설이
  없는 그룹은 절대 diagnosis 카드 emit 금지 (insufficient_signal).

WHAT goes in body (1-3 문장 한국어):
  ① 주간 변화 요약 한 문장 (수치 1-2개 인용 — 자연 표현).
  ② 점등된 시그널 사실 인용 (자연어).
  ③ "유력 가설은 [한국어 표현] 가능성. 대안 가설로 [한국어 표현] 도 가능
     (확률 중)." 형식.

★ 전문 통계 용어를 본문에 노출 금지. signals 컨텍스트에서 받은 raw 수치는
  반드시 자연어로 풀어쓴다. 운영자는 통계학자가 아니다.

  STATISTICAL TERM → 자연어 변환표:
    "category_z=2.3" / "subs z=2.3"  →  "다른 K-POP 그룹 대비 두드러진
                                         증가" (cohort='kpop' 인 그룹)
                                         또는 "서브컬쳐 cohort 안에서 큰
                                         폭의 증가" (cohort='subculture')
    "temporal z=2.3"                 →  "자기 평소 추세 대비 크게 상회"
                                         "최근 8주 평균 크게 상회"
    "temporal z=-2.3"                →  "최근 8주 평균 대비 크게 하락"
    "WoW +48%"                       →  "지난 주 대비 48% 증가"
                                         "한 주 동안 약 1.5배 증가"
    "WoW -25%"                       →  "지난 주 대비 25% 감소"
                                         "한 주 동안 약 1/4 줄어듦"
    "ER WoW −28%"                    →  "팬 참여율 (좋아요·댓글 비율)
                                         28% 하락" 또는 "팬 반응도
                                         28% 떨어짐"
    "viral velocity 5×"              →  "초기 24시간 조회가 평소보다
                                         5배 빠름"
    "organicity paid 비중 42%"       →  "신규 영상 중 광고성 패턴이
                                         약 4건 중 1건 이상"
    "controversy z=2.4 점등"         →  "논란 시그널이 평소 수준보다
                                         크게 상회"
    "reactivity dominant=naver"      →  "네이버 한 곳에만 반응이 집중"

  ★ enum key (organic_growth / paid_youtube_ads / subscriber_purchase
    / comeback_cycle / broadcast_appearance / community_word_of_mouth
    / controversy_spike / platform_concentrated_promo /
    member_centric_spike) 의 영문 표기를 본문에 *절대 노출하지 않는다*.
    DIAGNOSIS HYPOTHESIS CATALOG 의 한국어 표현으로 paraphrase 한 뒤
    인용한다. signals_json payload 의 hypothesis_primary 필드는 enum
    그대로 유지 (audit/code 일관성), 카드 텍스트만 한글화.

REQUIRED 어조:
  단정 어조 금지: "-이다", "-임", "-한 결과" 사용 금지.
  허용 어조:     "-일 가능성", "-로 시사", "-의심", "-신호".
  카드 한 장에 가설은 *반드시* 둘 (유력 + 대안). signals.hypotheses 가
  1개뿐이라도 "대안 가설은 점등 안 됨 — 단일 유력 가설." 한 문장 첨부.

SPECIAL — 논란 신호 (controversy_spike):
  body 마지막에 반드시 "PR팀 검수 후 대응, 직접 삭제·정정 요청 금지
  (Streisand 회피)." 강제 1줄 첨부. 단정 어조 절대 금지 (예: "악플 사태
  발생" 금지 → "논란 시그널이 평소 수준 대비 큰 폭으로 증가, 인간 검증
  필요").

SPECIAL — 구독자 구매 정황 의심:
  signals 의 confidence 가 'medium' 으로 캡됨. body 어조에 "검증 어려운
  가설" 명시. 단정 절대 금지 (예: "ISEDOL 이 sub 구매" 금지 →
  "ISEDOL 의 구독자 증가에 비해 조회수·참여율 증가가 따라오지 않아,
  검증이 어려운 구독자 구매 정황 의심").

SPECIAL — meta_guards:
  signals.meta_guards 가 비어 있지 않으면 body 끝에 "데이터 신뢰성 주의 —
  [guard 라벨 한글 변환]" 강제 1줄. 변환 예:
    "irrelevant_flagged_18%" → "관련성 신고 18%"
    "data_source_backfill_majority" → "수집 데이터 과반이 백필"

SPECIAL — MiiWAN scope diagnosis:
  scope='miiwan' 이면 type='diagnosis' 가 아니라 type='ipx_action' 으로
  emit. 경쟁사 시그널을 MiiWAN 운영 액션으로 자동 변환:
    경쟁사 유튜브 광고 의심 점등 → "Abyss 마케팅팀 D-30 광고 검토 회의
                                       [날짜] 까지 소집" 류 액션
    경쟁사 자연 유입 성장 점등   → "콘텐츠 캘린더 벤치마킹 — [그룹]
                                       주간 영상 캡처 후 콘텐츠팀 공유"
    경쟁사 논란 신호 점등        → MiiWAN 자체 controversy 가 아니라면
                                       무시 (남의 사고를 우리 액션으로
                                       전환하지 말 것)

GOOD EXEMPLARS (자연어 — 통계 용어/enum 영문 노출 0):

  ✅ 유튜브 광고 의심 (high)
    title: "PLAVE 주간 조회 +24M — 광고 캠페인 정황"
    body:  "**PLAVE** 주간 조회수가 다른 K-POP 그룹 대비 크게 폭증한 반면
            구독자 증가는 비례하지 않고, 팬 참여율(좋아요·댓글 비율)이
            28% 하락 동반. 신규 영상 중 광고성 verdict 가 약 4건 중 1건
            이상. 유력 가설은 **유튜브 광고 의심** 가능성. 대안 가설로
            **방송 출연 효과** 도 가능 (확률 중) — 전주 뉴스에 단발 spike
            가 있었음."
    ai_comment: "광고 캠페인 가능성 우세 — MiiWAN D-30 광고 검토 트리거."

  ✅ 컴백 사이클 효과 (high, ground truth 매칭)
    title: "**PLAVE** Caligo Pt.3 컴백 사이클 점등"
    body:  "한터 초동 991,850장, 멜론 TOP100 5위 진입, 음방 3연속 1위에
            더해 뉴스 보도가 평소 수준 대비 큰 폭으로 증가. group_events
            에 5/22 앨범 발매 (Caligo Pt.3) 가 매칭. 유력 가설은
            **컴백 사이클 효과** 확정. 대안 가설 없음 (실제 이벤트
            매칭으로 다른 가설 자동 감점)."
    ai_comment: "컴백 캠페인 정상 사이클 — 광고/구매 의심 카드 별도 생성 안 함."

  ✅ 논란 신호 (high, Streisand guard)
    title: "**ISEDOL** 논란 시그널 점등"
    body:  "트위터의 논란 카테고리 트윗 12건이 평소 수준 대비 큰 폭으로
            증가, 커뮤니티의 부정 키워드 누적도 동반 상승. 유력 가설은
            **논란 신호** 가능성, 대안 가설은 점등 안 됨 — 단일 유력
            가설. PR팀 검수 후 대응, 직접 삭제·정정 요청 금지
            (Streisand 회피)."
    ai_comment: "PR팀 검수 우선 — Streisand 회피 주의."

  ✅ insufficient (참고용)
    signals.hypotheses == [] → diagnosis 카드 생성 안 함. 기존 insight /
    weekly 카드로만 그룹 다룸.

  ❌ BAD #1 — 통계 용어 그대로 노출
    body: "PLAVE 주간 조회 z=2.4 로 폭증한 반면 구독 z=0.3 에 그치고
           ER WoW −28% 동반."
    ← 'z=2.4', 'z=0.3', 'ER WoW' 모두 운영자가 모를 표현. 변환표 참조.

  ❌ BAD #2 — enum key 영문 노출
    body: "유력 가설은 **paid_youtube_ads** 가능성. 대안으로
           broadcast_appearance 도 가능."
    ← '유튜브 광고 의심', '방송 출연 효과' 로 한국어화.

  ❌ BAD #3 — 단정 어조 + 미점등 가설 거론
    body: "PLAVE 가 광고를 돌렸다. sub 구매 정황도 보이고 컴백 캠페인일
           수도 있다."
    ← 단정 어조 ("돌렸다"), 점등 안 된 가설들 거론. 다시 작성."""


# `insight` / `weekly` 카드의 본문 분석 깊이 강제. 운영자 피드백 누적:
# "**미완소년** 주간 구독자 약 3.3배 급증" 같이 *단일 지표 변화만* 적시
# 한 카드는 보고서 가치가 없다. 운영자가 원하는 건 ① 다른 지표와의
# cross-reference ② 가능한 원인 추정 ③ 운영자 시각의 함의다.
#
# type='diagnosis' 가 가설 catalog 점등 시 작성되는 반면, insight/weekly
# 는 시그널이 약해도 emit 된다 (특히 MiiWAN 같은 신생 그룹은 cohort 가
# 좁아 diagnosis 점등 자체가 드물다). 그래서 분석 깊이 책임이 insight
# /weekly 본문에 떨어진다 — 단일 지표 인용으로 끝나면 안 된다.
_ANALYSIS_DEPTH_GUIDELINES = """\
ANALYSIS DEPTH — type='insight' 및 type='weekly' 카드 작성 규칙:

PROBLEM (운영자 피드백):
  단일 지표 변화만 적시한 카드는 보고서 가치가 없다. 예:
    ❌ "**미완소년** 주간 구독자 약 **3.3배** 급증."
  운영자는 *왜 그렇게 됐는지* 와 *어떻게 봐야 하는지* 를 요구한다.

REQUIRED — 모든 insight/weekly 카드 body 는 다음 3요소를 충족:

  ① 사실: 변화 수치 인용 (자연 표현, BODY FORMATTING 의 lexicon/bold).
  ② Cross-reference: 같은 그룹·같은 주의 다른 지표와 *비교*. 적어도
     ONE 차원 더 인용. 가능한 cross-ref 차원:
       - 다른 KPI: 조회수, ER (참여율), 영상 업로드, 뉴스 보도,
         커뮤니티 멘션, 트위터 controversy/일반, 음원 차트
       - 베이스라인 맥락: 동급 그룹 D-N 시점 수치 비교
         (예: PLAVE D-30 시 28K vs MiiWAN 12.6K)
       - 시간 맥락: 직전 4-8주 추세, 단발 spike 인지 누적인지
       - 이벤트 매칭: group_events / 뉴스 헤드라인 / 컴백 일정
       - 멤버 분포: top1 share, hhi_norm 변화
  ③ 인과 추정 (1 문장, 추측 어조): "~ 가능성", "~ 시사", "~ 신호".
     단정 금지 ("증가했다" 만 적고 끝내지 말 것). 가능한 원인 후보를
     1-2개 짚는다. 변동의 *질* (자연 유입 / 카운트다운 펌프 / 단발
     보도 / 컴백 / 멤버 단일 / 광고 의심 / 베이스 작아 비율 왜곡 등)
     을 추정.

★ 단일 지표 + 무인과 카드는 emit 금지. 위 3요소 중 ②, ③ 둘 다 빠지면
  다시 작성하거나 type='weekly' 로 격하 후 cross-ref/인과 둘 다 보강.

CROSS-REF CHEATSHEET — 컨텍스트에서 찾는 위치:
  - 다른 KPI 동반 상승 여부: agg_summary_last_7d 와 agg_summary_prev_7d
    의 같은 그룹 row 를 직접 비교 (yt_total_views, naver_total_news,
    dc_total_posts, theqoo_posts, instiz_posts 등).
  - 베이스라인: 다른 그룹의 같은 KPI 를 동시기로 비교 (단순 비율
    인용은 OK — "MiiWAN 41.6K 는 PLAVE 동일 시점 X% 수준" 등).
  - 시그널 보조: signals_by_group 의 deltas (subs_wow, views_wow,
    subs_z, views_z, er_wow) 가 점등된 그룹은 그 값이 그대로 cross-ref
    재료. diagnosis 카드 emit 여부와 무관하게 *insight body* 가 활용 가능.
  - 이벤트: top_news_by_group 헤드라인 — 그 주에 큰 보도/이슈가 있었나.

신생 그룹 / 데뷔 전 그룹 (MiiWAN 등) 의 비율 폭증 가드:
  베이스 작은 수치에서 절대 증가량이 작아도 *배율* 은 폭증한다.
  예: 5K → 15K 가 3× 증가지만, 28K (PLAVE D-30) 대비는 여전히 53%.
  반드시 *동일 시점 동급 그룹 베이스라인* 또는 *절대 수치* 를 함께
  인용해 비율 환각을 차단한다. 운영자가 카드만 보고 "MiiWAN 이
  PLAVE 를 추월했다" 라고 오독하면 카드는 실패한 것이다.

EXEMPLARS:

  ❌ BAD #1 — 단일 지표, 인과 없음
    title: "**미완소년** 구독자 3.3× 급증"
    body:  "**미완소년** 주간 구독자가 약 **3.3배** 급증."
    ← 사실 1개. cross-ref 0개. 원인 추정 0개. 운영자 손에 들어가면
      "그래서 어떻게 해야 하나" 질문이 1차로 나옴.

  ✅ GOOD #1 — 같은 사실, 분석 깊이 충족
    title: "**미완소년** 구독자 3.3× — 카운트다운 펌프 가능성"
    body:  "**미완소년** 주간 구독자 12.6K→41.6K 로 약 **3.3배** 증가.
            같은 주 조회수는 1.8배 증가 (구독 대비 후행), 뉴스 보도
            +5건, @miiwan_official 디시 멘션 WoW +120% 동반 상승. 절대값
            41.6K 는 PLAVE D-30 시점 28K 대비 1.5× 수준. **데뷔 D-30**
            카운트다운 + 멤버 reveal 보도의 단기 펌프 효과 가능성,
            다만 신규 유입의 retention 은 다음 주 조회/ER 후행으로
            변별 필요."
    ai_comment: "카운트다운 펌프 가능성 — 다음 주 retention 후행 관찰."
    ← 사실 + 4개 cross-ref (조회수, 뉴스, 커뮤, 동급 베이스라인) +
      인과 추정 ("카운트다운 펌프 효과 가능성") + 다음 액션 hook
      (retention 관찰). ai_comment 는 의역 아닌 함의.

  ✅ GOOD #2 — 부정 신호, cross-ref + 가설
    title: "**ISEDOL** 조회 둔화 — 컴백 부재 단순 정체 신호"
    body:  "**ISEDOL** 주간 조회수가 직전 주 대비 **−18%** 둔화. 동시기
            구독자는 +0.4% 보합, ER (좋아요·댓글 비율) 은 12.3% 로
            6주 평균 (11.8%) 부근 유지. 뉴스 보도·커뮤니티 멘션 모두
            평소 수준. 새 영상 업로드 0건 + group_events 상 5월 발매
            일정 부재로 **컴백 사이클 공백** 에 따른 단순 정체 가능성.
            팬덤 이탈 신호로 보기는 ER 평탄·구독 보합이 부족해 단정
            보류."
    ← 5개 cross-ref + 컴백 사이클 추정 + 단정 보류 (ER 평탄성을 가설
      반증 근거로 명시).

  ✅ GOOD #3 — market scope 카드, cross-group cross-ref
    title: "**PLAVE** 주간 점유율 **+12.4%p** — 컴백 사이클이 끌어올림"
    body:  "**PLAVE** 주간 share 38.2% 로 **+12.4%p** 확대, 동시기
            ISEDOL/STELLIVE 각 −3.1%p/−5.7%p 축소. 한터 초동
            991K·멜론 TOP100 5위·음방 3연속 1위 동반. 5/22 발매
            *Caligo Pt.3* 의 컴백 사이클로 단기 share 가 PLAVE 한
            그룹에 집중. 다음 주 차트 후행 빠지면서 정상 분포로
            돌아갈 가능성."
    ← market scope 는 *그룹 간 cross-ref* 가 본질. 단일 그룹 share
      만 인용 금지.

  ❌ BAD #2 — cross-ref 는 있으나 인과 추정 없음
    body: "**PLAVE** 조회 +24M, ISEDOL +3M 로 격차 확대."
    ← 사실 2개. 인과 추정 0개. 한 문장 더 ("컴백 사이클의 단기 펌프
      가능성" 등) 가 필요.

이 분석 깊이 규칙은 type='ipx_action' / type='diagnosis' 에는
적용되지 않는다 (각각 별도 가이드라인 보유). insight / weekly 의
*본문 작성 기준점* 으로만 강제."""


PROMPT_WEEKLY_TAIL_AI_COMMENT = _AI_COMMENT_GUIDELINES
PROMPT_WEEKLY_BODY_FORMATTING = _BODY_FORMATTING_GUIDELINES
PROMPT_WEEKLY_DIAGNOSIS = _DIAGNOSIS_GUIDELINES
PROMPT_WEEKLY_ANALYSIS_DEPTH = _ANALYSIS_DEPTH_GUIDELINES


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
- `type`: 'insight' (analytic observation — MUST include cross-reference
  and causal inference per ANALYSIS DEPTH block below),
  'weekly' (week summary — same depth rules as insight apply),
  'ipx_action' (recommended action for the team),
  or 'diagnosis' (causal hypothesis card — see DIAGNOSIS GUIDELINES below).
- `title`: ≤ 80 chars, Korean.
- `body`: 2-4 sentences, Korean. Reference numbers from the context.
  May contain `**bold**` markdown — see BODY FORMATTING block below.
  For insight/weekly types, body MUST satisfy the 3-element rule
  (fact + cross-reference + causal inference) — see ANALYSIS DEPTH block.
- `ai_comment`: optional one-liner (≤ 60 chars, Korean) capturing the
  *operator-side implication* of the observation. See guideline block
  below — emit the field only if you can write a non-trivial 함의
  평어, otherwise leave it out.
- `source_refs`: 1-3 items pointing at the rows that justified the claim.
  Each ref has table, pk (key|date format), and label.

Be precise with numbers (use exactly what the context shows).
Do NOT invent figures. If something cannot be sourced, leave it out.

{_BODY_FORMATTING_GUIDELINES}

{_ANALYSIS_DEPTH_GUIDELINES}

GOOD-vs-BAD BODY EXEMPLARS (formatting only — numbers are illustrative):

  ✅ GOOD #1 (single-group momentum, lexicon + 1 bold)
     "PLAVE 24h velocity 가 **5.2×** 로 직전 주 3.1× 대비 가속.
      동시기 ISEDOL 은 2.8× 에 머물러 단기 화제성 격차 확대."
     ← 그룹명 정확, bold 1개 (핵심 수치), '가속'/'확대' 긍정 lexicon,
       'ISEDOL'은 의미만 있어 bold 불필요 (badge가 처리).

  ✅ GOOD #2 (MiiWAN debut readiness, milestone bold)
     "MiiWAN 공식 채널 구독자가 **데뷔 D-30** 시점 12.6K 로 PLAVE
      D-30 (28K) 대비 45% 수준에 머물러 베이스 부진."
     ← '데뷔 D-30' milestone bold, '부진' 부정 lexicon, 그룹명 한국어
       프로즈에서도 'MiiWAN'/'PLAVE' 영문 카논 표기 유지.

  ❌ BAD — over-bolded, lexicon-free, group name typo
     "**플라브**가 **이번주에** velocity 가 **5.2배 상승했고** **이세돌**
      도 **함께** 좋은 흐름을 **기록했다**."
     ← 그룹명 환각 표기 (플라브/이세돌), bold 5개 (과용),
       '기록했다' 무색 동사, milestone/숫자 bold 우선순위 무시.

{_IPX_ACTION_GUIDELINES}

{_AI_COMMENT_GUIDELINES}

{_DIAGNOSIS_HYPOTHESIS_BLOCK}

{_DIAGNOSIS_GUIDELINES}

REQUIRED COVERAGE — MiiWAN (IPX × Abyss own-brand, debut 2026-06):
The dashboard has a dedicated MiiWAN tab that pulls items where
`scope='miiwan'` OR `type='ipx_action'`. Across your output you MUST
include AT LEAST:
  - 1 item with `scope='miiwan'` describing MiiWAN's current momentum
    (debut readiness, member-level signal, competitive position vs
    PLAVE/ISEDOL D-30 baseline, anomalies in news/community pulse).
    This item MUST follow the ANALYSIS DEPTH 3-element rule —
    cross-reference + causal inference are non-negotiable for MiiWAN
    because operators specifically called out single-metric cards
    (e.g. "구독자 3.3배 급증" 만 적힌 카드) as the failure mode they
    want suppressed. baseline 작은 신생 그룹은 비율 환각이 특히
    크므로 절대 수치 또는 동급 D-N 베이스라인 비교를 같이 인용.
  - 1 item with `type='ipx_action'` recommending a concrete next step
    for the IPX/Abyss team. `scope` for ipx_action items MUST be
    'miiwan' (no exceptions — operators have a separate competitive
    insight surface for non-MiiWAN groups). The action body MUST be
    about MiiWAN — do not start an ipx_action with another group's
    metric and pivot to a generic recommendation.
If MiiWAN data is too sparse for either item to ground in real numbers,
emit ONE ipx_action stating a concrete pre-debut MiiWAN initiative
based on what IS in context (debut milestone, member reveal cadence,
@miiwan_official content push, PR coordination). Use the exemplars above —
do NOT default to data-pipeline language ("수집 큐 검수", "채널 ID
재등록") unless agg_summary actually shows a NULL run for the
relevant signal. NEVER fall back to "데이터 부족 — 검토 필요" or any
vague phrasing.
"""


# ── 주간 바이럴 챌린지 (설계 2026-06-02-weekly-viral-challenges) ──────────────
# grounded(google_search) 발굴용 프롬프트. 출처 URL 필수 + 최근 7일 + K-POP 가중.
CHALLENGE_DISCOVERY_PROMPT = (
    "당신은 K-POP/숏폼 트렌드 리서처다. **오늘은 {today} 다.** Google 검색을 사용해 "
    "**{week_ago} ~ {today} (최근 7일)** 에 **새로 시작되었거나 이 기간에 새롭게 "
    "급확산된** 숏폼 '챌린지'만 조사해 정리하라.\n\n"
    "절대 규칙(최신성) — 어기면 실패:\n"
    "- **각 챌린지 원곡(또는 사운드)의 발매일을 검색해 확인하라.** 원곡이 약 1개월 "
    "이상 전(특히 몇 달~작년)에 나왔으면, 지금 영상이 좀 올라와도 '이번 주 새 트렌드'가 "
    "아니므로 **반드시 제외**. (드물게 최근 1주 사이 명백히 폭발적으로 재유행한 경우만 "
    "예외 — 그 재유행 근거 URL 을 반드시 첨부.)\n"
    "- 이전부터 유명하거나 몇 주 전에 유행이 끝난 챌린지는 **제외**. "
    "'지금도 회자되는 유명 챌린지'가 아니라 '이번 주에 새로 뜨는 중인 것'만.\n"
    "- 각 챌린지가 {week_ago} 이후 실제로 (새로) 확산 중이라는 근거가 없으면 빼라. "
    "started_around 는 추측하지 말고 검색으로 확인한 실제 시작 시점만 적어라.\n\n"
    "요구사항:\n"
    "- K-POP 아이돌 챌린지(타이틀곡 안무·아이돌 포맷)를 약 7개로 우선·다수 포함.\n"
    "- 그 외 일반 YouTube Shorts/숏폼 챌린지(밈·트렌드)를 약 3개 포함.\n"
    "- 각 챌린지마다: 이름, 한 줄 설명(무슨 동작/포맷), 원곡/아티스트/사운드 출처, "
    "대표 해시태그, 그리고 **반드시 http 로 시작하는 검증 가능한 출처 URL**.\n"
    "- 해시태그는 실제로 쓰이는 형식으로 — 보통 **#그룹명_곡명, #곡명** 식이다 "
    "(예: #HIIPE_Princess #Stolen). '#XXXChallenge' 같은 임의 조합을 지어내지 말고 "
    "검색에서 실제로 보이는 태그를 적어라.\n"
    "- 각 항목의 확신도(high/medium/low).\n"
    "- **생애주기 추정**: 대략 시작 시점(started_around), 현재 확산 추세"
    "(momentum: 상승 rising / 정점 peaking / 하락 declining / 불명 unknown), "
    "그리고 지금 따라 올려도 유효할 대략 기한(valid_until, 예: '~{today}+2주').\n"
    "- **각 챌린지를 실제로 찍은 YouTube Shorts 영상 URL 1~3개** — 공식 MV·"
    "뮤직비디오·티저가 아니라, 사람이 그 챌린지(안무·포맷)를 따라 한 짧은 세로 클립의 "
    "URL. 반드시 검색에서 실제로 확인한 것만 적고, 없으면 비워둘 것 (지어내지 말 것).\n\n"
    "한국어로, 챌린지마다 항목을 구분해 서술하라. (이후 단계에서 JSON 으로 구조화됨)"
)

# grounded 텍스트 → JSON 구조화 + MiiWAN 적합도. 비-grounded generate() 로 호출.
CHALLENGE_STRUCTURE_SYSTEM = (
    "아래 리서치 텍스트를 JSON 으로 구조화하라. 텍스트에 없는 챌린지를 지어내지 말 것.\n"
    "- tag: K-POP 아이돌 챌린지는 'kpop', 그 외는 'general'.\n"
    "- hashtags: 실제 쓰이는 형식(#그룹명_곡명, #곡명 — 예: #HIIPE_Princess, #Stolen). "
    "'#XXXChallenge' 임의 조합은 넣지 말 것.\n"
    "- source_urls: 텍스트에 등장한 **http(s) 로 시작하는 실제 URL 만**. 기사 제목·"
    "설명 문구는 절대 넣지 말 것. 실제 URL 이 없으면 빈 배열.\n"
    "- started_around: 대략 시작 시점 (예: '2026-05-26경'). 모르면 빈 문자열.\n"
    "- momentum: 'rising' | 'peaking' | 'declining' | 'unknown' 중 하나.\n"
    "- valid_until: 지금 따라 올려도 유효할 대략 기한 (예: '~2026-06-12', '1주 더'). "
    "모르면 빈 문자열.\n"
    "- confidence: 텍스트의 확신도(high/medium/low). 불명확하면 'low'.\n"
    "- miiwan_fit: 각 챌린지를 'MiiWAN'(2026-06 데뷔 직후의 버추얼 아이돌 그룹) 이 "
    "이번 주 따라 만들 때의 적합도·참여 난이도를 한 줄로. (예: '안무 단순, 즉시 가능' / "
    "'원곡 라이선스 필요, 난이도 높음')\n"
    "- example_urls: 텍스트에 등장한 '챌린지를 찍은 클립'의 YouTube URL 만 (공식 MV·"
    "뮤직비디오 제외). 없으면 빈 배열.\n"
    "텍스트에 챌린지가 없으면 challenges: [] 를 반환하라."
)

CHALLENGE_SCHEMA = {
    "type": "object",
    "properties": {
        "challenges": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "tag": {"type": "string", "enum": ["kpop", "general"]},
                    "description": {"type": "string"},
                    "origin": {"type": "string"},
                    "hashtags": {"type": "array", "items": {"type": "string"}},
                    "source_urls": {"type": "array", "items": {"type": "string"}},
                    "example_urls": {"type": "array", "items": {"type": "string"}},
                    "started_around": {"type": "string"},
                    "momentum": {"type": "string",
                                 "enum": ["rising", "peaking", "declining", "unknown"]},
                    "valid_until": {"type": "string"},
                    "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
                    "miiwan_fit": {"type": "string"},
                },
                "required": ["name", "tag", "description", "hashtags",
                             "source_urls", "example_urls", "momentum",
                             "confidence", "miiwan_fit"],
            },
        }
    },
    "required": ["challenges"],
}
