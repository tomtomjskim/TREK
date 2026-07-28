# Vacay Upstream Correctness Proposal

> 작성일: 2026-07-28
> 상태: 적대 리뷰 보완된 Discord 제안 초안, 게시·코드 작성·공식 PR 미실행
> 조사 기준: `liketrek/TREK` `upstream/dev` `292f1b18`

## 목적

Employment/period/balance 기능을 추가하기 전에 현재 Vacay 데이터 정합성 문제를
작은 독립 PR로 분리한다. 공식 규칙에 따라 Discord `#github-pr`에서 maintainer가
원하는 범위를 먼저 확인하며, 서로 다른 수정이나 신규 기능을 한 PR에 묶지 않는다.

이 문서의 테스트는 구현 전 RED specification이다. upstream 승인을 받지 않았으므로
실제 테스트 파일이나 소스는 아직 수정하지 않았다.

## 확인된 기존 동작

| 문제                                                   | `upstream/dev` 근거                                                          | 현재 테스트 근거                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| stats read가 다음 연도 carry를 UPSERT                  | `VacayService.getStats()` `server/src/nest/vacay/vacay.service.ts:1094-1119` | stats 결과 테스트는 있으나 DB write 불변성 테스트 없음 |
| 회사 휴일 추가가 같은 날짜의 모든 entry 삭제           | `toggleCompanyHoliday()` `:1076-1085`                                        | `VACAY-SVC-036`이 삭제를 기대                          |
| public holiday refresh가 entry와 company holiday 삭제  | `applyHolidayCalendars()` `:410-449`                                         | `VACAY-SVC-047`이 삭제를 기대                          |
| fusion 해제 시 user-year를 개인 plan으로 돌려놓지 않음 | `acceptInvite()` `:637-679`, `dissolvePlan()` `:704-730`                     | dissolution 후 allowance/carry 보존 테스트 없음        |
| trip 시작일 변경이 출처 없는 Vacay entry를 이동        | `tripService.updateTrip()` `server/src/services/tripService.ts:234-308`      | MCP `update_trip`과 bridge 테스트가 이동을 기대        |

추가로 REST stats controller는 `getActivePlanId()`를 거치며 개인 plan이 없을 때
legacy plan/year/color를 생성할 수 있다. 따라서 `getStats()`의 carry UPSERT 제거와
“모든 stats endpoint가 어떤 상태에서도 완전 무쓰기”는 같은 범위가 아니다. 이
제안은 established plan의 carry projection만 다루고 lazy personal-plan
provisioning은 별도 legacy debt로 기록한다.

## PR 1 — carry projection을 stale하지 않은 pure read로 변경

권장 제목:

```text
fix(vacay): keep carry projection read-only
```

### 범위

- **구현 전에** maintainer가 legacy `carried_over`의 authoritative 의미를
  확인한다. 권장안은 이전 기간 allowance와 실제 사용에서 carry를 요청 시
  계산하고 다음 연도 row에 쓰지 않는 pure projection이다.
- 다음 연도 row가 이미 있어도 이전 기간 entry·allowance 변경을 다음 stats에
  반영한다. UPSERT만 제거해 stale 값을 남기는 수정은 금지한다.
- REST `GET /api/addons/vacay/stats/:year`와 MCP `get_vacay_stats`가 같은 pure
  projection을 사용하게 유지한다.
- response shape와 carry 외의 산술은 유지한다. 기존 row가 stale했다면 carry
  수치는 의도적으로 교정될 수 있다.
- `GET /plan`의 legacy lazy provisioning은 별도 제품 계약이므로 이 PR에 넣지 않는다.
- carry 확정 command, expiry/FIFO 또는 전체 ledger 모델은 별도 논의로 남긴다.

### RED specification

수정 대상:

- `server/tests/unit/nest/vacay.service.test.ts`
- `server/tests/integration/vacay.test.ts`
- `server/tests/unit/mcp/tools-vacay.test.ts` 또는 현재 MCP Vacay owning suite

테스트:

1. established personal plan에 현재 연도와 다음 연도 row를 seed한다.
2. service test는 관련 row snapshot과 `SELECT total_changes()`를 저장한다.
3. `getStats()` 뒤 response와 `total_changes()` 및 row snapshot이 불변인지
   확인한다.
4. 다음 연도 row를 만든 뒤 이전 연도 entry/allowance를 변경하고 다음 연도
   stats가 새 carry를 반환하면서 row를 쓰지 않는지 확인한다.
5. REST/MCP integration은 session, request audit 같은 비-Vacay write가 있을 수
   있으므로 global `total_changes()` 대신 정확한 Vacay table snapshot을
   비교한다.
6. personal plan이 없는 첫 GET의 lazy provisioning은 별도 characterization
   test로 남겨 이 PR의 pure carry 주장과 섞지 않는다.
