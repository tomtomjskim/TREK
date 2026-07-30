# Vacay Holiday Entry Preservation

> 작성일: 2026-07-29
> 상태: fork-first R0 로컬 검증 및 회사 휴일 소유권 재검토 완료, 배포 보류
> 기준: `origin/main` `c5ff1d27`, 설계 기준 `4e2be6d1`
> 최신 공식 비교: `upstream/dev` `57017b8a`
> 후속 권한 결정:
> [Vacay company holiday ownership](2026-07-30-vacay-company-holiday-ownership.md)

## 문제

현재 Vacay는 회사 휴일을 추가·활성화하거나 public holiday provider를 갱신할 때
같은 날짜의 `vacay_entries`를 물리적으로 삭제한다. provider 갱신은 같은 날짜의
수동 `vacay_company_holidays`도 삭제한다. 사용자가 입력한 휴가 기록이 설정 변경이나
외부 데이터 갱신으로 사라지고, 삭제 전 값은 애플리케이션에서 복구할 수 없다.

이 동작은 2026-07-30 최신 `upstream/dev`의 Nest `VacayService`와 공식
`feat/vacay-leave-and-year` 브랜치에도 남아 있다. 포크 `origin/main`에서는 SQL
소유 경로가 아직 `server/src/services/vacayService.ts`이고 Nest service는 얇은
위임 계층이므로, 이번 pilot은 실제 포크 소유 경로를 수정한다. 향후 공식 기여가
재개되면 최신 Nest 경로에 테스트와 최소 패치를 별도로 재구성한다.

## 선택한 slice

- Lane: `fork-core` correctness pilot
- Branch: `fix/vacay-preserve-holiday-entries`
- Worktree:
  `/mnt/oci-block-volume/worktrees/TREK/vacay-holiday-entry-preservation`
- DB ownership: schema 또는 migration 변경 없음
- Publication: 로컬 전용. 개인 포크 push, `main` 통합, 배포와 공식 게시/PR은 제외
- Retirement signal: 동일한 보존·비차감 계약이 검증된 공식 release를 통합할 때
  포크 패치를 제거

## 계약

1. 수동 회사 휴일 추가·제거 전후에 같은 날짜의 모든 개인 entry ID, 작성자, 날짜와
   note가 유지된다.
2. 회사 휴일 기능이 켜져 있고 수동 회사 휴일 row가 존재할 때 겹친 entry는
   stats와 carry 계산에서 차감하지 않는다.
3. 회사 휴일 row를 제거하거나 기능을 끄면 보존된 entry를 다시 차감한다.
4. public holiday provider 갱신은 개인 entry와 수동 회사 휴일을 수정·삭제하지
   않으며 반복 실행도 같은 결과를 낸다.
5. 다른 plan과 다른 사용자의 같은 날짜 row를 변경하지 않는다.
6. 기존 REST/MCP/plugin 응답 shape, 인증·plan 접근 경계, WebSocket event와 provider
   호출 횟수는 바꾸지 않는다.

public holiday occurrence를 영속화하지 않는 현재 구조에서는 provider 날짜의 과거
비차감을 재현할 수 없다. 이번 slice는 provider에 대한 입력 보존만 보장하며,
public occurrence schema, 법정 휴일 판정, 충돌 UI와 Vacay v2 entitlement는 비목표다.

## Architecture readiness

- Gate: `full_gate_required` — 현재 동작이 사용자 입력을 비가역적으로 삭제함
- Rollback: `code_only` — migration은 없지만 이미 삭제된 과거 row는 자동 복구 불가
- API/Auth: route, payload, response와 active-plan/self permission 변경 없음
- DB: 기존 row의 삭제를 중단하고 read projection만 조정; backup/backfill 불필요
- Provider/비용: 새 호출·설정·과금 없음
- Deployment: 이번 작업 범위 아님

## 검증 기록

수정 전 기준선:

```text
npm run build --workspace=shared
npm run test --workspace=server -- \
  tests/unit/services/vacayService.test.ts \
  tests/integration/vacay.test.ts

2 files, 78 tests passed
```

