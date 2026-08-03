# Vacay Correctness Upstream Extraction Dossiers

> 마지막 확인: 2026-08-03
>
> 포크 기준: `tomtomjskim/TREK` `68e6b7df255751ed75020c825c2f034345209ce4`
>
> 공식 기준: `liketrek/TREK` `upstream/dev`
> `c42aea4171fc7744f663da232f75078b2e3a3b78`
>
> 게시 상태: 개인 포크·운영 검증 완료, Discord·공식 issue/branch/PR 미실행

이 문서는 현재 포크에 반영된 두 최신 Vacay 관련 변경을 향후 공식 기여 시 서로
독립적으로 재구성하기 위한 제출 준비 자료다. 배포 브랜치나 아래 포크 commit을
공식 PR에 그대로 cherry-pick하지 않는다. 최신 `upstream/dev`의 owning module과
테스트에서 한 항목만 다시 구현한다.

## 분류 결정

| ID                       | 포크 변경                            | 현재 lane               | 공식 제출 준비도                      | 이유                                                                  |
| ------------------------ | ------------------------------------ | ----------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `VACAY-DISSOLVE-BALANCE` | fusion 해산 시 최신 user-year 보존   | `upstream-contrib` 후보 | Discord 범위 확인 가능                | 일반적인 데이터 보존 문제이고 현재 upstream에도 같은 누락이 남아 있음 |
| `TRIP-VACAY-UNLINKED`    | 여행 기간 변경 시 Vacay entry 비이동 | `fork-core` 정책 차이   | 직접 PR 금지, 제품 contract 합의 필요 | 공식 issue #983이 반대 동작인 자동 이동을 의도적으로 도입·확인함      |

두 항목은 같은 Vacay 영역을 건드리지만 사용자 contract와 upstream 준비도가 다르다.
하나의 issue, branch, commit 또는 PR로 묶지 않는다. Employment/period/journal 기반
Vacay v2, 회사 휴일 권한, 초대 topology와도 분리한다.

## Dossier 1 — fusion 해산 시 최신 user-year 보존

### 일반 문제와 contract

공유 Vacay plan에서 수정된 사용자의 `vacation_days`와 `carried_over`는 해산 전에
그 사용자의 최신 상태다. member self-dissolve와 owner 전체 dissolve 모두 다음을
한 transaction에서 수행해야 한다.

1. 사용자의 entry를 자기 plan으로 이동한다.
2. 자기 plan에 필요한 연도를 만들고 최신 user-year 값을 upsert한다.
3. shared plan의 해당 사용자 user-year를 제거한다.
4. membership을 제거한다.
5. 중간 실패 시 위 변경을 모두 rollback한다.

response shape, auth contract, DB schema와 migration은 바꾸지 않는다. 다른 사용자의
값을 섞거나 shared plan의 owner 값을 덮지 않는다.

### 포크 증거

- source commit: `68e6b7df` (`fix(vacay): preserve balances when dissolving plans`)
- 포크 source: `server/src/services/vacayService.ts`
- 포크 tests:
  `server/tests/unit/services/vacayService.test.ts`,
  `server/tests/integration/vacay.test.ts`
- 검증된 경계: member/owner 해산, 목적지 전용 연도 생성, 기존 목적지 row 갱신,
  stale shared row 제거, 사용자 간 데이터 분리, transaction 원자성
- schema·migration·dependency·public response 변경 없음

### 최신 upstream 추출 위치

`upstream/dev`는 Vacay backend를 Nest DI로 이동했다. 포크 구현 파일을 복사하지
않고 다음 위치에서 동일 contract를 재구성한다.

- implementation: `server/src/nest/vacay/vacay.service.ts`
  `VacayService.dissolvePlan`
- focused unit: `server/tests/unit/nest/vacay.service.test.ts`
- REST integration: `server/tests/integration/vacay.test.ts`
- surface parity: `server/tests/unit/mcp/tools-vacay.test.ts`,
  `server/tests/e2e/vacay.e2e.test.ts` 중 실제 변경 경로

현재 upstream `dissolvePlan`은 entry와 company holiday를 자기 plan으로 돌리고
membership을 삭제하지만 `vacay_user_years`를 복구하지 않는다. 읽기 전용 검색에서
동일한 dissolution balance issue/PR은 확인되지 않았으나, 제출 직전에 다시 검색한다.

### 향후 제출 패킷

- Discord 제안 제목: `Preserve per-user Vacay balances when dissolving a fused plan`
- 예상 commit/PR 제목: `fix(vacay): preserve balances when dissolving plans`
- Summary:
  - restore each member's latest per-year allowance and carry to their own plan
  - remove the stale shared user-year only inside the existing dissolve transaction
  - cover member and owner dissolution without schema or response changes
