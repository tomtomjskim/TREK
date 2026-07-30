# TREK Project Documentation

이 디렉터리는 공식 사용자 문서를 복제하지 않고, `tomtomjskim/TREK` 포크를
유지·검증·배포하는 데 필요한 프로젝트 문서의 진입점만 제공한다.

## Current baseline

| 기준                    | 현재 값                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| 애플리케이션 버전       | `3.4.1`                                                              |
| v3.4.x 통합 기준 commit | `86d3e9a01c73f0de1aeaa73031353a2ddb3373cd`                           |
| 운영 runtime source     | `1747b8a63f3182ff404a82f619e56f06c3de42ae`                           |
| 운영 image              | `trek:3.4.1-jsnetworkcorp-1747b8a6`                                  |
| 공식 release 기준       | exact `v3.4.1` tag target `a0994658890eae96624fb9cbe7f55867f047fea2` |

현재 runtime은 공식 v3.4.1 통합과 custom version SemVer correctness patch 위에
packing-template 관리자 exact-once/race guard를 적용한 포크 commit `1747b8a6`
기준이다. 이후의 formatting, CI 설정과 문서 commit은 runtime contract를 바꾸지
않는다.
현재 운영·롤백 상태는 별도 운영 위키가, 코드와 Git 이력은 이 저장소가 source of
truth다.

## Maintainer map

- [Project source map](project-source-map.md): runtime 진입점, 디렉터리 책임,
  요청·데이터 흐름, 포크 hotspot과 검증 경로
- [Fork and upstream strategy](upstream/README.md): 저장소 역할, 변경 lane,
  migration namespace와 release 통합 절차
- [Fork-first validation policy](upstream/fork-first-validation-policy.md):
  로컬·개인 포크 검증 범위, 원격 작업 경계, 코드 컨벤션과 향후 공식 기여 재개 조건
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
