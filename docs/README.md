# TREK Project Documentation

이 디렉터리는 공식 사용자 문서를 복제하지 않고, `tomtomjskim/TREK` 포크를
유지·검증·배포하는 데 필요한 프로젝트 문서의 진입점만 제공한다.

## Current baseline

| 기준                    | 현재 값                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| 애플리케이션 버전       | `3.4.1`                                                              |
| v3.4.x 통합 기준 commit | `86d3e9a01c73f0de1aeaa73031353a2ddb3373cd`                           |
| 운영 runtime source     | `e1be01e27b602b34f307bc8e8a678622b3c91588`                           |
| 운영 image              | `trek:3.4.1-upstream-integration-e1be01e`                            |
| 공식 release 기준       | exact `v3.4.1` tag target `a0994658890eae96624fb9cbe7f55867f047fea2` |

통합 뒤의 formatting, CI 설정과 문서 commit은 runtime contract를 바꾸지 않는다.
현재 운영·롤백 상태는 별도 운영 위키가, 코드와 Git 이력은 이 저장소가 source of
truth다.

## Maintainer map

- [Project source map](project-source-map.md): runtime 진입점, 디렉터리 책임,
  요청·데이터 흐름, 포크 hotspot과 검증 경로
- [Fork and upstream strategy](upstream/README.md): 저장소 역할, 변경 lane,
  migration namespace와 release 통합 절차
- [v3.4.x integration evidence](plans/2026-07-19-upstream-v3.4-integration-evidence.md):
  통합·테스트·이미지·배포·PR closeout 증거
- [Client test warning cleanup](plans/2026-07-20-client-test-warning-cleanup.md):
  Vitest 환경, MSW 기본 계약과 React 비동기 테스트 경고 정리 기준
- [PlaceInspector Hook order fix](plans/2026-07-20-client-lint-hook-order.md):
  전체 lint 경고 분류와 nullable place 선택 전환의 Hook 순서 회귀 기준
- [Bulk place delete null guard](plans/2026-07-21-client-lint-optional-chain-guard.md):
  선택·비선택·orphan assignment 보존 계약과 optional-chain lint 오류 게이트
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