- Test plan:
  - focused Nest Vacay unit tests
  - REST integration for member and owner paths
  - forced write failure proving full rollback
  - full server coverage/typecheck plus repository-required gate
- 비목표: Vacay v2 schema, entitlement policy, sharing 권한 재설계, UI 변경
- retirement: 같은 contract가 포함된 공식 release tag를 포크에 통합하고 동등성
  회귀가 통과한 뒤에만 `68e6b7df`의 로컬 patch를 제거한다.

## Dossier 2 — 출처가 없는 Vacay entry 자동 이동 중단

### 포크 contract

현재 Vacay entry에는 `source_trip_id`나 동등한 provenance가 없다. 포크는 날짜가
여행 기간과 겹친다는 사실만으로 그 entry가 해당 여행 때문에 생성됐다고 추론하지
않는다. 따라서 trip 날짜와 `date_shift_mode`가 바뀌어도 Vacay entry의 ID, 날짜,
fraction, kind와 note를 보존한다. trip day, reservation과 accommodation의 기존
shift contract는 그대로 유지한다.

### 포크 증거

- source commit: `db815b2e` (`fix(trips): stop moving unrelated vacay entries`)
- implementation: `server/src/services/tripService.ts`의 자동 호출 제거와 사용되지
  않는 `server/src/services/vacayService.ts` helper 제거
- tests: `server/tests/unit/services/tripService.test.ts`,
  `server/tests/unit/mcp/tools-trips.test.ts`
- schema·migration·API/auth/UI 변경 없음

### upstream contract 충돌

공식 [issue #983](https://github.com/liketrek/TREK/issues/983)은 active plan과 무관하게
old trip window의 owner Vacay entry를 모두 이동하는 동작을 기대했고, 공식
`e7b419d3`에서 그 동작을 의도적으로 추가했다. issue는 확인 후 완료 상태로 닫혔다.
최신 upstream도 다음 경로에서 자동 이동을 유지한다.

- `server/src/nest/trips/trips.service.ts` `TripsService.updateTrip`
- `server/src/nest/vacay/vacay.service.ts`
  `VacayService.shiftOwnerEntriesForTripWindow`
- `server/tests/unit/mcp/tools-trips.test.ts`의 이동 기대 회귀

따라서 포크 patch를 일반적인 명백한 bug fix로 제출하면 기존 공식 contract를
뒤집는다. 이 항목은 Discord에서 다음 제품 선택을 먼저 합의하기 전에는 공식
issue·branch·PR을 만들지 않는다.

1. 자동 이동을 유지하되 명시적 trip-entry linkage를 추가한다.
2. linkage가 없는 현재 schema에서는 자동 이동을 중단한다.
3. 여행 변경 시 사용자가 이동 대상을 확인하도록 별도 command/UI를 둔다.

포크의 안전 기본값은 2번이지만, upstream 기여의 권장 장기안은 provenance를 먼저
정의한 1번 또는 3번이다. schema, migration과 UI가 필요한 장기안은 이번 최소
correctness PR과 섞지 않는다.

### 향후 제출 조건

- TOM이 공식 게시 재개를 승인한다.
- maintainer가 #983 이후의 authoritative contract를 명시한다.
- 선택한 contract를 최신 Nest owning path의 RED test로 먼저 고정한다.
- 포크 commit을 cherry-pick하지 않고 최신 `upstream/dev`에서 재구성한다.
- 현재 official behavior를 바꾸는 경우 #983과 새 discussion을 PR에 함께 연결한다.

## 공통 공식 기여 gate

1. `git fetch --prune upstream main dev --tags` 뒤 최신 정책과 중복 issue/PR을
   다시 확인한다.
2. TOM의 공식 게시 범위 승인 뒤 Discord `#github-pr`에서 한 dossier만 제안한다.
3. 승인된 항목만 최신 `upstream/dev` 기반
   `upstream-contrib/<one-topic>` worktree에서 재구성한다.
4. JSNetworkCorp domain, 운영 image/DB/backup, 포크 migration ID와 계정 정보는
   공식 branch에 포함하지 않는다.
5. PR template의 Summary, linked issue/discussion, test plan과 문서 여부를 채우고
   `dev`를 base로 사용한다.
6. merge 뒤에도 즉시 포크 patch를 제거하지 않는다. 공식 release tag 통합과
   동등성 회귀까지 포크 runtime을 유지한다.

이 문서는 제출을 쉽게 만드는 내부 dossier이며 외부 게시 승인이나 PR 생성
요청으로 해석하지 않는다.
