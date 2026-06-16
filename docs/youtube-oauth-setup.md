# 미완소년 공식 채널 YouTube OAuth 연결 가이드

DECISION 탭(해외진출 / 굿즈)의 **소유자 전용 지표**를 채우려면 미완소년
공식 YouTube 채널의 OAuth 위임이 필요하다. 공개 API 키(`YT_API_KEY`)로는
조회수·구독자 같은 공개 수치만 보이고, **국가별 시청·유지율·구독전환·
재방문·멤버십·슈퍼챗**은 채널 소유자만 볼 수 있다.

이 문서는 OAuth를 1회 발급해 `refresh_token`을 얻고, GitHub Actions
워커가 매일 그것으로 YouTube Analytics를 읽어 D1에 적재하기까지의 절차다.

---

## 0. 무엇이 열리나 (스코프)

| API | 스코프 | 채우는 DECISION 지표 |
|---|---|---|
| YouTube **Analytics** API | `https://www.googleapis.com/auth/yt-analytics.readonly` | 국가별 시청점유·성장률·유지율·구독전환, 재방문 시청자 |
| YouTube Analytics(**수익**) | `https://www.googleapis.com/auth/yt-analytics-monetary.readonly` | 멤버십·슈퍼챗·예상수익 (지불의향 등급) |
| YouTube **Data** API v3 (선택) | `https://www.googleapis.com/auth/youtube.readonly` | 자막 업로드·댓글 모더레이션 등 운영 동작(추후) |

> 진출/굿즈 의사결정만 목표면 위 두 `*.readonly` 스코프로 충분하다.

---

## 1. 사전 조건 — 누가 승인하는가

OAuth 동의는 **미완소년 채널의 소유자/관리자 권한이 있는 구글 계정**이
직접 해야 한다 (Abyss/IPX 채널 운영 담당자). BI팀 개인 계정으로는 그
채널의 Analytics를 못 본다. 1회 승인만 받으면 이후는 무인 갱신된다.

---

## 2. Google Cloud Console 설정 (1회)

1. **프로젝트 생성/선택** — console.cloud.google.com → 새 프로젝트 (예: `idol-sight-yt`).
2. **API 사용 설정** — "API 및 서비스 > 라이브러리"에서 아래 둘 활성화:
   - *YouTube Analytics API*
   - *YouTube Reporting API* (대량 일별 CSV가 필요할 때)
3. **OAuth 동의 화면** — 사용자 유형 `외부`, 앱 이름/지원 이메일 입력.
   - 스코프에 위 1번 표의 `yt-analytics.readonly`(+ 필요 시 monetary) 추가.
   - "테스트 사용자"에 **채널 소유 구글 계정**을 등록(게시 전이면 테스트
     모드로 충분 — refresh token이 7일 만료되지 않도록 동의화면을
     `프로덕션`으로 게시하는 것을 권장).
4. **OAuth 클라이언트 ID 생성** — "사용자 인증 정보 > OAuth 클라이언트 ID":
   - 애플리케이션 유형 **데스크톱 앱** (1회 발급용으로 가장 간단).
   - 발급된 `client_id` / `client_secret` 보관.

---

## 3. refresh_token 1회 발급

채널 소유 계정으로 아래 스크립트를 **로컬에서** 한 번 실행한다. 브라우저가
열리고 동의하면 `refresh_token`이 출력된다.

```bash
# 로컬 1회용 — 워커에는 넣지 않는다
uv run --with google-auth-oauthlib python - <<'PY'
from google_auth_oauthlib.flow import InstalledAppFlow
SCOPES = [
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
]
flow = InstalledAppFlow.from_client_config(
    {"installed": {
        "client_id": "<CLIENT_ID>",
        "client_secret": "<CLIENT_SECRET>",
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "redirect_uris": ["http://localhost"],
    }},
    scopes=SCOPES,
)
creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
print("REFRESH TOKEN:\n", creds.refresh_token)
PY
```

> `access_type=offline` + `prompt=consent` 가 있어야 `refresh_token`이 발급된다.

---

## 4. GitHub Actions 시크릿 등록

레포 Settings → Secrets and variables → Actions 에 추가 (기존
`CF_*` / `YT_API_KEY` 와 같은 자리):

| 시크릿 | 값 |
|---|---|
| `MIIWAN_YT_OAUTH_CLIENT_ID` | 2번에서 받은 client_id |
| `MIIWAN_YT_OAUTH_CLIENT_SECRET` | client_secret |
| `MIIWAN_YT_OAUTH_REFRESH_TOKEN` | 3번에서 받은 refresh_token |

