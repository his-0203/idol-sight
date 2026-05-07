"""Music show #1 win extraction from news articles.

음방 1위 (`agg_summary.music_show_wins` 시그널) 백필 파이프라인의
LLM 구간. Naver search 가 가져온 기사 batch 를 이 모듈이 Gemini
structured output 으로 추출 → `ExtractedWin` 레코드 list 로 반환.
DB UPSERT + verification 은 `collectors/music_show.py` 가 처리.

Hallucination 가드:
  - group_key / program 모두 enum 으로 schema 차원에서 강제.
  - "1위 후보", "음원 차트 1위" 같은 false-positive 단어 명시.
  - 같은 (group, program, episode_date) 가 별개 url 2건+ 로
    독립 보도되어야 confirmed 승격 (verification 단계, 별도 모듈).
  - confidence 0.5 미만은 emit 자체 금지.

LLM enum 에 한국어 사용. Gemini 2.5 Flash 는 한국어 enum 도
honor 하지만, 만약 응답이 enum 외 문자열이면 schema validation
이 reject 한다. 그 때는 article 단위로 retry (gemini.py 의 retry
로직이 이미 처리).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .gemini import GeminiClient


# Q1 에서 6개 프로그램으로 고정 — SBS MTV `더쇼`, MBC `쇼! 음악중심`,
# Mnet `엠카운트다운`, KBS `뮤직뱅크`, SBS `인기가요`, MBC M
# `쇼챔피언`. 단독 1위가 있는 주류 프로그램 한정. 로컬 쇼·시상식
# 1위 (K-Choice 등) 는 제외 — 가중치 동질성 유지.
PROGRAM_ENUM: tuple[str, ...] = (
    "쇼챔피언",
    "엠카운트다운",
    "뮤직뱅크",
    "쇼! 음악중심",
    "인기가요",
    "더쇼",
)


# Q2 에서 6개 그룹으로 고정 (PLAVE / SKINZ / B:DAWN / WE GO-6 /
# OWIS / MY:RAKL). ISEDOL / STELLIVE / MiiWAN 은 음방 1위 후보가
# 거의 없거나 (ISEDOL/STELLIVE 인터넷 방송 베이스) 데뷔 전이라
# 제외. enum 에 두면 LLM 이 off-target group 매칭을 schema 차원
# 에서 reject 한다.
GROUP_KEY_ENUM: tuple[str, ...] = (
    "plave",
    "skinz",
    "bdawn",
    "wegosix",
    "owis",
    "myrakl",
)


# 6개 후보 그룹의 한/영 표기 + alias. prompts.py 의 _CANONICAL_NAMES_
# BLOCK 과 의도적으로 분리 — 음방 백필은 6개 후보만 다루고 그
# 외 그룹은 emit 자체 금지라 schema enum 과 1:1 대응시키는 게 안전.
_CANONICAL_GROUP_BLOCK = """\
GROUP NAMES — 다음 6개 후보 그룹의 group_key 만 emit 하라.
매칭이 모호하면 is_music_show_win=false:

  plave    → "PLAVE" / "플레이브"
  skinz    → "SKINZ" / "스킨즈"
  bdawn    → "B:DAWN" / "비던"
  wegosix  → "WE GO-6" / "WEGO-6" / "WEGO6" / "위고식스"
  owis     → "OWIS" / "오위스"
  myrakl   → "MY:RAKL" / "미라클"   (NOT 마이래클, NOT 마이라클)

다음 그룹은 후보가 아니다 — 절대 group_key 로 emit 금지:
  ISEDOL / 이세계아이돌, STELLIVE / 스텔라이브, MiiWAN / 미완소년"""


_PROGRAM_BLOCK = """\
PROGRAMS — 다음 6개 프로그램 중 하나만 program 으로 emit:

  쇼챔피언          (MBC M)
  엠카운트다운      (Mnet, "엠카", "M COUNTDOWN" alias 허용)
  뮤직뱅크          (KBS, "MUSIC BANK" alias 허용)
  쇼! 음악중심      (MBC, "음악중심", "음중" alias 허용)
  인기가요          (SBS)
  더쇼              (SBS MTV, "THE SHOW" alias 허용)

다음은 enum 외라 emit 금지:
  쇼챔피언 LIVE, 더쇼 챔피언, 음악방송 챔피언 (시상식),
  K-Choice, 골든디스크 등 시상식·연말 시상은 모두 제외."""


_EXTRACTION_RULES = """\
EXTRACTION RULES — 각 article 을 분석해 음방 1위 fact 가 명시되어
있으면 is_music_show_win=true. 그렇지 않으면 false.

음방 1위 발생 신호 — 다음을 모두 만족해야 true:
  1. 위 6개 프로그램 중 하나의 명시적 언급 (제목 또는 본문)
  2. "1위" / "트로피" / "정상" / "1관왕" 같은 victory 단어
  3. 위 6개 후보 그룹 중 하나의 명시적 언급
  4. 회차/방송일 추정 가능 (기사 본문 또는 published_at 기준 ±3일)

