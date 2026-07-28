# TREK Fork-First Validation Policy

> 시행일: 2026-07-28
> 현재 상태: 로컬·개인 포크 검증 활성, 공식 upstream 기여 보류
> 확인 기준: fork `main` `c5ff1d27`, upstream `dev` `292f1b18`

## 결정

당분간 TREK 고도화는 로컬 worktree와
[`tomtomjskim/TREK`](https://github.com/tomtomjskim/TREK) 개인 포크 안에서만
설계·구현·검증한다. [`liketrek/TREK`](https://github.com/liketrek/TREK)는
release와 코드·정책을 읽기 위한 `upstream`으로만 사용한다.

이 보류 기간에는 Discord `#github-pr` 게시, 공식 issue/discussion 작성, 공식
저장소 branch push와 pull request 생성을 하지 않는다. 포크에서 충분히 검증된
변경을 향후 기여 후보로 유지하되, 개인 포크의 기능 branch를 공식 PR로 그대로
보내지 않는다.

이 정책은 TOM이 공식 기여를 다시 시작한다고 명시할 때까지 유효하다. 다른 기능
작업에 대한 일반적인 `진행`, `go`, `배포` 지시를 보류 해제로 추론하지 않는다.

## 원격 작업 경계

| 작업                                 | 현재 허용 상태  | 조건                                                      |
| ------------------------------------ | --------------- | --------------------------------------------------------- |
| 로컬 branch/worktree 생성·커밋       | 허용            | 승인된 작업 범위, 관련 검증과 clean diff                  |
| `origin` fetch와 개인 포크 상태 확인 | 허용            | `origin=tomtomjskim/TREK` 재확인                          |
| 개인 포크 branch push 또는 PR        | 조건부          | TOM이 push/PR 작업을 명시한 경우만                        |
| 포크 `main` 통합                     | 조건부          | 검증 결과와 rollback 기준을 제시하고 별도 승인            |
| 운영 이미지·Compose·DB 변경          | 조건부          | 별도 배포 승인과 backup/rollback gate                     |
| `upstream` fetch·tag/diff 확인       | 허용, 읽기 전용 | 공식 정책과 release 재대조 목적                           |
| Discord·공식 issue/discussion 게시   | 보류            | TOM이 공식 기여 재개와 게시 범위를 명시해야 함            |
| 공식 branch push·`liketrek/TREK` PR  | 보류            | 공식 기여 재개, maintainer 사전 승인, 별도 게시 승인 필요 |

원격 이름은 작업 전 아래 의미와 일치하는지 확인한다.

```text
origin   https://github.com/tomtomjskim/TREK.git
upstream https://github.com/liketrek/TREK.git
```

URL 확인은 역할 검증일 뿐 push 승인이 아니다.

## `fork-first`와 change lane

`fork-first validation`은 코드 소유권을 바꾸는 다섯 번째 lane이 아니라 현재의
개발·게시 방식이다. 모든 변경은 계속 다음 중 하나로 분류한다.

- `upstream-contrib`: 모든 TREK 설치에 일반적인 변경. 현재는 개인 포크에서
  검증하되 공식 기여는 보류한다.
- `plugin`: SDK capability와 plugin-owned data 안에서 core를 바꾸지 않는 확장.
- `fork-core`: SDK gap, 즉시 필요한 correctness·privacy·비용 경계를 위한 최소
  포크 patch.
- `instance-only`: JSNetworkCorp 도메인, Cloudflare/nginx, Android identity/signing,
  운영 Compose와 같이 공식 기여 대상이 아닌 자산.

개인 포크에 먼저 구현했다는 이유만으로 일반 기능의 장기 lane을 자동으로
`fork-core`로 바꾸지 않는다. 반대로 포크 전용 migration·브랜드·운영 설정이
들어간 branch를 `upstream-contrib`로 표시하지 않는다.

서로 다른 lane은 source commit을 분리한다. 배포용 통합 commit은 여러 lane을
포함할 수 있지만 향후 공식 기여 branch의 source로 직접 사용하지 않는다.

## 로컬·개인 포크 작업 방식

1. 배포 가능한 기준은 `origin/main`으로 유지하고 직접 실험하지 않는다.
2. `/mnt/oci-block-volume/worktrees/TREK/` 아래 격리 worktree에서
   `feat/<topic>`, `fix/<topic>`, `docs/<topic>` 또는 `chore/<topic>` branch를
   사용한다.
3. 변경 전 lane, 사용자·public contract, 데이터 소유권, core integration seam,
   검증·rollback과 retirement signal을 설계 문서에 기록한다.
4. 동작 변경은 실패하는 focused test를 먼저 만들고 최소 구현으로 통과시킨다.
5. 한 commit에는 한 가지 설명 가능한 동작만 담고 conventional commit을 사용한다.
6. 최소 관련 test부터 시작해 변경 surface에 맞는 전체 gate로 넓힌다.
7. push, 포크 PR, `main` 통합과 배포는 자동 후속 단계로 간주하지 않는다.

포크 schema 변경은 `server/src/db/forkMigrations.ts`의 안정적인
`jsnetworkcorp.<feature>.vN` ID와 별도 이력 테이블을 사용한다. 향후 공식 기여
시에는 이 migration을 복사하지 않고 최신 `upstream/dev`의 공식 migration
계약과 slot에 맞는 별도 변경으로 다시 설계한다.

## 코드 컨벤션의 source of truth

2026-07-28 최신 `upstream/dev`를 다시 확인한 결과 공식 기여 규칙은 유지되고
있지만, 공식 Wiki의 일부 기술 스택·스크립트 설명은 현재 코드보다 오래됐다.
기여·게시 규칙은 최신 공식 `CONTRIBUTING.md`, PR template와 target-branch
workflow를 우선한다. 기술 스택·명령·style은 현재 대상 branch의 source,
`package.json`, workspace별 `eslint.config.mjs`·`.prettierrc`, test와 CI
workflow를 우선한다. 공식 Wiki는 상세 안내로 참고하되 둘과 다르면 그대로
복사하지 않는다.

| 영역       | 현재 계약                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| 구조       | shared Zod contract → NestJS server → React client consumer 순으로 변경                                          |
| TypeScript | 명확한 타입을 유지하고 shared에서는 explicit `any`와 unused 값을 오류로 처리                                     |
| Formatting | shared/server는 120 columns·single quote·trailing comma, client는 2 spaces·single quote·LF와 Tailwind class 정렬 |
| Lint       | 관련 workspace의 non-mutating `lint:check` 또는 explicit ESLint check 사용                                       |
| React      | Hook 순서·dependency와 page container/data-hook 경계를 보존하고 새 zero-debt lint 위반을 만들지 않음             |
| API        | shared Zod request/response schema, server negative auth test, client consumer를 함께 갱신                       |
| i18n       | locale key를 함께 추가하고 strict parity를 통과                                                                  |
| DB         | additive migration, 재실행·부분 실패·fresh/upgrade 증거; 포크와 공식 namespace 분리                              |
| Tests      | focused RED→GREEN 뒤 unit/integration/e2e·coverage를 surface에 맞게 확대                                         |
| Coverage   | 공식 기여 후보는 전체 80% 이상을 유지하고 변경으로 coverage를 낮추지 않음                                        |
| Commit     | `fix(scope): ...`, `feat(scope): ...`, `docs(scope): ...` 형태의 conventional commit                             |
| Scope      | 불필요한 추상화·dependency·reformat·“while I am here” cleanup 금지                                               |

`npm run lint`는 일부 workspace에서 `--fix`를 실행하므로 검증 전용 명령으로
사용하지 않는다. 자동 수정이 의도된 별도 formatting 작업이 아니라면
`lint:check`, explicit ESLint와 `format:check`를 사용한다.

## 검증 단계

### 1. Focused local evidence

- 변경 전 실패를 재현하는 unit/integration test
- 수정 후 동일 test와 인접 regression
- auth/privacy는 허용·거부 양쪽, mutation은 idempotency·concurrency 실패 경로
- DB는 fresh/upgrade/repeat/partial-state와 backup·restore
- UI는 관련 Vitest, 접근성, 390px·1440px 또는 실측 Fold viewport

### 2. Fork branch gate

대상 branch의 실제 scripts를 기준으로 최소 다음을 확인한다.

```bash
npm test
npm run test:cov
npm run format:check
npm run build
npm run typecheck --workspace=shared
npm run typecheck --workspace=server
npm run typecheck --workspace=client
npm run i18n:parity:strict --workspace=shared
npm exec --workspace=shared -- eslint "src/**/*.ts"
npm run lint:check --workspace=server
npm run lint:check --workspace=client
npm run lint:pages --workspace=client
git diff --check
git diff --check origin/main...HEAD
```

변경과 무관한 장시간 gate를 매 commit마다 반복하지는 않지만, 포크 `main` 통합
후보에는 전체 gate 결과를 남긴다. 실행하지 못한 gate는 이유와 residual risk를
기록한다.

현재 포크 `main`의 root workspace에는 `nest-mcp`가 없지만 최신
`upstream/dev`에는 포함되어 있다. 따라서 향후 공식 기여 후보를 추출할 때는
최신 branch의 root scripts와 CI를 다시 읽고 `nest-mcp` build, typecheck, lint,
test와 production require smoke까지 추가한다. 포크 gate 통과를 최신 upstream
gate 통과로 표현하지 않는다.

### 3. Evidence record

기능별 `docs/plans/` 문서에 다음을 남긴다.

- 문제와 재현 조건, 사용자 영향
- 선택한 lane과 일반 기능/instance-only 경계
- 변경 commit과 비교 기준
- 실행한 명령·결과, 생략한 검증과 이유
- migration·privacy·비용·responsive evidence
- rollback 또는 feature disable 조건
- 공식 release/SDK 변화 시 포크 patch 제거 조건

secret, 운영 `.env`, production DB·session 원본과 사용자 식별 정보는 기록하지
않는다.

## 향후 공식 기여 재개 절차

다음 조건을 모두 만족해도 자동으로 공식 PR을 만들지는 않는다.

1. TOM이 공식 기여 재개와 외부 게시 범위를 명시한다.
2. 포크 기능이 focused test, 전체 로컬 gate와 필요한 수동 수용 검증을 통과한다.
3. 문제·해결이 JSNetworkCorp 인스턴스가 아니라 일반 TREK 사용자에게 유효하다.
4. 포크 전용 migration, domain, brand, secret 위치와 운영 설정을 제거할 수 있다.
5. 변경을 한 가지 reviewable unit으로 줄일 수 있고 breaking change가 없다.
6. 최신 `upstream/dev`에서 `CONTRIBUTING.md`, PR template, target workflow,
   package/config/CI와 중복 issue·PR을 다시 확인한다.

그 뒤에도 공식 규칙에 따라 코드 추출 전에 Discord `#github-pr`에서 범위를
승인받는다. 승인을 받은 한 항목만 최신 `upstream/dev` 기반의 새
`upstream-contrib/<topic>` worktree에서 재구성한다.

포크 commit은 증거와 회귀 테스트의 근거이지 자동 cherry-pick 대상이 아니다.
선택적 port 뒤 포크 adapter·migration·브랜드 의존성이 없는지 diff를 검토하고,
현재 upstream의 `nest-mcp`, shared/server/client test·coverage·typecheck·lint,
strict i18n, production build/smoke를 모두 적용한다. 공식 branch push와 PR 생성은
다시 TOM의 명시 승인을 받는다.

## Vacay v2 적용

Vacay employment/period/balance 설계는 현재 포크 우선 검증 대상으로 전환한다.
generic core는 장기적으로 `upstream-contrib` 후보라는 분류를 유지하되,
Discord·공식 PR 없이 로컬·개인 포크에서 작은 slice로 구현·검증할 수 있다.

- correctness 네 항목은 향후 분리 기여가 가능하도록 각각 독립 test·commit으로
  유지한다.
- employment/period/journal schema pilot은 포크 migration namespace를 사용한다.
- self-only 권한, opening cutoff, revision/idempotency, legacy activation과
  rollback의 `full_gate_required` 수준은 낮추지 않는다.
- 한국 법정 자동 산정은 generic core와 분리된 proposal provider로 미룬다.
- 운영 pilot은 이 정책의 자동 단계가 아니며 별도 배포 승인이 필요하다.

기존 Discord 초안과 upstream 구현 계획은 삭제하지 않고 “향후 기여 재개용”
자료로 보존한다.

## 정책 변경

TOM이 공식 기여 재개를 승인하면 같은 변경에서 다음을 수행한다.

1. 이 문서의 상태와 `AGENTS.md` publication hold를 갱신한다.
2. 최신 `upstream/dev` SHA와 공식 규칙 변경 여부를 기록한다.
3. 허용한 Discord/issue/branch/PR 범위를 정확히 명시한다.
4. 선택한 기능의 fork evidence와 upstream extraction branch를 연결한다.

보류 해제 전에는 “기여 가능성 높음”, “PR 후보”, “upstream-contrib lane”이라는
표현을 외부 게시 승인으로 해석하지 않는다.