워커는 `config.py`의 `_optional(...)` 패턴으로 읽는다 (`YT_API_KEY`와 동일):

```python
miiwan_yt_oauth_client_id     = _optional("MIIWAN_YT_OAUTH_CLIENT_ID")
miiwan_yt_oauth_client_secret = _optional("MIIWAN_YT_OAUTH_CLIENT_SECRET")
miiwan_yt_oauth_refresh_token = _optional("MIIWAN_YT_OAUTH_REFRESH_TOKEN")
```

`collect-daily.yml`(또는 전용 워크플로)의 `env:` 블록에 세 줄을
`${{ secrets.MIIWAN_YT_OAUTH_* }}` 로 주입한다.

---

## 5. 구현된 collector (이미 코드에 있음)

이 파이프라인은 **이미 구현되어 있다.** 시크릿 3개만 넣으면 동작한다.

| 구성 | 위치 |
|---|---|
| collector | `worker/src/idol_sight/collectors/youtube_analytics.py` |
| CLI 커맨드 | `uv run python -m idol_sight youtube-analytics --group miiwan` |
| 적재 테이블 | `agg_youtube_analytics`, `agg_youtube_analytics_country` (migration **0087**) |
| 일일 실행 | `collect-daily.yml` 의 `miiwan-analytics` job (시크릿 없으면 자동 skip) |
| API 노출 | `functions/api/miiwan.ts` → `decision.analytics` |
| 점수 산식 | `frontend/src/lib/decisionSupport.ts` (+ 테스트) |

collector는 refresh_token으로 access_token을 갱신한 뒤 국가별 리포트(현재
30일 + 직전 30일)를 호출해 `watch_share / growth_mom / retention_rel /
sub_per_1k` 를 계산한다. `retention_rel` 은 `country.averageViewPercentage /
KR.averageViewPercentage` (국내 대비).

## 6. ⚠️ API 한계 — 무엇이 점등되고 무엇이 안 되나

소유자 OAuth라도 **YouTube Analytics API가 노출하는 지표에만** 의존한다.

| DECISION 보드 | OAuth 후 상태 |
|---|---|
| **해외진출** (국가별 점수) | ✅ 완전 점등 — 국가 지표는 API가 제공 |
| **굿즈 · 멤버 배분** | ✅ (이미 공개 프록시로 점등, OAuth 무관) |
| **굿즈 · 수요 하한** | ⚠️ 대기 유지 — '재방문 시청자수'를 API가 깔끔히 노출 안 함 |
| **굿즈 · 지불의향** | ⚠️ 대기 유지 — '멤버십 가입자수'를 API가 노출 안 함 |

즉 OAuth를 붙이면 **해외진출 보드가 실데이터로 켜진다.** 수요하한·지불의향은
API 한계로 계속 '연결 대기'이며, 그 칸은 향후 멤버십/재방문 지표를 별도
소스(예: Studio 수동 export, 예약판매 실측)로 채울 때 점등된다. collector는
그 두 칼럼을 NULL로 적재하고, 프론트는 NULL이면 empty-state를 유지한다.

---

## 7. 배포 — 시크릿 등록 후 한 번만

1. **시크릿 3개 등록** (`scripts/register_yt_secrets.sh` 또는 수동):
   `MIIWAN_YT_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN`
2. **마이그레이션 적용** (테이블 생성) — GitHub Actions `migrate` 워크플로 실행:
   ```bash
   gh workflow run migrate -f target=remote
   ```
   (또는 GitHub UI → Actions → migrate → Run workflow → remote)
3. **수집** — 다음 `collect-daily` cron(매일 KST 21:30)에 `miiwan-analytics`
   job이 자동 수행. 즉시 확인하려면 수동 실행:
   ```bash
   gh workflow run collect-daily
   ```
4. 수집되면 MiiWAN 브리핑 → DECISION → 해외진출 탭이 실데이터로 점등.

---

## 7. 보안·운영 주의

- **refresh_token은 비밀**이다. 코드/로그/커밋에 절대 남기지 말 것 (GitHub
  Secret 또는 CF secret에만).
- 인구통계·수익은 민감 데이터 → 이미 있는 `access_log`(migration 0079)로
  열람을 내부 권한자에 한정하는 것을 권장.
- 채널 소유자가 권한을 철회하거나 동의화면이 테스트 모드(7일)면 토큰이
  만료된다 → 동의화면 **프로덕션 게시** 권장, 만료 시 3번 재발급.
- 이 데이터는 **미완소년 채널에만** 적용된다. 다른 7개 그룹은 공개
  데이터뿐이라 DECISION 탭의 해외진출/유지율 보드는 미완소년 전용이다.