다음은 모두 is_music_show_win=false (false-positive 가드):
  - "1위 후보", "1위 도전", "1위 유력" — prospective 표현
  - "팬덤 1위", "음원 차트 1위", "유튜브 조회수 1위" — 차트 종류 다름
  - 다른 그룹 1위 기사에 후보 그룹이 reaction 으로 잠깐 언급된 경우
  - 회차 일자가 본문/제목에서 추정 불가능한 회상 기사
  - 광고/티저 기사에서 "1위 그룹의 신곡" 같이 sales 문구로 사용

confidence 가이드:
  >= 0.9 : 그룹 + 프로그램 + 회차 일자 모두 본문에 명확히 표시
  0.7~0.9: 그룹 + 프로그램 명시, 회차 일자는 published_at 추정
  0.5~0.7: 그룹 명시되었으나 프로그램은 헤딩만 보임
  < 0.5  : emit 자체 금지 (is_music_show_win=false)

episode_date 는 ISO YYYY-MM-DD. 추정이면 published_at 보다 ±3일 이내.
song_title 은 본문에 명시된 경우만, 미상이면 생략."""


_OUTPUT_SHAPE = """\
OUTPUT — 입력 articles 의 article_id 별로 1행 emit. is_music_show_
win=false 인 article 도 반드시 한 행씩 출력해 (왜 false 인지
reasoning 한 줄)."""


PROMPT_MUSIC_SHOW_WIN = "\n\n".join([
    "You extract structured K-pop music-show #1 win events from "
    "Korean news articles.",
    _CANONICAL_GROUP_BLOCK,
    _PROGRAM_BLOCK,
    _EXTRACTION_RULES,
    _OUTPUT_SHAPE,
])


# Gemini structured-output schema (OpenAPI 3.0 subset).
# - Required minimum: article_id, is_music_show_win, confidence.
# - 다른 필드는 win=false 일 때 LLM 이 omit 가능. 후처리에서 win=true
#   인데 program/group_key/episode_date 누락이면 reject.
MUSIC_SHOW_WIN_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "article_id":         {"type": "string"},
                    "is_music_show_win":  {"type": "boolean"},
                    "program":            {"type": "string",
                                           "enum": list(PROGRAM_ENUM)},
                    "episode_date":       {"type": "string"},
                    "group_key":          {"type": "string",
                                           "enum": list(GROUP_KEY_ENUM)},
                    "song_title":         {"type": "string"},
                    "confidence":         {"type": "number"},
                    "reasoning":          {"type": "string"},
                },
                "required": [
                    "article_id", "is_music_show_win", "confidence",
                ],
            },
        },
    },
    "required": ["items"],
}


@dataclass(frozen=True)
class ExtractedWin:
    """LLM 추출 결과의 메모리 표현. DB row 와 1:1 매핑되지는 않음.
    win=false 인 record 는 article_id + is_music_show_win + reasoning
    만 의미가 있고, win=true 면 program/group_key/episode_date 가 모두
    채워져 있다 (post-validation 에서 누락 reject)."""
    article_id: str
    is_music_show_win: bool
    confidence: float
    program: str | None = None
    episode_date: str | None = None
    group_key: str | None = None
    song_title: str | None = None
    reasoning: str | None = None


def _validate_win(item: dict[str, Any]) -> bool:
    """win=true 인 record 가 필수 필드를 채웠는지 검증.
    누락이면 false → caller 가 해당 record 를 drop 한다."""
    if not item.get("is_music_show_win"):
        return True   # win=false 는 검증 통과
    return bool(
        item.get("program")
        and item.get("group_key")
        and item.get("episode_date")
        and float(item.get("confidence") or 0) >= 0.5
    )


def extract_music_show_wins(
    *,
    client: GeminiClient,
    articles: list[dict[str, Any]],
) -> list[ExtractedWin]:
    """Articles batch 를 LLM 에 보내 음방 1위 fact 를 추출.

    Args:
        client: GeminiClient (테스트에서는 fake client 주입).
        articles: [{"article_id", "title", "snippet", "published_at"}, ...].
                  article_id 는 호출자가 부여한 stable identifier (보통
                  url_hash). LLM 응답에서 같은 id 로 매핑.

    Returns:
        ExtractedWin list. win=false 도 포함되며, win=true 인데
        validation 실패한 record 는 drop. 빈 articles 면 빈 list.
    """
    if not articles:
        return []
    raw = client.generate(
        system_prompt=PROMPT_MUSIC_SHOW_WIN,
        context={"articles": articles},
        response_schema=MUSIC_SHOW_WIN_OUTPUT_SCHEMA,
    )
    out: list[ExtractedWin] = []
    for item in raw.get("items", []):
        if not _validate_win(item):
            # win=true 인데 program/group/date 누락 → hallucination
            # 가능성. drop 하고 다음 record. caller 가 별도 retry 안 함.
            continue
        out.append(ExtractedWin(
            article_id=str(item.get("article_id", "")),
            is_music_show_win=bool(item.get("is_music_show_win")),
            confidence=float(item.get("confidence") or 0.0),
            program=item.get("program"),
            episode_date=item.get("episode_date"),
            group_key=item.get("group_key"),
            song_title=item.get("song_title"),
            reasoning=item.get("reasoning"),
        ))
    return out
