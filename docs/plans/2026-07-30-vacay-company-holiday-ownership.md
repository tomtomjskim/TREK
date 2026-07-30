# Vacay Company Holiday Ownership Decision

> 작성일: 2026-07-30
> 상태: 설계 승인, 구현·migration·배포 보류
> 포크 기준: `origin/main` `c5ff1d27`, R0 보존 pilot `c76e6fcd`
> 공식 비교: `upstream/dev` `57017b8a`,
> `upstream/feat/vacay-leave-and-year` `1474b3f3`
> 관련 설계:
> [Vacay employment and balance design](2026-07-28-vacay-employment-balance-design.md)

## 결정

회사 휴일은 Vacay plan이나 trip의 설정이 아니라 **사용자 재직기간
(`Employment`)의 데이터**다.

- 기본 작성자는 해당 employment의 소유 사용자 한 명이다.
- fusion은 캘린더 표시 그룹일 뿐 회사·재직·휴일 소유권을 넘기지 않는다.
- trip owner·participant 여부는 Vacay 회사 휴일 권한과 무관하다.
- 일반 로그인 사용자는 본인 employment의 휴일만 작성·수정·삭제한다.
- TREK server admin은 addon 활성화와 provider 운영 설정을 관리할 수 있지만,
  그 지위만으로 사용자 회사 휴일을 조회·변경하지 않는다.
- 같은 회사의 휴일을 여러 사용자가 공동 관리하는 기능은 후속
  `EmploymentHolidayCalendar`와 명시적 `manager | editor | viewer` grant로
  설계한다. fusion, trip membership, email domain 또는 server admin을 그 grant로
  추론하지 않는다. 이 역할은 공유 calendar occurrence만 관리하며, 각 사용자의
  `balance_treatment` 확인 권한은 갖지 않는다.

따라서 현재 plan-wide 회사 휴일을 단순히 plan owner 또는 server admin만
변경하도록 제한하는 안은 채택하지 않는다. 그 방식은 한 plan에 서로 다른 회사의
사용자가 참여할 때 누구의 회사 휴일인지 결정하지 못하며, 개인 사용자가 자기 회사
휴일을 관리하려면 불필요하게 관리자에게 의존하게 한다.

## 현재 구현의 증거와 한계

2026-07-30 최신 공식 비교에서도 회사 휴일 소유권은 바뀌지 않았다.

- `vacay_company_holidays`는 `plan_id`, `date`, `note`만 저장하고
  `(plan_id, date)`를 유일하게 취급한다.
- `POST /addons/vacay/entries/company-holiday`는 인증 사용자의 active plan을
  찾은 뒤 plan-wide row를 toggle한다.
- plan holiday calendar 추가·수정·삭제도 active plan 범위이며, plan owner
  전용 검사가 없다.
- fusion 구성원은 다른 구성원의 entry·allowance도 target user 방식으로 바꿀 수
  있는 legacy 협업 모델을 사용한다.
- `isOwner`는 client state에 있지만 Vacay 회사 휴일 편집 권한으로 사용되지 않는다.
- fusion 해제는 plan-wide 회사 휴일을 각 개인 plan으로 복사한다.

R0 `c76e6fcd`는 이 legacy 구조에서 휴일 변경이 개인 entry를 삭제하지 않도록
보존하고 기존 비차감 projection을 재현한 correctness seam이다. 이 patch는
plan-wide 휴일을 올바른 개인 회사 데이터로 승격하거나 mixed-company fusion
권한을 해결한 것으로 해석하지 않는다.

## 목표 데이터 경계

`EmploymentHoliday`는 정확히 하나의 `Employment`에 속한다.

필수 계약은 다음과 같다.

- `employment_id`, `date`, `kind`, `balance_treatment`
- manual/provider source identity와 provenance
- observed/effective date, active/superseded 상태
- 생성·확정 actor와 aggregate revision
- `public_holiday | paid_company_day | annual_leave_substitution | unknown`
- `pending | non_deduct | deduct`

