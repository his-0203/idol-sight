#!/usr/bin/env python3
"""미완소년 공식 채널 YouTube Analytics OAuth refresh_token 1회 발급 헬퍼.

사용법 (로컬에서만, 1회):
    # OAuth JSON 을 ~/Downloads 에 두면 자동으로 찾는다
    uv run --with google-auth-oauthlib python scripts/get_yt_refresh_token.py
    # 또는 경로 직접 지정
    uv run --with google-auth-oauthlib python scripts/get_yt_refresh_token.py /path/to/client_secret.json

client_id/secret 을 인자로 받지 않고 Google Cloud 에서 받은 OAuth JSON 에서
읽으므로, 비밀값을 터미널/채팅에 입력할 일이 없다.

브라우저가 열리면 **미완소년 채널 소유/관리 권한 계정**으로 로그인하고,
계정/브랜드 채널 선택이 뜨면 반드시 **미완소년 채널**을 선택한다.
발급된 refresh_token 은 .miiwan_refresh_token (gitignore됨) 에 저장된다.

⚠️ refresh_token 은 비밀이다 — 커밋/로그/공유 금지.
⚠️ 동의 화면이 '테스트' 상태면 토큰이 7일 만에 만료된다 → 프로덕션 게시 권장.
"""

from __future__ import annotations

import glob
import json
import os
import sys

SCOPES = [
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    # 멤버십/슈퍼챗(지불의향 등급)까지 보려면 아래도 동의 화면 스코프에 등록.
    # 등록 안 했으면 이 줄을 지우고 실행한다.
    "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
]


def _find_oauth_json() -> str:
    """인자로 받은 경로 또는 ~/Downloads 의 최신 client_secret_*.json."""
    if len(sys.argv) >= 2:
        return sys.argv[1]
    candidates = sorted(
        glob.glob(os.path.expanduser("~/Downloads/client_secret_*.json")),
        key=os.path.getmtime,
    )
    if not candidates:
        print("✗ OAuth JSON 을 못 찾음. ~/Downloads 에 client_secret_*.json 을 두거나")
        print("  경로를 인자로 지정: python scripts/get_yt_refresh_token.py /path/to.json")
        raise SystemExit(2)
    return candidates[-1]


def main() -> None:
    json_path = _find_oauth_json()
    print(f"OAuth JSON: {json_path}")
    with open(json_path) as f:
        conf = json.load(f)
    # 데스크톱 앱은 'installed', 웹 앱은 'web' 키.
    block = conf.get("installed") or conf.get("web")
    if not block:
        print("✗ JSON 형식이 예상과 다름 ('installed'/'web' 키 없음).")
        raise SystemExit(2)

    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_config(
        {
            "installed": {
                "client_id": block["client_id"],
                "client_secret": block["client_secret"],
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost"],
            }
        },
        scopes=SCOPES,
    )
    # access_type=offline + prompt=consent 가 있어야 refresh_token 이 발급된다.
    creds = flow.run_local_server(
        port=0, access_type="offline", prompt="consent",
    )

    # 토큰을 .gitignore 된 파일로 떨군다 — 채팅/터미널에 값을 복붙하지 않고
    # 바로 `gh secret set ... --body "$(cat ...)"` 로 등록하기 위함.
    out_path = ".miiwan_refresh_token"
    with open(out_path, "w") as f:
        f.write(creds.refresh_token)

    print("\n" + "=" * 60)
    print(f"✓ refresh_token 을 {out_path} 에 저장했습니다 (gitignore됨).")
    print("이제 아래를 실행하면 GitHub Secret 3개가 한 번에 등록됩니다:")
    print("")
    print("  bash scripts/register_yt_secrets.sh")
    print("=" * 60)


if __name__ == "__main__":
    main()
