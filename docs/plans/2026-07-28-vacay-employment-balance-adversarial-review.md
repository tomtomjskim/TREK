# Vacay Employment and Balance Adversarial Review

> 작성일: 2026-07-28
> 대상: Vacay v2 설계, upstream correctness 제안, 구현 계획
> 기준: fork `main` `c5ff1d27`, upstream `dev` `292f1b18`
> 결과: 최초 `FAIL` → 3차 blocker closure 후 문서 gate `PASS`
> 구현 상태: source code, migration, 게시, push, PR, 배포 모두 미실행

## 판정

한국 휴가 도메인, 제품·UX, 아키텍처·보안·운영의 세 독립 관점에서
blocker-first 리뷰를 수행했다. 세 리뷰 모두 최초 문서 그대로 구현하는 것은
실패 판정이었다. 공통 원인은 기능 수가 부족해서가 아니라 다음 계약이 닫히지
않았기 때문이다.

- 기준일 잔액과 과거 사용 기록 사이의 이중 차감 경계
- 조회 중 carry 갱신을 제거한 뒤의 다음 기간 산술
- 기간 중 정책 변경과 분 단위 환산 기준
- journal 정정, command 재시도와 동시 편집
- legacy fusion 데이터의 소유권, activation과 롤백
- 회사 휴일, 공유, 상태 전환의 개인정보·UX 의미

보완안은 **균형형 최소 수직 기능**으로 결정한다. 완전한 HR 원장이나 한국
법정 자동 산정은 만들지 않되, 첫 write 전에 필요한 데이터 불변식·권한·감사
경계는 축소하지 않는다.

이 `PASS`는 설계·계획 문서의 material blocker가 닫혔다는 뜻일 뿐 구현 승인이나
실행 성공을 의미하지 않는다. correctness PR의 carry 의미와 feature core 수용
여부는 upstream maintainer가 결정해야 하며, Discord 승인과 TOM의 별도 게시
승인이 없으면 코드를 작성하거나 공식 저장소에 게시하지 않는다.

## 리뷰 루프

| 관점                 | 1차              | 보완 핵심                                                             | 최종 |
| -------------------- | ---------------- | --------------------------------------------------------------------- | ---- |
| 한국 휴가 도메인     | FAIL, 4 blockers | signed opening, cutoff scope, period basis, holiday confirmation      | PASS |
| 제품·UX·접근성·YAGNI | FAIL, 9 high     | 최소 persona, activation 동의, release tag, Fold route와 parity       | PASS |
| 아키텍처·보안·운영   | FAIL, 8 high     | receipt DDL, aggregate revision, writable-v1 cutover, access/rollback | PASS |

최종 재검토는 최신 네 문서와 `upstream/dev` 소스를 읽기 전용으로 대조했다.
material residual은 세 관점 모두 0건이었다. source 구현과 runtime test는 이
리뷰의 범위가 아니다.

closeout fetch 중 upstream이 `351b5fb4`에서 `292f1b18`로 이동해 다시
rebaseline했다. 새 6개 commit은 GPX track colour 범위이며 Vacay service,
contribution rule과 UI route를 바꾸지 않았다. DB migration 하나가 추가됐으므로
구현 계획은 고정 migration 번호 대신 Task 4에서 최신 slot을 다시 읽는 계약을
유지한다. 최신 CI와 root workspace를 기준으로 Task 3에는 `nest-mcp` build/
typecheck/lint/test, strict i18n, client page-pattern과 production require smoke도
추가했다.

## 검토한 접근

| 접근                       | 장점                                               | 실패 위험                                                    | 결정         |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------ | ------------ |
| 최소 문구 수정             | 빠르고 PR 제안이 작다.                             | opening, concurrency, migration 모순이 구현 단계로 넘어간다. | 기각         |
| 균형형 최소 수직 기능      | 개인 도구 범위를 지키면서 회계·권한 경계를 닫는다. | PR 수가 늘고 activation 전까지 단계별 검증이 필요하다.       | **채택**     |
| 완전 entitlement ledger/HR | FIFO·소멸·법정 산정까지 정밀하게 표현한다.         | TREK 범위와 첫 upstream 기여로는 과도하고 유지비가 크다.     | R2 이후 검토 |

첫 persona는 **한 회사에 재직하며 HR이 알려 준 특정일 현재 잔여를 종일·반일로
기록하려는 개인 사용자**다. 첫 제품 release는 단일 재직처, 명시적 현재 기간,
opening cutoff, planned/taken 기록, 비파괴 휴일 overlay와 최소 UI로 제한한다.
공유, 자동 법정 산정, 시간대별 복수 휴가, offline write queue는 후속 release다.

## 정규화된 findings와 처리

