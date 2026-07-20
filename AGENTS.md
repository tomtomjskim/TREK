# TREK Project Agent Rules

## Scope and source of truth

- 기본 응답과 작업 브리핑은 한국어 존댓말로 작성한다.
- 이 저장소의 배포 포크는 `https://github.com/tomtomjskim/TREK`이며 `origin`으로 유지한다.
- 공식 TREK 저장소는 `https://github.com/liketrek/TREK`이며 읽기 전용 `upstream`으로 취급한다.
- TOM의 명시 요청 없이 공식 저장소로 push하거나 pull request를 생성하지 않는다.
- 코딩 전에 이 파일, `docs/README.md`, `docs/project-source-map.md`,
  `docs/upstream/README.md`, 현재 작업과 관련된 `docs/plans/`, 그리고
  `/home/ubuntu/personal-wiki/wiki/{reviewed,generated}/llm/codebase/trek/`의 관련 문서를 읽는다.

## Change lanes

변경을 시작하기 전에 다음 중 하나로 분류하고, 서로 다른 lane을 한 커밋이나 공식 PR에 섞지 않는다.

1. `upstream-contrib`: 모든 TREK 사용자에게 일반적인 수정. `upstream/dev`에서 시작하며 공식 기여 규칙을 따른다.
2. `fork-core`: 아직 upstream 또는 plugin으로 옮기지 못한 최소 core patch. `docs/upstream/README.md`의 patch inventory에 기록한다.
3. `plugin`: TREK plugin SDK와 capability 경계 안에서 구현할 수 있는 기능. core patch보다 우선 검토한다.
4. `instance-only`: JSNetworkCorp 도메인, Cloudflare/nginx, Android TWA identity/signing, 운영 Compose와 secret처럼 upstream에 기여하지 않는 배포 자산.

공식 기여 후보는 먼저 Discord `#github-pr`에서 승인을 받고, `upstream/dev` 기준의 별도 브랜치에서 한 가지 변경만 담아야 한다. 공식 PR에는 JSNetworkCorp 도메인, 계정, secret 위치, 운영 데이터, 포크 전용 migration을 포함하지 않는다.

공식 기여를 시작할 때는 이 문서의 스냅샷만 믿지 말고 아래 원본을 `upstream/dev`에서
다시 읽는다. 정책이 달라졌으면 원본이 우선이다.

- `CONTRIBUTING.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/workflows/enforce-target-branch.yml`

새 기능을 구현하기 전에는 `docs/upstream/README.md`의 feature decision checklist를
작성한다. lane, 데이터 소유권, core integration seam, 테스트, upstream 수용 시 제거 조건이
불명확하면 구현을 시작하지 않는다.

## Upstream synchronization

- 배포 `main`을 rebase하거나 공식 `main`에 직접 맞추지 않는다. 검증 가능한 공식 tag를 격리 worktree의 `sync/*` 또는 `feat/upstream-*` 브랜치에 merge한다.
- `origin/main`은 배포 가능한 포크, `upstream/main`은 공식 release 기준, `upstream/dev`는 공식 기여 기준이다.
- 충돌 해결 전에 `git merge-tree`로 충돌 surface를 확인하고 DB migration, auth/privacy, provider 비용, UI 순으로 위험을 분류한다.
- 공식 tag 병합 뒤에는 `docs/upstream/README.md`의 patch inventory와 conflict hotspot을 갱신한다.
- 공식 저장소에서 수용된 기능은 다음 tag sync 때 동등한 포크 patch를 제거해 divergence를 줄인다.
- 공식 PR 브랜치는 포크 `main`에서 분기하지 않는다. 최신 `upstream/dev`의 별도 worktree에서
  일반화된 최소 변경만 재구성하고, 포크 기능과의 동등성은 테스트로 연결한다.
- 공식 PR이 merge됐더라도 포크 patch를 즉시 제거하지 않는다. 해당 변경이 포함된 서명된
  release tag를 통합하고 회귀 검증한 뒤 제거한다.

## Database migration ownership

- `server/src/db/migrations.ts`와 공식 `schema_version` 번호는 upstream 소유다. 포크 migration을 공식 배열 끝에 추가하지 않는다.
- 포크 migration은 `server/src/db/forkMigrations.ts`의 안정적인 문자열 ID(`jsnetworkcorp.<feature>.vN`)와 별도 이력 테이블을 사용한다.
- 런타임은 `server/src/db/migrationRunner.ts`를 통해 legacy collision bridge, 공식 migration, 포크 migration 순으로 실행한다.
- 이미 배포한 포크 migration을 수정하지 않는다. 변경은 새 ID로 추가하며 재실행 idempotency와 부분 실패 복구를 테스트한다.
- 공식/포크 version collision 또는 알 수 없는 partial schema는 추측해 계속하지 않고 fail closed한다.
- migration 변경은 fresh DB, stock 이전 버전, 현재 포크 DB, 재실행, schema commit과
  marker update 사이 crash window, 알 수 없는 partial state를 모두 검증하고 운영 전
  SQLite backup/restore rehearsal을 수행한다.

## Verification and deployment

- 동작 변경은 테스트를 먼저 실패시키고 최소 구현으로 통과시킨다.
- 최소 관련 테스트부터 실행하고 최종 gate에서는 shared/server/client test, typecheck, production build, migration dry run을 수행한다.
- UI 변경은 관련 Vitest와 390px/1440px 또는 대상 Fold viewport의 Playwright 증거를 남긴다.
- 운영 배포는 TOM의 명시 승인 뒤에만 한다. 배포 전 immutable image tag, DB backup, rollback image, Compose diff와 healthcheck를 고정한다.
- `.env`, token, signing key, production DB 원본이나 사용자 식별 정보는 문서·commit·로그 인용에 남기지 않는다.