새 worktree에서 shared build 전 첫 실행은 `@trek/shared` dist 부재로 import 단계에서
실패했다. shared build 후 동일 suite는 통과했다. 테스트 초기화 중 기존 migration의
`duplicate column` non-fatal 로그는 기준선에서도 발생하며 이번 slice와 무관하다.

RED:

```text
npm run test --workspace=server -- \
  tests/unit/services/vacayService.test.ts \
  tests/integration/vacay.test.ts --reporter=dot

2 files, 7 failed / 75 passed
```

실패는 회사 휴일 추가·설정 활성화·provider 갱신 뒤 entry가 사라지고, 수동 회사
휴일과 겹친 entry가 carry에서 차감되는 기존 동작을 재현했다.

GREEN과 변경 서비스 coverage:

```text
focused: 2 files, 82 tests passed
vacayService.ts coverage:
  statements 82.63% / branches 66.66% / functions 83.72% / lines 87.45%
```

전체 경계 검증:

```text
server: 304 files, 5,440 tests passed
client: 206 files, 3,455 passed / 38 skipped
shared: 34 files, 141 tests passed
shared/server/client typecheck: passed
shared i18n parity strict: passed
root production build: passed
git diff --check: passed
```

REST integration과 전체 server suite가 빈 test DB에 migration 20~175를 적용해
통과했다. 기존 migration의 `duplicate column` non-fatal 로그는 수정 전에도
동일하며, production DB rehearsal은 수행하지 않았다. schema 변경이 없으므로
이번 slice의 rollback은 code-only다.

변경 파일 ESLint는 `0 errors / 20 warnings`이고, 같은 세 파일의 수정 전 기준도
동일한 20개 경고다. Prettier check는 수정 전 기준부터 세 파일 모두 실패하므로
이번 correctness patch에서 legacy 파일 전체를 재포맷하지 않았다. production
build의 large chunk·ineffective dynamic import 경고도 client 기존 기준이며 이번
server 변경과 무관하다.

## 적대적 검토

```text
Review result: pass (로컬 R0 계약 기준)
Blockers: 0
Major risks: 2
Follow-ups: 3
Decision: 로컬 브랜치 정리 진행, 배포는 후속 gate 전 보류
```

1. public provider holiday occurrence를 영속화하지 않으므로 provider 갱신은 개인
   입력을 보존하지만 해당 날짜를 stats/carry에서 자동 비차감하지 않는다. 자동
   비차감은 occurrence projection과 fallback 정책을 포함한 별도 schema slice가
   필요하다.
2. 기존 REST/MCP/plugin 경로는 active plan의 일반 구성원도 plan-wide 회사 휴일을
   변경할 수 있고 REST 경로의 date validation도 약하다. 이번 patch는 기존 auth
   경계를 의도적으로 바꾸지 않았다. 후속 재검토 결과 plan owner/server admin
   제한도 mixed-company fusion의 소유권을 해결하지 못하므로, 넓은 사용자 공개
   전 회사 휴일을 employment 소유·기본 본인 전용으로 이관하고 strict
   `YYYY-MM-DD`·coverage validation을 같은 권한 gate로 검증해야 한다.
3. 과거 destructive 동작으로 이미 삭제된 entry는 이 patch로 복구되지 않는다.
   운영 적용 전 backup에서 복구 가능한 row가 있는지 별도 read-only audit가
   필요하다.

UX, API response, WebSocket event, provider 호출 수, migration과 production
dependency는 바뀌지 않았다. 배포·개인 포크 push·공식 PR은 수행하지 않았다.

2026-07-30 재검토는 R0 patch를 되돌릴 이유를 찾지 못했다. 다만 현재 plan-wide
휴일은 `legacy_plan_overlay/unverified`인 transitional projection이며, 개인 회사
데이터 모델이 아니다. solo row도 사용자 확인 없이 회사 사실로 승격하지 않고,
fused row는 모든 구성원에게 자동 복제·활성화하지 않는다.