| ID  | 심각도 | surface                      | 채택한 처리                                                                                                                                               | 상태      |
| --- | ------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| F1  | HIGH   | carry/read purity            | UPSERT만 제거하지 않는다. 이전 기간 변경 뒤 다음 기간 값을 다시 계산하는 pure projection을 우선 제안하고 회귀 테스트를 요구한다.                          | 닫힘      |
| F2  | HIGH   | holiday/balance              | R0는 entry 보존과 durable manual holiday만 다룬다. public occurrence는 R1에서 pending으로 저장하고 사용자 non-deduct/deduct 확인 전 잔액을 바꾸지 않는다. | 단계 gate |
| F3  | HIGH   | opening baseline             | active opening metadata를 cutoff/scope SSOT로 두고 entry별 balance effect를 저장한다. planned scope와 소급 taken을 분리한다.                              | 닫힘      |
| F4  | HIGH   | policy/quantity              | R1 정책 변경은 다음 leave period부터만 적용한다. period, journal, entry에 당시 `basis_day_minutes`를 snapshot한다.                                        | 닫힘      |
| F5  | HIGH   | audit/concurrency            | receipt DDL과 결과를 domain write/revision과 같은 transaction에 둔다. employment와 leave-period aggregate revision을 구분한다.                            | 닫힘      |
| F6  | HIGH   | schema integrity             | 날짜·소유권·중첩·opening·reversal 불변식을 DB constraint/trigger와 transaction 안의 재검증으로 강제한다.                                                  | 닫힘      |
| F7  | HIGH   | auth/cross-surface           | R1은 self-only·WS 없음·fusion activation 차단이다. EmploymentAccess와 scoped WS 뒤에만 R1+ cohort activation을 허용한다.                                  | 닫힘      |
| F8  | HIGH   | migration/rollback           | v1은 final lock 전까지 writable하다. R1은 solo checksum을 재검사하고, mismatch/cancel은 v1으로 남으며 activation 뒤만 one-way다.                          | 닫힘      |
| F9  | HIGH   | fusion lifecycle             | join/edit/leave/solo-edit/rejoin 전체에서 authoritative user-year와 stale shared row 제거 규칙을 테스트한다.                                              | 닫힘      |
| F10 | HIGH   | scope/YAGNI                  | 제품 release와 PR 단위를 분리하고 수용 기준에 R0/R1/R1+를 태깅한다. R1은 회사 변경·share·custom placeholder도 렌더링하지 않는다.                          | 닫힘      |
| F11 | HIGH   | entry lifecycle/company move | GET은 상태를 쓰지 않고 taken은 cancel+replacement다. 퇴사 뒤 planned는 cancelled audit 또는 새 opening 뒤 재생성만 허용한다.                              | 닫힘      |
| F12 | MED    | legal semantics              | 휴일 종류와 법령 출처 권위 수준을 구분하고, 한국 provider는 사용자 확인형 proposal만 만든다.                                                              | 닫힘      |
| F13 | MED    | UX/a11y/responsive           | Fold를 UI 분할 전에 실측해 route별 검증하고 desktop/mobile parity를 요구한다. draft는 actor/revision scope의 memory-only다.                               | 닫힘      |
| F14 | MED    | verification                 | non-mutating lint, coverage, strict i18n, page-pattern, nest-mcp build/typecheck/test와 production require smoke를 CI 순서로 실행한다.                    | 닫힘      |

## 핵심 계약

### 잔액과 정정

- `BalanceJournal.delta_minutes`는 signed integer다. opening은 선사용 때문에
  signed이고 grant/carry는 양수, expiry는 음수이며 adjustment/reversal은 양수
  또는 음수일 수 있다.
- reversal은 `reverses_journal_id`가 가리키는 원본의 정확한 반대값이다. 한 원본은
  한 번만 reverse할 수 있고 journal row는 update/delete하지 않는다.
- period에는 활성 opening 하나만 허용한다. 교체는 기존 opening reversal과 새
  opening을 같은 transaction에서 기록한다.
- opening의 `usage_included_through`는 사용자 로컬 날짜를 포함하는 cutoff다.
  기본 `usage_scope=taken_only`이며 planned는 차감한다. 사용자가 HR 값이 예정
  사용까지 포함한다고 확인한 경우만 `taken_and_planned`와 대상 preview를
  확정한다.
- cutoff 이전 taken을 나중에 입력할 때는 `opening에 이미 포함`이 기본이고,
  `지금 차감`은 사용자가 명시적으로 선택한다.
- R1 opening replacement는 cutoff/scope를 바꾸지 않는다. 변경은 별도
  rebaseline command와 entry 재분류 preview가 필요하다.

### 시간과 상태

- employment는 IANA timezone을 가진다. 저장 날짜는 employment timezone 기준의
  달력 날짜다.
- `planned`는 시간이 지났다고 자동으로 DB에서 `taken`이 되지 않는다. 조회는
  `needs_confirmation`을 파생하고 사용자가 확인 command를 실행한다.
