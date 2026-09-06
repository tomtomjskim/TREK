# TREK Project Documentation

이 디렉터리는 공식 사용자 문서를 복제하지 않고, `tomtomjskim/TREK` 포크를
유지·검증·배포하는 데 필요한 프로젝트 문서의 진입점만 제공한다.

## Current baseline

| 기준                     | 현재 값                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| 애플리케이션 버전        | `4.2.0+jsnetworkcorp.13c4a137`                                          |
| 공식 release 기준        | exact `v4.2.0` peeled commit `09ce5cb733bb681c992dfd4f029706718aae58cc` |
| 포크 runtime source      | `13c4a137751c53382a58521434657923e34c5080`                              |
| 포크 `main` 검증 기준    | `13c4a137`: core CI 10 jobs 성공, Sonar token 미설정으로 Scan만 실패    |
| 운영 image               | `trek:4.2.0-jsnetworkcorp-13c4a137`                                     |
| 즉시 code-only rollback  | `trek:4.2.0-jsnetworkcorp-e258a7b8` (동일 schema/fork ledger)            |
| pre-v4.2 rollback pair   | `trek:3.4.1-jsnetworkcorp-7a50356e` + 배포 직전 stopped-point snapshot  |

현재 runtime은 공식 v4.2.0에 공개 공유 장소 메모, keyless OpenFreeMap fallback,
addon modular gate, restore/session/offline 격리를 적용한 포크 release source
`13c4a137` 기준이다. 이 source와 후속 테스트·CI 보정은 개인 포크 `main`에 반영됐고,
운영 image는 검증된 release source로 고정했다. 공식 upstream PR은 수행하지 않았으며
후속 테스트·문서 commit은 runtime contract를 바꾸지 않는다.
현재 운영·롤백 상태는 별도 운영 위키가, 코드와 Git 이력은 이 저장소가 source of
truth다.

## Maintainer map

- [Project source map](project-source-map.md): runtime 진입점, 디렉터리 책임,
  요청·데이터 흐름, 포크 hotspot과 검증 경로
- [Fork and upstream strategy](upstream/README.md): 저장소 역할, 변경 lane,
  migration namespace와 release 통합 절차
- [Fork extension manifest](upstream/fork-extension-manifest.md): v4.2.0에 유지하는
  addon/config/always-on/instance-only 기능의 소유 seam, 검증과 제거 조건
- [Fork-first validation policy](upstream/fork-first-validation-policy.md):
  로컬·개인 포크 검증 범위, 원격 작업 경계, 코드 컨벤션과 향후 공식 기여 재개 조건
- [v4.1.1 integration design](plans/2026-09-01-upstream-v4.1.1-integration-design.md) ·
  [implementation plan](plans/2026-09-01-upstream-v4.1.1-integration.md) ·
  [evidence](plans/2026-09-01-upstream-v4.1.1-integration-evidence.md): unsigned exact tag,
  159개 conflict, schema 175→200과 포크 변경 보존을 조건부 GO로 관리했던 중간 격리
  계약. 당시 NO-GO 조건은 후속 v4.2.0 통합에서 충족됐다.
- [v4.2.0 incremental preflight](plans/2026-09-04-upstream-v4.2.0-incremental-preflight.md):
  2026-09-03 공개된 새 latest tag를 v4.1.1 중간 checkpoint에 증분 통합하기 위한 87 commits,
  605 files, schema 200→205, 42 conflict 감사와 격리 실행 순서. 당시 direct landing
  NO-GO 조건은 아래 landing evidence에서 충족됐다.
- [v4.2.0 main landing design](plans/2026-09-05-v4.2.0-main-landing-design.md) ·
  [implementation plan](plans/2026-09-05-v4.2.0-main-landing.md): addon surface를
  REST/MCP/desktop/mobile/admin에서 함께 닫고, OpenFreeMap을 유지하며, 이전 image와
  logical-point backup을 한 쌍으로 복원하는 승인된 랜딩 절차
- [v4.2.0 integration evidence](plans/2026-09-04-upstream-v4.2.0-integration-evidence.md):
  fork `main` fast-forward/push, 불변 ARM64 image, schema 175→205 migration rehearsal,
  운영 배포와 rollback pair까지 연결한 최종 증거 원장