날짜는 strict `YYYY-MM-DD`로 검증하고 employment timezone과 coverage 안에 있어야
한다. provider occurrence는 처음에 `pending`이며 사용자 확인 전 entry나 잔액을
바꾸지 않는다. 수동·provider 휴일 모두 entry를 물리적으로 삭제하지 않는다.

회사명, 재직기간, 휴일 이름·종류와 잔액 처리 방식은 기본적으로 본인 데이터다.
공유 상대에게는 별도 `EmploymentAccess`가 있을 때에도 busy date만 보낸다.
public/school/company calendar subscription과 `company_holidays_enabled` 같은
적용 설정도 target에서는 plan이 아니라 employment에 속한다.

후속 공동 calendar가 생기면 calendar occurrence source와 개인
`EmploymentHoliday` projection을 분리한다. manager가 source 날짜·label을
바꿔도 각 사용자의 `pending | non_deduct | deduct` 확인값을 대신 정하지 않는다.

## 권한 행렬

| 동작                            | employment 본인        | fusion 상대        | trip 참여자 | 타 로그인 사용자   | server admin   | 명시적 회사 캘린더 manager |
| ------------------------------- | ---------------------- | ------------------ | ----------- | ------------------ | -------------- | -------------------------- |
| 본인 회사 휴일 CRUD             | 허용                   | 불가               | 불가        | 불가               | 자동 우회 불가 | 불가                       |
| 타인 회사 휴일 조회·변경        | 불가                   | 불가               | 불가        | 불가               | 자동 우회 불가 | 후속 grant 범위만          |
| 타인 busy date 조회             | 본인 조회              | 명시적 access 필요 | 불가        | 명시적 access 필요 | 자동 우회 불가 | 별도 access 필요           |
| addon 활성화·provider 운영 설정 | 불가                   | 불가               | 불가        | 불가               | 허용           | 불가                       |
| 개인 balance treatment 확인     | 본인 employment만      | 불가               | 불가        | 불가               | 자동 우회 불가 | 불가                       |
| 후속 공유 calendar source CRUD  | 연결된 본인 calendar만 | 불가               | 불가        | 불가               | 자동 우회 불가 | grant scope만              |

REST, MCP와 host-mediated plugin command는 같은 application-service policy를
사용한다. client에서 버튼을 숨기는 것만으로 권한을 보장하지 않는다. 다른
사용자의 employment ID를 넣은 요청은 정보 노출 없이 거부하고, unsupported plugin
write는 fail-closed한다.

긴급 운영자 대리 수정이나 감사 조회가 실제로 필요해지면 break-glass 사유,
범위, 만료와 audit event를 가진 별도 기능으로 설계한다. R1의 일반 admin 권한에
포함하지 않는다.

## UI 계약

- Vacay 설정의 “회사 휴일”은 “선택한 재직처의 내 회사 휴일”로 표현한다.
- 본인 employment context에서만 회사 휴일 편집 mode를 활성화한다.
- fusion 상대를 선택해 캘린더를 보는 동안에는 그 상대의 회사 휴일 편집 control을
  렌더링하지 않는다.
- 다른 사용자에게 보이는 busy projection에는 회사명, 휴일명·종류, 출처,
  잔액 처리와 note를 포함하지 않는다.
- server admin 화면에는 addon/provider 상태와 운영 오류만 두고 사용자별 휴일
  편집기를 두지 않는다.
- 공동 회사 캘린더는 R1 비목표다. 향후 추가하더라도 개인 calendar로 복사하는
  대신 명시적으로 연결하고, 사용자는 occurrence별 처리 방식을 확인할 수 있어야
  한다.

## 현행 v1 안전 경계

v2 activation 전에는 plan-wide row를 회사 사실로 표시하지 않고 legacy shared
overlay로 취급한다.

- solo plan은 현재 동작을 개인 legacy overlay로 계속 사용할 수 있지만,
  employment 귀속과 확정된 법적·회사 사실을 보장한다고 표시하지 않는다.
