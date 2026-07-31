# Vacay Pre-deployment Hardening

> 작성일: 2026-07-31
> 상태: 로컬 전체 게이트 통과 및 운영 배포 완료
> 기준 branch: `fix/vacay-preserve-holiday-entries`
> publication: 로컬·개인 저장소만 사용하며 push, merge, 공식 PR은 제외

## 목적

회사 휴일 보존, 융합 plan 쓰기 제한, 연도 삭제 안전성, 초대 연도 이관과
멤버십 topology 작업을 실제 운영에 적용하기 전에 서로 맞물리는 계산·권한·실패
경계를 한 번 더 고정한다. schema, migration, dependency와 API 성공 응답 shape는
변경하지 않는다.

## 최종 계약

- carry-over는 실제로 연속된 연도 사이에서만 전파한다. 특정 연도를 다시 계산할
  때 다음 연도에 gap이 있으면 그 지점에서 멈추고, 전체 재계산은 뒤쪽의 독립된
  연속 구간을 별도로 처리한다.
- 사용자-연도 설정이 없으면 기존 제품 기본값인 `30 vacation days / 0 carry`를
  사용한다. 회사 휴일 또는 설정 변경에 따른 carry 재계산은 원자적으로 수행한다.
- 휴가 entry와 회사 휴일 입력은 실제 Gregorian `YYYY-MM-DD`만 허용한다. 윤년을
  포함한 달력 검증 실패는 REST `400 / VACAY_INVALID_DATE`, MCP structured tool
  error, plugin `BadParams`로 변환한다.
- 초대 수락 시 사용자의 원래 plan에 있던 연도 설정이 목적지의 오래된 행보다
  우선한다. 원래 plan에 없던 목적지 연도는 `30 / 0`으로 초기화하며, 전체 이관은
  기존 immediate transaction 안에서 실패 시 전부 rollback한다.
- 초대 취소는 요청 actor를 기준으로 실제 plan owner만 수행할 수 있다. dangling,
  self, multiple accepted membership은 자동 추정하지 않고 review-required `409`로
  실패-폐쇄한다.
- WebSocket 알림은 DB transaction이 commit된 뒤 실제 변경이 있을 때만 전송한다.
- 클라이언트는 owner에게만 pending invitation 취소 동작을 표시한다. 서버 권한
  검사가 최종 권위이며 UI는 오작동 방지 보조선이다.

## 검증

적대적 재검토는 correctness, QA, security 세 관점에서 blocker와 material
finding 없이 통과했다. DB가 accepted membership 유일성을 직접 강제하지 않는
점은 남아 있지만 현재 모든 관련 service mutation이 immediate transaction에서
실패-폐쇄한다.

```text
focused server:
  5 files / 272 tests passed
focused client:
  VacayPersons 13 tests passed

full server:
  304 files / 5,531 tests passed
full shared:
  34 files / 141 tests passed
full client:
  206 files / 3,468 passed / 38 skipped

shared i18n parity strict: passed
client page-pattern lint: passed
shared/server/client typecheck: passed
changed-path ESLint: 0 errors
root production build: passed
Vacay Playwright REST + responsive UI: setup 포함 2 passed
git diff --check: passed
```

첫 Playwright 실행은 drawer 안의 `44px` 닫기 버튼을 Chromium이 합성 중
`43.9999847px`로 보고해 크기 단언만 실패했다. 허용 오차를 `0.01px`로 제한해
실질적으로 작은 target은 계속 실패하도록 보정했고 같은 시나리오를 재실행해
통과했다. 테스트 DB 초기화의 기존 duplicate-column non-fatal 로그, React Router
future flag, Vite large-chunk·ineffective dynamic-import 경고는 유지되며 이번
Vacay 변경의 신규 오류는 아니다.

## 배포·rollback

변경은 code-only이고 schema/data migration이 없다. 운영 배포 전 SQLite online
backup과 무결성 검사를 수행하고, 후보 image를 빈 임시 data volume으로 먼저
기동한다. 운영 health, 재시작 횟수, HTTPS, 비인증 `401`, DB 무결성 또는 Vacay
topology aggregate 중 하나라도 기준을 벗어나면 직전 image tag로 즉시 되돌린다.

잔여 구조 리스크는 accepted membership partial unique index가 없다는 점이다.
legacy audit와 migration rehearsal 없이 이번 배포에 index를 추가하지 않으며,
유효하지 않은 topology는 자동 삭제·수선하지 않고 명시적 review-required 응답을
유지한다.

## 운영 배포 결과

- runtime source: `37a0784c33f01ab52fd2c84710e3c11f684e0f09`
- image: `trek:3.4.1-jsnetworkcorp-37a0784c`
- image ID: `sha256:32a94e4eef9b559929a9407ee40143d326d448dd8b27b082882142d946967581`
- version: `3.4.1+jsnetworkcorp.37a0784c`
- pre-deploy backup:
  `/app/data/backups/predeploy-vacay-20260731T021746Z-travel.db`
- immediate rollback image: `trek:3.4.1-jsnetworkcorp-1747b8a6`

online backup은 mode `0600`, `quick_check=ok`, FK 오류 0으로 확인했다. 배포
전후 DB는 users 2, plans 2, memberships 0이며 dangling/unknown/multiple accepted,
owner self-membership, orphan entry/user-year와 duplicate user-year key 집계가
모두 0으로 유지됐다.

app 컨테이너만 재생성했으며 block-volume data/uploads mount, loopback port와
`ubuntu_webnet` 고정 IP를 보존했다. 배포 후 local/public health와 공개 homepage
`200`, HTTP→HTTPS `301`, 비인증 Vacay `401`, 허용 origin CORS `204`, HSTS/CSP,
정확한 public version을 확인했다. 공개 Chromium smoke는 로그인 form, secure
context, Service Worker active/controller와 page/console error 0을 확인했다.
관찰 뒤 컨테이너는 healthy, restart 0이고 fatal/runtime issue log는 0이다.