- [Optional Sonar provider design](plans/2026-09-07-fork-optional-sonar-design.md) ·
  [implementation plan](plans/2026-09-07-fork-optional-sonar.md): Sonar를 instance-only CI
  provider adapter로 두고 `SONAR_ENABLED` default-skip, same-workflow coverage artifact 재사용,
  fail-closed preflight, badge 제거와 detach/rollback 계약을 고정한 문서. 격리 브랜치 run
  `34048321284`에서 core 10 jobs 성공, Optional Sonar Scan skip, workflow success를 확인했다.
- [v4.1.1 fork preservation matrix](plans/2026-09-01-upstream-v4.1.1-preservation-matrix.md):
  DB, packing privacy, Google 비용, Vacay 데이터 안전, 지도/Fold/calendar, Android와
  Trip/Journey 공개 공유 동작을 새 v4 owner module의 RED/GREEN 증거에 연결하는 누락 방지 원장
- [Public shared place notes design](plans/2026-09-01-public-share-place-notes-design.md) ·
  [implementation plan](plans/2026-09-01-public-share-place-notes.md) ·
  [evidence](plans/2026-09-01-public-share-place-notes-evidence.md): 공개 지도·계획의
  `places.notes` projection/표시, 전체 anonymous DTO exact allowlist, 개인 메모 오표기와
  `share_map=false` 비노출 계약. `0842e229` + `c3b8e18f` local VERIFIED
- [CARTO basemap runtime diagnosis](plans/2026-09-04-carto-basemap-runtime-diagnosis.md):
  이전 운영의 빈 지도 설정이 keyless CARTO 기본값으로 연결되는 원인, 비밀값 비노출
  운영 집계, 실제 워터마크 재현과 v4.2.0의 encrypted-key/OpenFreeMap fallback 계약
- [Vacay correctness extraction dossiers](upstream/vacay-correctness-extraction.md):
  최신 공식 Nest 경로에 다시 구현할 데이터 보존 후보와 공식 contract와 충돌하는
  포크 정책 변경을 제출 단위별로 분리한 자료
- [v3.4.x integration evidence](plans/2026-07-19-upstream-v3.4-integration-evidence.md):
  통합·테스트·이미지·배포·PR closeout 증거
- [Client test warning cleanup](plans/2026-07-20-client-test-warning-cleanup.md):
  Vitest 환경, MSW 기본 계약과 React 비동기 테스트 경고 정리 기준
- [PlaceInspector Hook order fix](plans/2026-07-20-client-lint-hook-order.md):
  전체 lint 경고 분류와 nullable place 선택 전환의 Hook 순서 회귀 기준
- [Bulk place delete null guard](plans/2026-07-21-client-lint-optional-chain-guard.md):
  선택·비선택·orphan assignment 보존 계약과 optional-chain lint 오류 게이트
- [Client unused-expression toggles](plans/2026-07-21-client-lint-unused-expressions.md):
  Admin·day·mobile route Set 왕복 동작과 unused-expression lint 오류 게이트
- [Client useless-assignment cleanup](plans/2026-07-21-client-lint-useless-assignment.md):
  Costs currency fallback·Tooltip placement 계약과 redundant-assignment lint 오류 게이트
- [Client this-alias cleanup](plans/2026-07-22-client-lint-this-alias.md):
  PlaceAvatar observer callback·disconnect 계약과 test mock alias lint 오류 게이트
- [Custom version SemVer comparison](plans/2026-07-23-custom-version-semver-comparison.md):
  포크 build metadata를 보존하면서 공식 release update와 관리자 알림을 판정하는 계약
- [Packing template admin submission guard](plans/2026-07-27-packing-template-admin-submission-guard.md):
  생성·이름 변경 exact-once, 상세 응답 경합과 관리자 집계 배지 동기화 계약
- [Vacay employment and balance design](plans/2026-07-28-vacay-employment-balance-design.md):
  회사·입사일 기준기간, opening balance, planned/taken 상태, self-only 권한과
  한국 정책 provider 경계
- [Vacay employment and balance adversarial review](plans/2026-07-28-vacay-employment-balance-adversarial-review.md):
  한국 휴가 도메인·제품 UX·아키텍처 blocker와 균형형 최소 수직 기능 결정
- [Vacay upstream correctness proposal](plans/2026-07-28-vacay-upstream-correctness-proposal.md):
  fresh carry projection, holiday 보존·비차감, fusion 재가입과 무관한 trip
  shift를 분리한 공식 Discord 제안과 RED specification
