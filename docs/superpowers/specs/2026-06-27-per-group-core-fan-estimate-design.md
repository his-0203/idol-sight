# 전 그룹 추정 코어팬 (MarketOverview 참고용) 설계서

> **기준일**: 2026-06-27 · **성격**: P2a 확장 — MiiWAN 전용이던 추정 코어팬(좋아요/댓글 기반)을 **전 그룹**으로 확대해 MarketOverview에 **참고용**(정렬/순위 아님)으로 표기. 신규 수집 0(기존 youtube_video_stats 재가공). 점수 산식 불변.

## 0. 배경

P2a의 찐팬 활동량은 라이브 채팅 수집이 MiiWAN만이라 MiiWAN 단독이었다. 그러나 **추정 부분(좋아요/댓글 median per video)**은 모든 그룹의 `youtube_video_stats`에 데이터가 있어 0비용으로 전 그룹 계산 가능. 사용자 요청: 전 그룹 추정 코어팬을 MarketOverview에 **참고용**으로 추가(그룹간 비교/정렬 지표가 아니라 카드 참고 표기). MiiWAN의 라이브 **측정** 코어와는 다른 축(추정).

## 1. 목표 / 비목표

**목표**: 전 그룹의 추정 코어팬(관여 팬=좋아요, 적극 코어=댓글)을 산출·저장하고 MarketOverview 카드에 참고 표기.

**비목표**: 정렬/순위 키로 사용(참고용만 — 기존 "활동량은 그룹간 비교 제외" 결정 존중). 라이브 채팅 측정(MiiWAN 전용, P2a). 점수/산식 변경. 신규 수집.

## 2. 산식 (P2a estimate_video_engagement 재사용)

각 active 그룹의 **최근 56일 발행 영상**(56일 내 < 3편이면 최신 12편 폴백 — live_activity의 `MIN_WINDOW_VIDEOS`/`VIDEO_FALLBACK_LIMIT` 상수 재사용) 최신 스냅샷에서:
- `est_engaged_fans = median(likes per video)` — 좋아요는 영상당 1인1회 → 고유 반응 팬 근사("추정 관여 팬").
- `est_active_core = median(comments per video)` — 댓글은 1인 다회 가능 → 적극 참여 상한("추정 적극 코어").
- `like_rate = median(likes/views)`, `comment_rate = median(comments/views)` (views=0 제외).
→ `from idol_sight.analysis.live_activity import estimate_video_engagement` 그대로 재사용(videos, subscribers). subscribers는 view_through용(선택, 본 범위선 미표시 가능).
- 영상 없음 → `basis='insufficient'`(추정값 None). 있음 → `'scored'`.

## 3. 저장 스키마 (migration 0101)

**`agg_core_fan_estimate`** — 그룹·스냅샷별 1행, `(group_key, snapshot_at)` PK:
`group_key TEXT NOT NULL, snapshot_at TEXT NOT NULL, est_engaged_fans INTEGER, est_active_core INTEGER, like_rate REAL, comment_rate REAL, video_count INTEGER, basis TEXT NOT NULL, generated_at TEXT NOT NULL, PRIMARY KEY (group_key, snapshot_at)` + `idx_cfe_snapshot (snapshot_at)`. (정수 median은 round 정수화.)

## 4. 산정 모듈 & 파이프라인

`worker/src/idol_sight/analysis/core_fan_estimate.py`:
- `compute_core_fan_estimate(groups_videos) -> list[dict]` (순수, 테스트 용이) — 그룹별 videos 리스트 받아 estimate_video_engagement로 추정 dict 산출 + basis.
- `build_core_fan_estimate(client, *, snapshot_at) -> CollectionResult` — active 그룹(`SELECT key FROM groups WHERE is_active=1`) 각각 최근 영상 조회(live_activity의 `_VIDEOS_WINDOW_SQL`/`_VIDEOS_FALLBACK_SQL` 패턴 재사용 또는 복제) → estimate → 스냅샷별 멱등 쓰기(DELETE WHERE snapshot_at=? + INSERT). loyalty/awareness 패턴 미러.

`cli.py _run_aggregate`: `build_awareness` **직후**에 `build_core_fan_estimate(client, snapshot_at=snap)` 추가 — 동일 graceful try/except(`except typer.Exit: raise`로 부분쓰기 하드실패 보존, 그 외 흡수). 신규 수집 0.

## 5. 노출 (frontend, 참고용)

- `frontend/functions/api/market.ts`: `agg_core_fan_estimate` 최신 스냅샷을 그룹 entries에 `core_fan_estimate: { est_engaged_fans, est_active_core } | null` 포함. `.catch(()=>[])` 격리(미적용 시 무중단).
- `frontend/src/views/MarketOverview.tsx`: 각 그룹 카드에 **작은 참고 표기** — "추정 코어팬 ~N · 적극 ~M" + '추정' 배지. **정렬 토글/순위 키로 쓰지 않음**(참고용). null/insufficient → 미표시 또는 '—'. 캡션: "좋아요·댓글 기반 추정 — 라이브 측정과 다른 축".

## 6. 테스트

`worker/tests/unit/test_core_fan_estimate.py`: compute 순수(median·basis·NULL/0 처리) + build _FakeClient(멱등·DELETE 선두·전 그룹) + migration(테이블·PK). frontend: market.ts 응답 포함 + tsc. cli aggregate에 build 호출 검증.

## 7. 마이그레이션 번호

0096~0100 적용됨 → **0101_core_fan_estimate.sql**.