7. read-only MCP annotation과 established-plan DB 동작이 일치함을 확인한다.

### 비목표

- plan 최초 조회의 auto-create 제거
- entitlement lot, expiry/FIFO와 법정 carry policy 재설계
- employment/ledger schema 추가

## PR 2 — holiday overlay가 개인 entry를 삭제하지 않도록 변경

권장 제목:

```text
fix(vacay): preserve entries under holiday overlays
```

### 범위

- company holiday 추가·활성화 시 `vacay_entries`를 삭제하지 않는다.
- public holiday refresh 시 `vacay_entries`와 수동 company holiday를 삭제하지
  않는다.
- entry와 holiday가 겹치면 둘 다 보존한다.
- 영속된 수동 company holiday와 겹친 vacation entry만 기존 “비차감” 의미로
  projection한다.
- provider 날짜를 영구 저장하지 않는 현재 구조에서는 public holiday의 과거
  비차감을 재현할 수 없다. 이 PR은 provider entry 보존만 보장하고 public
  occurrence 저장·conflict resolution·비차감은 별도 PR로 남긴다.

### RED specification

수정 대상:

- `server/tests/unit/nest/vacay.service.test.ts`
- `server/tests/integration/vacay.test.ts`

기존 `VACAY-SVC-036`, `VACAY-SVC-047`을 반대로 고정한다.

1. 사용자 A와 B가 같은 날짜에 서로 다른 fraction/kind entry를 가진다.
2. company holiday를 추가·제거해도 두 entry의 ID, 날짜, fraction, kind가
   그대로다.
3. provider가 global holiday를 반환해도 entry와 수동 company holiday가
   그대로다.
4. 영속된 수동 company holiday가 활성인 동안 stats used/carry에서 해당 vacation
   entry가 제외되고, holiday 제거 뒤 같은 entry가 다시 계산에 포함된다.
5. public provider refresh는 entry를 보존한다. durable occurrence가 없으므로
   재시작 뒤 historical 비차감까지 보장한다고 주장하지 않는다.
6. provider refresh를 반복해도 row count와 entry 내용이 변하지 않는다.
7. 다른 plan의 같은 날짜 row는 절대 변경되지 않는다.

### 비목표

- public holiday provider 데이터의 새 저장 schema
- public holiday의 immutable historical non-deduction
- annual-leave substitution과 paid company day를 자동 판정하는 정책
- holiday conflict UI

## PR 3 — fusion/dissolution에서 user-year 상태 보존

권장 제목:

```text
fix(vacay): preserve user-year state after plan dissolution
```

### 범위

- member가 fusion 중 사용한 최신 `vacation_days`와 `carried_over`를 해제 시
  개인 plan에 transaction으로 upsert한다.
- owner가 plan 전체를 dissolve하는 경로와 member가 나가는 경로를 모두 다룬다.
- member가 나갈 때 shared plan의 해당 user-year row를 제거하거나, 재가입 시 개인
  최신값을 authoritative하게 upsert한다. `INSERT OR IGNORE`로 stale shared
  값을 재사용하지 않는다.
- entry 이동, membership 삭제와 user-year 복구가 하나의 transaction에서
  성공하거나 함께 rollback한다.
- fusion의 광범위한 cross-user edit 권한은 신규 access-model 논의로 분리한다.

### RED specification

수정 대상:

- `server/tests/unit/nest/vacay.service.test.ts`
- `server/tests/integration/vacay.test.ts`

테스트:

1. member 개인 plan에 이전 값을 seed하고 owner plan에 초대한다.
2. fusion plan의 member user-year를 다른 allowance/carry로 변경한다.
3. member self-dissolve 뒤 개인 plan이 최신 값을 가진다.
4. owner dissolve 뒤 모든 member의 개인 plan이 각자의 최신 값을 가진다.
5. 다른 사용자의 user-year와 owner 값은 섞이지 않는다.
6. 중간 upsert를 강제로 실패시키면 entry, membership, user-year가 모두
   사전 상태로 rollback된다.
7. 재호출해도 중복 user-year row가 생기지 않는다.
8. join → fused edit → leave → solo edit → 같은 plan rejoin 뒤 개인 최신값이
   유지되고 stale shared member row가 없다.

### 비목표

- fusion을 새 employment access 모델로 대체
- 기존 plan 간 모든 데이터를 v2로 migration
- cross-user edit 권한 변경

## PR 4 — trip 변경이 출처 없는 Vacay entry를 이동하지 않도록 변경

권장 제목:

```text
fix(trips): stop moving unrelated vacay entries
```

### 범위

- trip 시작일을 바꿀 때 날짜 범위가 겹친다는 이유만으로 개인 Vacay entry를
  이동하지 않는다.
- `shiftOwnerEntriesForTripWindow` import/call과 단독 bridge 소비를 제거하거나
  maintainer가 원하는 최소 surface만 비활성화한다.
