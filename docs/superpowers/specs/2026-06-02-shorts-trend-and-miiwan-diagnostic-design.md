# 숏폼 트렌드 뷰 + MiiWAN 숏츠 운영 진단 패널 — 설계

- **기준일**: 2026-06-02 (MiiWAN D-14)
- **상태**: 설계 확정, 구현 계획 대기
- **접근법**: A (쿼리 시점 계산, 순수 read 경로 — 새 워커 연산·D1 migration 없음)

---

## 1. 목적

타 그룹(경쟁사) YouTube 숏폼 중 **지금 잘 터지고 있는 영상을 트렌드 관점으로 한 화면에서 보고**, 그 신호를 바탕으로 **MiiWAN이 빠르게 만들어야 할 숏폼을 판단**한다. 동시에 페이지 상단에 **MiiWAN 자사 숏츠 운영 현황을 다각도로 진단**하고 개선 방향을 자동 우선순위로 제시해, "트렌드 따라가기"와 "내 운영 고치기"를 한 화면에서 함께 끌고 간다.

근거 분석: `reports/miiwan-virality-2026-06-02.html` (D1 5/31 스냅샷, organic 쇼츠 13개 해부) — MiiWAN 숏폼이 구독자 에코챔버(~1,000뷰 천장)에 갇혀 콜드 피드로 확장되지 못한다는 진단. 핵심 원인은 콘텐츠 품질(ER 6.22% 1위급)이 아니라 **발견 가능성(discoverability) 설계 결손**.

## 2. 비목표 (YAGNI)

- LLM 컨셉/포맷 클러스터링 (향후 확장으로 남김 — 본 설계는 "잘 터진 개별 영상" 기준).
- Discord push 알림 (이번 범위는 프런트엔드 pull 전용).
- 시계열 "가속(surge)" 감지 (precompute 테이블이 필요 — 향후 접근법 B로 업그레이드 시).
- 곡명·멤버 본명 사전 기반 정밀 제목 분석 (1차는 공식 그룹명 기준, 후속 확장).
- 워커 분석 모듈 / D1 migration / aggregate 파이프라인 변경 (전부 불필요).

## 3. 아키텍처

```
youtube_videos (is_short=1)
   ├─ JOIN groups                    → 그룹 한글명, context_keywords, twitter_handles
   ├─ JOIN 최신 youtube_video_stats  → 현재 조회수/좋아요/댓글
   ├─ agg_summary                    → 구독자·뉴스·twitter_posts (MiiWAN 진단용)
   └─ agg_member_popularity          → 멤버 집중 HHI (있으면)
        │
   frontend/functions/lib/shortsDiagnostic.ts  (신규, 순수 헬퍼 — 단위 테스트 대상)
        │  진단 KPI 계산 (분포·제목 정규식·cadence·status 엔진)
        ▼
   frontend/functions/api/shorts-trend.ts      (신규 Pages Function)
        │  { diagnostic, trend, groups } 단일 응답
        ▼
   frontend/src/views/ShortsTrend.tsx          (신규 최상위 뷰)
        상단: MiiWAN 진단 패널 (접기 가능)
        하단: 경쟁사 트렌드 테이블 (랭킹·신선도·필터)
```

전부 read 경로. 이미 `aggregate` 파이프라인이 채우는 `youtube_videos.viral_velocity_ratio`(채널 대비 24h 속도)와 `view_count_24h`를 소비한다.

## 4. 기능 1 — 경쟁사 숏폼 트렌드 테이블 (페이지 하단)

### 4.1 데이터셋
`youtube_videos` WHERE `is_short=1` AND `group_key != 'miiwan'` AND 활성 그룹, **최근 90일**(`published_at`) 이내, `published_at` desc, **LIMIT 400**. 각 영상에 최신 `youtube_video_stats`(현재 조회수/좋아요/댓글) JOIN. 신규 그룹(wegosix/UR:L/BTHD 등)은 하드코딩 목록이 없어 자동 포함.

### 4.2 행별 지표
- 현재 조회수, 24h 조회수(`view_count_24h`), velocity ×배(`viral_velocity_ratio`), ER%((likes+comments)/views), 게시 상대일(`days_since_publish`), content_type.

### 4.3 랭킹 / 신선도 (클라이언트 계산)
임계값은 뷰의 **명명 상수**로 둔다 (튜닝 여지):

| 상수 | 기본값 | 의미 |
|---|---|---|
| `FRESH_DAYS` | 14 | 신선도 윈도우 |
| `FRESH_VELOCITY` | 2.0 | 🔥 배지 최소 velocity ("strong" 이상) |
| `MIN_VIEWS_FLOOR` | 5000 | velocity 랭킹 노이즈 floor (작은 채널 착시 차단) |

- **🔥 신선 배지** = `days_since_publish ≤ FRESH_DAYS` AND `viral_velocity_ratio ≥ FRESH_VELOCITY`.
- **노이즈 floor**: 현재 조회수 `< MIN_VIEWS_FLOOR` 영상은 velocity 정렬/신선 후보에서 제외.
- **velocity NULL 처리**: 게시 <2일 → "측정중"; 그 외 NULL → "—", velocity 정렬 시 맨 뒤.
- **기본 정렬 = "신선 우선"**: 🔥 영상을 위로, 그 안에서 velocity 내림차순.

