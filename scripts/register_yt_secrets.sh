#!/usr/bin/env bash
# 미완소년 YouTube OAuth 시크릿 3개를 GitHub(his-0203/idol-sight)에 등록.
#
# 값은 채팅/명령어에 절대 넣지 않는다 — .miiwan_secrets.env (gitignore됨)
# 파일에서만 읽는다. 등록 후 그 파일은 자동 삭제한다.
#
# 사용법:
#   1) .miiwan_secrets.env 파일에 아래 3줄을 채운다 (에디터에서):
#        MIIWAN_YT_OAUTH_CLIENT_ID=...
#        MIIWAN_YT_OAUTH_CLIENT_SECRET=...
#        MIIWAN_YT_OAUTH_REFRESH_TOKEN=...
#   2) bash scripts/register_yt_secrets.sh
set -euo pipefail

REPO="his-0203/idol-sight"
ENV_FILE=".miiwan_secrets.env"

[[ -f "${ENV_FILE}" ]] || {
  echo "✗ ${ENV_FILE} 없음."
  echo "  scripts/make_secrets_template.sh 를 먼저 실행하거나, 아래 3줄로 직접 만드세요:"
  echo "    MIIWAN_YT_OAUTH_CLIENT_ID=..."
  echo "    MIIWAN_YT_OAUTH_CLIENT_SECRET=..."
  echo "    MIIWAN_YT_OAUTH_REFRESH_TOKEN=..."
  exit 1
}

# KEY=VALUE 안전 파서 (source 안 함 — 특수문자/공백 안전). 첫 '=' 기준 분리.
get_val() {
  # 주석/빈 줄 제외, 해당 KEY 의 첫 매치에서 값만 추출.
  grep -E "^${1}=" "${ENV_FILE}" | head -1 | sed -E "s/^${1}=//" | sed -E 's/^"(.*)"$/\1/' | sed -E "s/^'(.*)'$/\1/"
}

CID=$(get_val MIIWAN_YT_OAUTH_CLIENT_ID)
CSECRET=$(get_val MIIWAN_YT_OAUTH_CLIENT_SECRET)
RT=$(get_val MIIWAN_YT_OAUTH_REFRESH_TOKEN)

# 검증 — 비었거나 플레이스홀더면 중단.
for pair in "CLIENT_ID:${CID}" "CLIENT_SECRET:${CSECRET}" "REFRESH_TOKEN:${RT}"; do
  name="${pair%%:*}"; val="${pair#*:}"
  if [[ -z "${val}" || "${val}" == *"..."* || "${val}" == "<"* ]]; then
    echo "✗ ${name} 값이 비어있거나 미입력(플레이스홀더). ${ENV_FILE} 를 확인하세요."
    exit 1
  fi
done

# 등록 — gh 는 값을 화면에 출력하지 않는다.
printf '%s' "${CID}"     | gh secret set MIIWAN_YT_OAUTH_CLIENT_ID     -R "${REPO}"
printf '%s' "${CSECRET}" | gh secret set MIIWAN_YT_OAUTH_CLIENT_SECRET -R "${REPO}"
printf '%s' "${RT}"      | gh secret set MIIWAN_YT_OAUTH_REFRESH_TOKEN -R "${REPO}"

# 비밀 파일 정리 — 디스크에 안 남김.
rm -f "${ENV_FILE}"

echo ""
echo "✓ 3개 시크릿 등록 완료 + 로컬 ${ENV_FILE} 삭제. 확인:"
gh secret list -R "${REPO}" | grep MIIWAN || true
