# 단체 음원 기준 데뷔일 확인 (2026-10-22)

운영자 기준: **음원사이트에 정식 발매된 첫 단체 음원**을 데뷔일로 사용한다.
전원 참여 선공개·프롤로그 싱글도 포함하며, 방송 시작·커버·라이브에서만 공개한
자작곡은 포함하지 않는다. 이번 확인 대상은 아래 세 그룹이다.

| 그룹 | 데뷔일 | 근거 | 설정 |
| --- | --- | --- | --- |
| BTHD / 비더후드 | 2026-06-26 | 첫 5인 단체 싱글 `Lowkey` | 기존 날짜 유지, `debut_confirmed=1`로 확정 |
| WE GO-6 / 위고식스 | 2026-09-22 | 5인 전원 참여 프롤로그 싱글 `괴물(Monster)` | 날짜 설정, `debut_confirmed=1` |
| BEGRITZ / 비그릿츠 | 미확정 | 공식 채널의 `X도` 라이브 클립은 확인했지만 정식 음원 유통은 확인하지 못함 | 기존 날짜 없음/PRE 유지 |

## 확인 출처와 구분

- BTHD: [Apple Music의 Lowkey 발매 정보](https://music.apple.com/kr/album/lowkey-single/6777950875)에
  2026-06-26 발매, LEVVELS/YG PLUS 유통이 명시되어 있다.
  [스포츠경향의 첫 싱글 발매 보도](https://sports.khan.co.kr/article/202606270530003)는
  다섯 멤버의 첫 음원이 6월 26일 오후 6시 각 음원사이트에 공개되었다고 설명한다.
  홍보상 정식 데뷔 앨범 `THE REAL DEAL`의 10월 20일 발매와는 구분한다.
- WE GO-6: [벅스의 Monster 앨범 정보](https://music.bugs.co.kr/album/4155552)에
  2026-09-22 발매, 카카오엔터테인먼트 유통이 명시되어 있다.
  [OSEN/조선일보의 발매 보도](https://www.chosun.com/entertainments/music/2026/09/23/GNRGIZBRME2TSOBTGBQWEMZUHA/)는
  9월 22일 오후 6시 음원 발매와 모든 멤버가 각 페르소나 유닛에 참여함을 명시한다.
- BEGRITZ: [소속사 공식 사이트](https://dnable.xyz/)가 연결한
  [공식 채널](https://www.youtube.com/@BEGRITZ)에서
  [`X도` 자작곡 라이브 클립](https://www.youtube.com/watch?v=xcIYoiq1zjY)을 확인했다.
  정식 음원 유통 여부가 불확실하여 운영자에게 문의했고,
  **“음원사이트 정식 발매 전까지 PRE 유지”**로 결정했다.
  음원이 없다고 확정한 것은 아니며, 발매 링크가 확보되면 날짜를 재확인한다.

## 적용 및 확인

`migrations/0118_confirm_group_music_debuts.sql`이 두 그룹의 날짜·확정 플래그와
출처가 있는 데뷔 이벤트를 갱신한다. BEGRITZ와 다른 그룹의 설정은 변경하지 않는다.
기존 BTHD 잠정 앵커 및 WE GO-6의 8월 31일 가안 이벤트는 확정 이벤트로 교체한다.

운영 DB에는 기존 `migrate` 워크플로의 `target=remote` 또는 D1 마이그레이션
적용이 필요하다. 이 문서나 로컬 SQL 파일 생성만으로 운영 적용이 끝난 것은 아니다.
화면의 Health Score PRE 판정과 데뷔 구간 지표는 다음 집계에서 다시 계산된다.