- planned는 직접 수정할 수 있다. taken은 cancel+replacement로 정정하며
  cancelled는 감사 이력으로 보존한다.
- UI의 시작일·마지막 날은 inclusive로 표시하되 API/DB 기간은 `[start, end)`다.

### Holiday 단계 경계

- R0 correctness는 모든 provider refresh에서 entry를 보존한다.
- 저장된 manual company holiday만 R0에서 재현 가능한 비차감 source다.
- public holiday 비차감은 provider occurrence와 source/version을 durable하게
  저장하는 R1 PR 뒤에만 검토한다. occurrence는 `pending`으로 잔액을 바꾸지 않고,
  사용자가 `non_deduct | deduct`를 확인한 뒤에만 반영한다. live provider
  응답으로 과거 balance/carry를 다시 계산하지 않는다.
- `annual_leave_substitution`은 명시적인 deducting entry 연결 없이 확정하지
  않는다.

### 동시성과 surface

- command receipt key는 `(actor_id, operation, idempotency_key)`이고 request
  payload hash와 결과를 같은 transaction에 저장한다. 같은 key/다른 payload는
  `409`다.
- idempotency는 lost update 방지가 아니다. aggregate `revision` precondition과
  transaction 내부 overlap 재검증을 별도로 사용한다. employment lifecycle은
  employment revision, balance/entry는 leave-period revision을 소유한다.
- R1은 v2 WebSocket을 발행하지 않는다. R1+에서 commit 뒤 민감 정보가 없는
  aggregate ID/revision invalidation을 추가하고, 권한이 철회된 viewer는 event와
  refetch 결과를 받지 못해야 한다.
- R1 offline은 마지막 성공 read와 화면 수명의 memory-only draft만 보존한다.
  persistent browser storage와 server write queue를 만들지 않는다.

### migration과 rollback

상태 머신은
`legacy_active → preview/review_required → reconciled → activation_locked
(transaction only) → activated`다. startup migration은 additive table만 만들며
importer가 source checksum, provenance와 충돌을 기록한다.

- activation 전: v1 write는 계속되고 v2 candidate만 read-only다. importer row를
  폐기하고 `legacy_active`로 취소할 수 있다.
- R1 activation transaction은 solo membership, source checksum과 revision을
  재검사한다. mismatch는 lock을 풀고 `review_required`로 돌아간다.
- connected fusion은 R0 correctness 뒤 self-dissolve해 solo가 되거나
  EmploymentAccess가 생기는 R1+까지 v1을 유지한다.
- activation 뒤: v2가 single-write source다. feature flag는 화면 노출을 끌 수
  있을 뿐 legacy write로 되돌리지 않는다.
- 첫 v2 write 뒤: 기본 복구는 forward-fix다. 전체 DB restore는 maintenance
  window, WAL을 포함한 backup과 restore rehearsal이 있을 때만 사용한다.

legacy plan holiday는 회사 사실로 자동 승격하지 않고
`legacy_plan_overlay/unverified`로 둔다. 사용자가 원본 값·기간·entry 수·예상
잔액·충돌을 확인한 뒤에만 activation한다.

## Architecture readiness

- Gate: `full_gate_required`
- Rollback class: `data_migration`
- 변경 surface: shared schema, SQLite DDL/migration, application service,
  REST, MCP, plugin capability, WebSocket, desktop/mobile UI, importer,
  auth/privacy, backup/restore
- 필수 증거: fresh/upgrade/repeat migration, DB invariant negative tests,
  cross-surface permission matrix, concurrency/receipt tests, reconciliation
  report, rollback rehearsal, responsive/accessibility evidence

## 의도적으로 미룬 항목

- 자동 한국 법정 부여·퇴직 정산
- entitlement lot, FIFO, 자동 carry/expiry
- 동시 active employment
- 같은 날 여러 시간 segment
- 보상휴가 earned/used bank
- busy-date 공유와 WebSocket grant UI
- offline write queue
- opening cutoff/scope를 바꾸는 rebaseline command

MVP의 `comp`는 잔액 검증이 없는 사용자 입력 휴무로만 표시하며 연차 summary와
분리한다. 하루에는 한 개의 활성 휴가 기록만 허용하는 R1 제한을 UI와 API에서
명시하고, 다중 segment는 R2 migration으로 다룬다.

## 남은 외부 결정

1. Maintainer가 legacy carry의 authoritative 의미와 pure projection 방식을
   승인하는가.
2. Employment/period core가 TREK 범위에 속하며 첫 schema-only 또는
   schema+read API slice를 허용하는가.
3. 실제 Fold 7의 CSS viewport를 어떤 orientation/browser 조건으로 수용 fixture에
   고정할 것인가.

이 세 항목은 문서 작성자가 추측해 확정하지 않는다. 1–2는 Discord 답변, 3은
실기기 측정값을 evidence에 기록한다.
