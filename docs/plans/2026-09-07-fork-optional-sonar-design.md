# Fork-Optional Sonar Design

> 작성일: 2026-09-07
> 상태: 사용자 결정 승인 — fork에는 현재 Sonar 서비스가 없음
> lane: instance-only CI provider adapter

## 목표와 선택

`tomtomjskim/TREK`의 코드·테스트 CI가 존재하지 않는 upstream SonarQube Cloud
project/token 때문에 실패하지 않게 한다. 동시에 나중에 fork 운영자가 Sonar project를
만들면 core coverage를 재구성하지 않고 다시 붙일 수 있어야 한다.

검토한 선택지는 Sonar 완전 삭제, 별도 수동 workflow, 기존 coverage workflow의 명시적
optional job이다. 완전 삭제는 재도입 seam을 잃고, 별도 workflow는 같은 run의 coverage
artifact를 받을 수 없어 네 suite를 중복 실행하거나 cross-run artifact 권한을 추가해야 한다.
따라서 기존 workflow 안의 마지막 scan job을 `SONAR_ENABLED=true`일 때만 실행하는 방식을
선택한다. 기본값/미설정은 의도된 disabled이고, enabled인데 project key, organization 또는
token이 하나라도 없으면 preflight가 fail-closed한다.

## 계약과 경계

- 핵심 10개 job과 coverage artifact 생산은 Sonar 상태와 무관하게 그대로 실행한다.
- scan job은 repository variable `SONAR_ENABLED`가 정확히 `true`이고, secret을 받을 수 있는
  same-repository event일 때만 실행한다.
- project identity는 upstream의 `liketrek_TREK`/`liketrek`를 Git에 고정하지 않는다.
  활성화할 때 fork 소유자가 `SONAR_PROJECT_KEY`, `SONAR_ORGANIZATION` repository variable과
  `SONAR_TOKEN` secret을 함께 설정한다.
- secret 값은 workflow log, 문서, test fixture에 출력하지 않는다.
- upstream README의 official Sonar badge는 fork에서 제거해 fork 품질 신호처럼 보이지 않게
  한다.
- 이 변경은 GitHub Actions와 문서만 바꾸며 API, DB, auth, container, production runtime에는
  영향이 없다. rollback은 관련 commit을 되돌리는 code-only 작업이다.

## 검증과 재활성화

Node built-in test가 workflow의 enable gate, fail-closed preflight, fork 변수 주입, upstream
identity 제거를 검사한다. 이 test를 cheap preflight job에 연결해 다음 upstream sync가 old
Sonar 설정을 되살리면 core CI 시작 단계에서 즉시 실패하게 한다. YAML parse와 diff check 뒤
fork branch에서 전체 Actions run을 확인하며, core jobs success와 optional scan skipped를
각각 별도 판정한다.

향후 활성화 순서는 fork Sonar project 생성, 세 repository 설정 등록,
`SONAR_ENABLED=true` 전환, workflow dispatch 또는 code push, quality gate 확인이다. 단순히
token만 추가하거나 upstream project identity를 복원하지 않는다.