- 향후 명시적 `source_trip_id` 연결과 이동 확인 UI는 별도 feature다.

현재 schema에는 trip linkage가 없고 trip 생성 시 Vacay entry를 만드는 경로도 없다.
따라서 어떤 entry가 해당 trip에 속하는지 증명할 수 없으며, 이동하지 않는 것이
안전한 기본값이다.

### RED specification

수정 대상:

- `server/tests/unit/services/tripService.test.ts`
- `server/tests/unit/mcp/tools-trips.test.ts`
- `server/tests/unit/nest/vacay.service.test.ts`

테스트:

1. trip 소유자의 기존 trip 기간 안과 밖에 Vacay entry를 seed한다.
2. REST/service와 MCP로 trip 날짜를 이동한다.
3. 모든 Vacay entry의 ID·날짜·fraction·kind가 그대로다.
4. trip day/reservation/accommodation의 기존 `date_shift_mode` 계약은 그대로
   통과한다.
5. 다른 사용자의 entry와 fused plan entry도 변하지 않는다.

### 비목표

- trip-linked leave 생성
- `source_trip_id` migration
- reservation/day shift 동작 변경

## 실행 순서

네 PR 사이에 코드 의존성은 거의 없지만 data loss 가능성을 기준으로 다음 순서를
권장한다.

1. holiday entry 보존
2. stats read purity
3. fusion/dissolution state 보존
4. unrelated trip shift 제거

Maintainer가 한 범위만 원하면 그것만 구현한다. 한 브랜치에서 네 수정 모두를 만든
뒤 나누는 방식은 사용하지 않고, 각 PR을 최신 `upstream/dev`에서 새 worktree로
시작한다.

## Discord 초안 1 — correctness 범위 확인

아래 메시지는 게시하지 않은 초안이다.

```text
Hi! I reviewed the current Vacay implementation on dev while designing a
generic employment/leave-period extension. Before proposing any feature work,
I found four small data-correctness behaviours that seem worth fixing
independently:

1. get_vacay_stats / GET stats is annotated/read as read-only but upserts next
   year's carried_over value.
2. Adding or refreshing company/public holidays physically deletes existing
   personal Vacay entries.
3. Fusion moves a member's user-year state into the shared plan, but dissolution
   only moves entries back, so the latest allowance/carry state can be lost.
4. Editing a trip start date shifts every owner Vacay entry in the old date
   window even though entries have no trip link.

I would keep each fix in a separate PR, preserve existing response shapes, add
focused regression/negative tests, and avoid unrelated refactors. For #1 I
would not simply remove the write: the next-year value must still reflect later
changes to the previous year, preferably through a pure projection. For #2 I
would preserve every entry and retain non-deduction for durable manual company
holidays. Public-provider dates are not currently stored, so durable public
holiday projection should be a later occurrence-model PR. For #3 I would cover
leave/solo-edit/rejoin so a stale shared row cannot win. For #4 my suggested
safe behaviour is to stop moving unlinked entries; explicit trip linking could
be a later feature.

Would any of these PRs be welcome? If so, which single one should I start with,
and is there a preferred authoritative behaviour for the stats carry
projection? I also noticed that first plan lookup lazily provisions legacy
rows; I would keep that separate from the established-plan carry fix.
```

## Discord 초안 2 — generic v2 방향

Maintainer가 feature 방향도 요청한 경우에만 이어서 보낸다.

```text
Separately, would you be open to a staged generic Vacay model for users who
change employers or leave-year policies over time?

The product boundary would remain a personal leave/travel availability tracker,
not HR approval, payroll, attendance, or a legal-compliance engine. The first
usable slice would target one employer and one explicit current leave period,
with an as-of opening balance and full/half-day planned/taken entries. The
generic core would keep immutable period and minute-basis snapshots. Sharing,
automatic migration, and automatic carry/expiry would be later slices.

Country-specific rules (for example Korean statutory accrual suggestions) would
live behind a policy-provider contract and would only create user-confirmed
proposals, never automatic legal entitlements.

I would propose one backwards-compatible change per PR (schema invariants,
self-only API, balance commands, confirmed importer, then UI), starting with
only the smallest model/compatibility seam the maintainers prefer. Is that
direction within TREK's scope, or should it remain an external plugin/fork
feature?
```

## 게시 전 확인

- 최신 `upstream/dev`를 fetch하고 `CONTRIBUTING.md`, PR template,
  target-branch workflow를 다시 읽는다.
- 이미 같은 issue/PR/discussion이 생겼는지 확인한다.
- 첫 메시지만 게시하고 maintainer 응답 전에 구현하지 않는다.
- Discord 승인 URL 또는 maintainer 지시를 후속 branch/PR 기록에 남긴다.
- TOM의 별도 명시 승인 전에는 공식 저장소 push나 PR을 생성하지 않는다.
