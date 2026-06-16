#!/usr/bin/env bash
# .miiwan_secrets.env 템플릿 생성 후 기본 에디터로 연다.
# 여기에 값을 붙여넣고 저장한 뒤 register_yt_secrets.sh 를 실행한다.
set -euo pipefail

ENV_FILE=".miiwan_secrets.env"

if [[ -f "${ENV_FILE}" ]]; then
  echo "ℹ ${ENV_FILE} 이미 있음 — 그대로 엽니다."
else
  cat > "${ENV_FILE}" <<'TPL'
# 아래 세 줄의 = 뒤에 값을 붙여넣고 저장하세요 (이 파일은 gitignore됨, 등록 후 자동 삭제).
MIIWAN_YT_OAUTH_CLIENT_ID=
MIIWAN_YT_OAUTH_CLIENT_SECRET=
MIIWAN_YT_OAUTH_REFRESH_TOKEN=
TPL
  echo "✓ ${ENV_FILE} 생성."
fi

# macOS 기본 텍스트 에디터로 열기 (TextEdit).
open -e "${ENV_FILE}" 2>/dev/null || echo "  에디터로 직접 여세요: ${ENV_FILE}"