### 4.4 UI (`ShortsTrend.tsx` 하단)
- 표 스타일은 `DebutWindowVideoTable` 패턴 재사용.
- 컬럼: 🔥 | 그룹 | 제목(→ `https://www.youtube.com/shorts/<video_id>` 새 탭) | content_type | 게시(상대일) | 조회수 | 24h | velocity ×배 | ER%.
- 필터: 그룹 멀티셀렉트(기본 전체 경쟁사) · content_type · `FRESH_DAYS` 선택 · 정렬(신선 우선 / velocity / 조회수 / 최신순).
- 토글: "🔥 신선만" ↔ "전체 90일 랭킹".
- cap 명시: "최근 90일 숏폼 · 최대 400편" 문구 (무음 truncation 금지 — CLAUDE.md 윤리 원칙).
- 빈 상태: "최근 90일 내 경쟁사 숏폼이 없습니다."

## 5. 기능 2 — MiiWAN 숏츠 운영 진단 패널 (페이지 상단, 접기 가능)

### 5.1 데이터 소스
`youtube_videos`(is_short=1, group_key='miiwan') + 최신 `youtube_video_stats` + `agg_summary`(yt_subscribers·naver_total_news·twitter_posts·dc_total_posts) + `agg_member_popularity`(HHI, 존재 시) + `groups`(context_keywords·twitter_handles).

### 5.2 진단 차원 (다각도) — 각 KPI = {value, status: good|warn|bad, target, why, fix}

**A. 바이럴 물리 (에코챔버 갇힘?)**

| KPI | 계산 | 상태 임계값 (기본) | 처방(레버) |
|---|---|---|---|
| 브레이크아웃 배율 | max ÷ median (현재 조회) | ≥10 good / 3–10 warn / <3 bad | ⑤ 초동속도 · ⑥ 공유 |
| 조회 CV | stdev ÷ mean | ≥0.8 good / 0.4–0.8 warn / <0.4 bad (평탄=나쁨) | ⑤⑥ |
| 좁은 밴드 집중% | [0.6×median, 1.4×median] 내 비율 | <40% good / 40–70% warn / >70% bad | ⑤⑥ |
| 천장 정체 | median 조회 ÷ 활성 구독자 추정 | — (해석 보조) | — |

**B. 발견 가능성 (제목/메타)**

| KPI | 계산 | 상태 임계값 (기본) | 처방 |
|---|---|---|---|
| 공식 그룹명 제목 커버리지% | 제목에 그룹 공식 토큰 1개+ 포함 비율 | ≥80% good / 40–80% warn / <40% bad | ③ 메타데이터 · YouTube SEO |
| 이모지·장식 특수문자% | 제목 정규식 매칭 비율 | <20% good / 20–50% warn / >50% bad | ③ |
| 평균 제목 길이 | 평균 char 수 | (해석 보조) | ③ |
| 해시태그 사용% | 제목에 `#` 포함 비율 | ≥50% good / 20–50% warn / <20% bad | ③④ |

**C. 코어 강도 (유지할 것 — 녹색 축하)**

| KPI | 계산 | 상태 | 메시지 |
|---|---|---|---|
| 평균 ER% | (likes+comments)/views 평균 | ≥4% good | "본 사람은 좋아함 — cadence 유지" |
| DC 갤러리 활동 | agg_summary.dc_total_posts 추세 | 증가 good | 코어 응집 작동 중 |

**D. 발견 채널**

| KPI | 계산 | 상태 | 처방 |
|---|---|---|---|
| X 운영 | twitter_handles 존재 AND twitter_posts>0 | 미운영 bad | ⑥ 외부 유입 · 글로벌 X |
| 뉴스 정체 | naver_total_news 7d 변화 | 정체 warn | PR |
| 글로벌 정합 | (정성 — 플레이북 노트) | — | 플랫폼별 전략 |

**E. 운영 리듬**

| KPI | 계산 | 상태 | 처방 |
|---|---|---|---|
| 업로드 cadence | 숏폼 게시 간격 중앙값(일) + 편차 | 일정 good | ⑦ 일관성 |
| 평균 velocity | MiiWAN 숏폼 viral_velocity_ratio 평균 | ≥2 good / 1–2 warn / <1 bad | ⑤ |

### 5.3 자동 우선순위 + 플레이북
- **🔴 지금 우선순위 TOP 3**: status=bad KPI 중 가중치 상위 3개를 자동 추출, 각 KPI의 `fix`(처방) 동반 → "개선 필요한 방향". MiiWAN이 개선해 status가 good로 바뀌면 자동으로 목록에서 빠진다 ("항상 좋은 방향").
- **📘 플레이북 (접기)**: evergreen 고정 게재 (리포트 9·10p 이식)
  - **숏폼 알고리즘 7 레버**: ① 첫 1–3초 후킹 ② 시청 지속·재시청(루프) ③ 검색·분류 메타데이터 ④ 트렌딩 사운드 ⑤ 초동 속도 ⑥ 공유·외부 유입 ⑦ 업로드 일관성.
  - **플랫폼별 전략**: YouTube(검색 SEO·제목 앞 키워드·롱폼 자산) / TikTok(트렌딩 사운드·첫 2초·글로벌 동남아·일본) / IG Reels(비주얼·세계관·저장 유발). 원본 1개 → 플랫폼별 3벌 리퍼포징 원칙.