- fused plan에서는 서로 다른 회사일 수 있으므로 회사 휴일 편집을 plan
  owner/admin에게 넘기지 않는다. 로컬 R0.1은 company mode와 설정을 read-only로
  표시하고 모든 write surface를 fail-closed한다.
- 기존 row와 개인 entry는 보존한다. 권한 모델을 고친다는 이유로 자동 삭제·복제·
  재분류하지 않는다.
- 현재 R0 비차감은 fused plan 전체에 적용되는 호환 projection이며, 사용자별
  정확한 회사 휴일 계산으로 표현하지 않는다.

### R0.1 로컬 구현 경계

`fix/vacay-preserve-holiday-entries`의 후속 로컬 commit은 schema 변경 없이 다음
호환 경계를 적용한다.

- `getPlanUsers(planId).length > 1`인 accepted fusion만 read-only로 판정한다.
  pending invite는 solo 동작을 막지 않는다.
- 수동 회사 휴일 toggle과 `company_holidays_enabled` 변경은 core service에서
  DB write·carry 재계산·WebSocket broadcast 전에 거부한다.
- REST는 `409`와
  `VACAY_FUSED_COMPANY_HOLIDAYS_READ_ONLY`, MCP는 tool error, plugin RPC는
  `RESOURCE_FORBIDDEN`을 반환한다.
- 반응형 calendar의 회사 모드와 설정 toggle만 비활성화한다. 공휴일 calendar,
  이월, 주말 등 다른 설정과 기존 row 조회는 유지한다.
- solo plan은 기존 R0 보존·비차감 동작을 유지한다.

이 경계는 새 의미 오염을 줄이지만 기존 fused row의 귀속이나 plan-wide 비차감
projection을 수정하지 않는다. 로컬 브랜치 검증만 수행하며 개인 포크 push,
`main` 통합, 운영 배포와 공식 게시/PR은 별도 승인 전까지 제외한다.

## Legacy plan holiday 이관

현재 row에는 작성자와 회사가 없으므로 startup migration에서 회사 사실로
자동 확정할 수 없다. 모든 기존 row는 우선
`legacy_plan_overlay/unverified` candidate로만 읽는다.

### Solo plan

1. 사용자의 단일 confirmed employment와 날짜 coverage가 맞으면 claim 후보를
   preview할 수 있다.
2. 후보는 사용자 확인 전 `pending`이고 잔액을 재해석하지 않는다.
3. employment가 없거나 여러 후보가 있거나 coverage가 맞지 않으면
   `review_required`다.
4. 사용자가 claim·처리 방식을 확인한 뒤에만 `EmploymentHoliday`를 활성화한다.

### Fused plan

1. 같은 plan이라는 이유로 구성원이 같은 회사라고 추론하지 않는다.
2. shared row를 모든 구성원의 회사 휴일로 자동 복제하거나 활성화하지 않는다.
3. 각 사용자는 자기 employment에 대해 같은 legacy source를 독립적으로
   claim 또는 reject할 수 있다.
4. R1 connected-fusion activation은 계속 막는다. 사용자가 검증된 dissolve
   경로로 solo가 되거나, R1+의 `EmploymentAccess`와 cohort protocol이 구현될
   때까지 legacy v1을 유지한다.

Importer는 source plan/row, target user/employment, status, source checksum과
provenance를 저장한다. `(source row, target employment)`은 idempotent해야 하며
repeat·중단 후 재개가 같은 preview를 만들어야 한다. 최종 transaction은 source
checksum, revision, membership과 target ownership을 다시 검사한다.

legacy table과 row는 activation 뒤에도 최소 두 release 동안 삭제하지 않는다.
새 모델이 도입된 뒤 dissolve가 legacy shared holiday를 각 개인 employment로
무조건 복사해서는 안 된다.

## Rollback과 rollout