- [Vacay employment and balance implementation plan](plans/2026-07-28-vacay-employment-balance.md):
  Discord gate 뒤 독립 correctness PR과 generic v2 slice를 실행하는 TDD 순서
- [Vacay holiday entry preservation](plans/2026-07-29-vacay-holiday-entry-preservation.md):
  회사·public holiday overlay가 개인 입력을 삭제하지 않도록 하는 fork-first R0 증거
- [Vacay company holiday ownership](plans/2026-07-30-vacay-company-holiday-ownership.md):
  회사 휴일을 plan/admin 설정이 아닌 개인 employment 데이터로 소유하고,
  mixed-company fusion legacy row를 명시적으로 확인·이관하는 권한 계약
- [Vacay fused company holiday guard](plans/2026-07-30-vacay-fused-company-holiday-guard.md):
  융합 plan의 회사 휴일 변경을 service·REST·MCP·plugin RPC·반응형 UI에서
  실패-폐쇄하는 R0.1 호환 경계
- [Vacay year deletion safety](plans/2026-07-30-vacay-year-deletion-safety.md):
  연도 전체 삭제를 actor-aware·원자적 명령으로 바꾸고 fusion·초대·legacy
  멤버십을 실패-폐쇄하며 연쇄 이월과 반응형 확인 UX를 검증한 R0.2 경계
- [Vacay invite year reconciliation](plans/2026-07-30-vacay-invite-year-reconciliation.md):
  초대 수락이 대상 plan에 없는 과거 연도를 조용히 이관하지 않도록 원자적으로
  차단하고, owner 보완 뒤 같은 초대를 재시도하는 R0.3 경계
- [Vacay invite membership integrity](plans/2026-07-30-vacay-invite-membership-integrity.md):
  초대 전송·수락의 owner/invitee 멤버십 topology를 실패-폐쇄하고 canonical ID와
  실제 변경 뒤에만 발생하는 실시간 이벤트를 고정한 R0.3a 경계
- [Vacay pre-deployment hardening](plans/2026-07-31-vacay-predeploy-hardening.md):
  carry 연속성·달력 검증·초대 이관/취소 권한·transaction 후 알림을 통합 검증하고
  전체 테스트와 반응형 브라우저 게이트를 고정한 운영 후보 계약
- [Calendar week-start scope diagnostic](plans/2026-08-03-calendar-week-start-scope-diagnostic.md):
  Vacay plan 전용 주 시작과 공용·Journey picker의 월요일 고정을 추적하고 전역
  사용자 설정으로 확장할 최소 contract와 공식 기여 조건을 정리한 진단
- [Calendar week-start implementation](plans/2026-08-13-calendar-week-start-implementation.md) ·
  [evidence](plans/2026-08-13-calendar-week-start-evidence.md): 사용자별 일요일/월요일
  설정을 공용·Journey·Vacay 달력에 연결하고 legacy Vacay fallback과 fork-first
  검증 경계를 고정한 로컬 구현
- [NestJS module guide](../server/src/nest/README.md): unified Nest 서버 조립,
  domain module 패턴과 테스트 기준
- [Client page pattern](../client/src/pages/PATTERN.md): page container와 data hook 경계

## Product and platform docs

- [Main README](../README.md): 공식 기능·설치 안내. upstream 동기화 대상이므로
  포크 운영 메모를 중복해서 넣지 않는다.
- [Product wiki](../wiki/Home.md): 앱 안에서 제공하는 사용자·관리자 도움말
- [Plugin SDK](../plugin-sdk/README.md): plugin 작성·검증·배포 계약
- [Android TWA](../android/twa/README.md): 앱 identity, Digital Asset Links와 빌드 절차
- [System notices](system-notices.md): 공지 schema와 작성 규칙

## Plans and evidence

`plans/`는 완료된 작업을 포함한 설계·구현·검증 기록이다. 현재 상태는 이 인덱스,
source map, `upstream/README.md`에서 확인하고, 과거 plan의 명령이나 branch 이름을
현재 운영 절차로 그대로 사용하지 않는다.

문서에는 secret, 운영 `.env` 값, DB 원본, 사용자 식별 정보와 민감 로그를 넣지 않는다.
진입점·module ownership·migration 순서·검증 명령이 바뀌면 source map과 관련 세부
문서를 같은 변경에서 갱신한다.