### 5.4 정직성 / 데이터 한계 (UI 명시)
- **식별자 커버리지 = 공식 그룹명 기준**으로 시작. 데뷔 전이라 곡명 데이터 없음, 별명 vs 공식명 구분은 스키마에 없음 → "곡명·본명 사전 추가 시 정밀도↑" 문구. 사전은 후속 확장(`groups`에 `searchable_identifiers` JSON 추가 등)으로 열어둔다.
- **표본 소수**: 숏폼 n 함께 표기, "분포 지표는 방향성 참고" 캐비엇. n < 5면 분포 KPI(A군)는 "표본 부족" 상태로, 제목/채널 KPI(B·D군)는 정상 표시.
- thresholds 전부 lib의 명명 상수 + 주석 근거(리포트 수치).

## 6. API 계약

`GET /api/shorts-trend`

```jsonc
{
  "generated_at": "2026-06-02T...Z",
  "window_days": 90,
  "limit": 400,
  "trend": [
    {
      "video_id": "...", "group_key": "plave", "group_name_kr": "플레이브",
      "title": "...", "content_type": "Dance",
      "published_at": "...", "days_since_publish": 5,
      "views": 120000, "likes": 9000, "comments": 400,
      "view_count_24h": 80000, "viral_velocity_ratio": 4.2
    }
  ],
  "groups": [{ "key": "plave", "name_kr": "플레이브" }],
  "diagnostic": {
    "group_key": "miiwan", "shorts_n": 13,
    "dimensions": {
      "viral_physics": [ { "id":"breakout_ratio","label":"브레이크아웃 배율","value":2.0,"display":"2.0×","status":"bad","target":"≥10×","why":"...","fix":"..." } ],
      "discoverability": [ ... ], "core_strength": [ ... ],
      "discovery_channels": [ ... ], "operating_rhythm": [ ... ]
    },
    "priorities": [ { "id":"group_name_coverage","label":"...","display":"0%","fix":"..." } ],
    "caveats": ["표본 13편 — 분포 지표는 방향성 참고", "식별자=공식 그룹명 기준"]
  }
}
```

임계값/신선도 상수는 트렌드 부분은 **클라이언트(뷰)** 에서, 진단 부분은 **lib 헬퍼**에서 계산해 status까지 채워 보낸다. 진단을 서버에서 계산하는 이유: 제목 정규식·분포·status 엔진을 한 곳(테스트 가능한 순수 모듈)에 모으기 위함.

## 7. 등록 (프런트엔드 배선)

- `frontend/src/router.ts`: `RouterState.tab` union에 `"shorts"` 추가.
- `frontend/src/App.tsx`: `{state.tab === "shorts" && <ShortsTrend />}` 1줄.
- `frontend/src/components/Header.tsx`: 네비 항목 "숏폼 트렌드" 추가.
- `frontend/src/api.ts`: `shortsTrend()` 클라이언트 메서드 추가.

## 8. 에러 처리

- velocity NULL → "측정중"(게시 <2일) / "—"(그 외), 정렬 시 맨 뒤.
- stats row 없음 → views NULL → "—", views 정렬 제외.
- 트렌드 빈 결과 → 빈 상태 메시지.
- MiiWAN 숏폼 0개 → 진단 패널 "숏폼 데이터 없음" 상태.
- MiiWAN 숏폼 n < 5 → A군 분포 KPI "표본 부족".
- agg_member_popularity / HHI 없음 → 해당 KPI 생략 (graceful).

## 9. 테스트

- `frontend/functions/lib/shortsDiagnostic.ts` 순수 헬퍼 단위 테스트 (vitest):
  - 제목 정규식: 이모지/장식 특수문자/그룹명 식별자 매칭 (최우선).
  - 분포: 브레이크아웃 배율, CV, 밴드 집중%, cadence 중앙값.
  - status 엔진: 임계값 경계 parametrize.
  - 우선순위 추출: bad KPI TOP 3 정렬.
  - 소수 표본/빈 입력 graceful.
- vitest 미설정 시 최소 셋업 추가 또는 로컬 `wrangler pages dev` 수동 검증.
- 워커 변경 없음 → 기존 pytest 영향 없음.

## 10. 향후 확장 (비목표였던 것들의 경로)

- **곡명·본명 사전**: `groups.searchable_identifiers` JSON 추가 → 커버리지 정밀화.
- **시계열 surge 감지**: 접근법 B(`analysis/shorts_trend.py` + `shorts_trend` 테이블 + migration)로 업그레이드.
- **LLM 포맷 클러스터링**: 트렌드 숏폼 title/tags에서 컨셉 추출 → "요즘 이 포맷이 뜬다".
- **Discord push**: 신선 급등 감지 시 알림.