- 첫 v2 write 전: code-only rollback과 staged candidate 폐기가 가능하다.
- preview/reconciliation 중: v1 write를 유지하고 source 변경 시 새 preview를
  요구한다.
- activation과 첫 v2 write 뒤: legacy dual-write로 돌아가지 않고 forward-fix한다.
- DB 복구는 WAL 포함 backup, maintenance window와 restore rehearsal 뒤에만 한다.
- mixed-company fusion cohort에는 shadow comparison과 attribution report 없이
  자동 activation하지 않는다.

현재 lane은 generic core의 장기 `upstream-contrib` 후보이면서, 구현을 시작할
경우 개인 포크의 `fork-core` pilot이다. native DB transaction, Vacay UI,
REST/MCP/plugin 권한을 함께 바꾸므로 plugin-only 기능으로 분리하지 않는다.
공식 게시·PR, 개인 포크 push, `main` 통합과 운영 배포는 별도 승인 전까지
수행하지 않는다.

## 구현 전 수용 기준

1. 본인은 자기 employment 휴일을 CRUD할 수 있고 다른 employment 요청은 모든
   surface에서 거부된다.
2. plan owner, fusion member, trip owner/participant와 server admin 지위가
   employment 휴일 write를 자동 허용하지 않는다.
3. 엄격한 날짜·coverage·revision 검증과 idempotent command가 적용된다.
4. provider refresh와 수동 휴일 변경은 어떤 개인 entry도 삭제하지 않는다.
5. pending occurrence는 잔액을 바꾸지 않고, 사용자가 확인한 occurrence만
   projection에 반영된다.
6. solo legacy 후보는 명시적 사용자 확인 전 활성화되지 않는다.
7. fused legacy row는 모든 구성원에게 자동 귀속되지 않는다.
8. importer fresh/upgrade/repeat/interruption 결과와 checksum이 일관된다.
9. dissolve와 rejoin이 이미 확정된 employment holiday를 복제·손실하지 않는다.
10. busy projection에서 회사·휴일·잔액 metadata가 노출되지 않는다.
11. REST, MCP, plugin과 WebSocket의 negative permission 결과가 일치한다.
12. migration fresh/current/replay/crash와 backup/restore rehearsal이 통과한다.

## 적대 검토 결과

```text
Review result: pass (설계·계획 gate)
Blockers: 0
Major residual risks: 4
Decision: 문서 확정 가능, 구현·migration·배포는 후속 승인 전 보류
```

1. **fused 연도 삭제 권한:** `deleteYear`는 REST/MCP/UI에서 해당 plan의
   사용자 entry, user-year와 회사 휴일을 한꺼번에 삭제한다. R0.1의 직접
   회사 휴일 mutation guard 범위가 아니므로 배포 전에 별도 R0.2에서 fused
   삭제 권한, 확인 UX와 negative test를 결정한다.
2. **현재 fused v1 의미 오염:** R0.1이 새 mutation은 fail-closed하지만 기존
   plan-wide row와 비차감은 모든 구성원에게 계속 적용된다. 소유자를 복원할
   증거가 없으므로 자동 attribution을 금지하고 v2 importer에서 명시적으로
   확인한다.
3. **운영자 지원 요구 미확정:** server admin의 사용자 데이터 대리 수정이 향후
   필요할 수 있다. 일반 admin 우회로 열지 않고 실제 요구가 확인될 때
   break-glass·audit 계약을 별도 검토한다.
4. **공동 회사 calendar 비목표:** 같은 회사 사용자의 중복 입력을 줄이는 기능은
   유용하지만 R1에 넣으면 권한과 개인 잔액 확정이 다시 섞인다. source calendar
   역할과 개인 projection을 분리하는 후속 기능으로 유지한다.

이 PASS와 R0.1은 employment 소유권 모델이 구현됐다는 뜻이 아니다. R0 보존
patch와 fused mutation guard는 유효하지만 legacy plan-wide 모델은
transitional이며, Task 8A 이전에는 employment holiday의 self-only 보장을
주장하지 않는다.
