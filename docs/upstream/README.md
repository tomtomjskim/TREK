# TREK Fork and Upstream Strategy

이 문서는 `tomtomjskim/TREK`을 실제 배포 가능한 포크로 유지하면서 공식
`liketrek/TREK`의 release를 반복해서 받아들이고, 일반화 가능한 변경은 공식
프로젝트에 기여하기 위한 운영 계약이다.

## Repository roles

| 이름 | 저장소/기준 | 역할 |
| --- | --- | --- |
| `origin` | `tomtomjskim/TREK` | TOM이 사용하는 배포 포크 |
| `upstream/main` | `liketrek/TREK` | 공식 release와 tag 기준 |
| `upstream/dev` | `liketrek/TREK` | 공식 pull request 대상 |
| `main` | `origin/main` | 검증·배포 가능한 포크 이력 |
| `feat/upstream-vX.Y-integration` | 로컬/포크 | 공식 tag를 통합하고 회귀 검증하는 임시 브랜치 |
| `upstream-contrib/<topic>` | `upstream/dev`에서 분기 | 공식 PR 한 건만 담는 깨끗한 기여 브랜치 |

`origin`과 `upstream`의 역할을 바꾸지 않는다. 공식 tag는 배포 `main`에 바로
fast-forward하지 않고 격리 브랜치에서 merge한다. 이미 공개된 포크 `main`은
rebase하지 않는다.

## Official contribution gate

공식 `CONTRIBUTING.md`와 PR template의 현재 계약은 다음과 같다.

1. 구현 전에 Discord `#github-pr`에서 아이디어와 범위를 승인받는다.
2. PR 하나에는 관련된 변경 한 가지만 포함한다.
3. breaking change와 무관한 reformat/refactor를 포함하지 않는다.
4. wiki-only 변경을 제외한 PR base는 반드시 `dev`다.
5. 테스트를 추가하고 전체 coverage 80% 이상을 유지한다.
6. branch를 최신 `upstream/dev`에 맞추고 issue/discussion을 연결한다.
7. conventional commit을 사용한다.

따라서 포크의 배포 통합 브랜치를 그대로 공식 PR로 보내지 않는다. 공식 기여는
승인 후 아래처럼 별도 worktree에서 재구성한다.

```bash
git fetch upstream main dev --tags
git worktree add ../TREK-upstream-topic -b upstream-contrib/<topic> upstream/dev
```

공식 PR 브랜치에는 JSNetworkCorp 도메인, Cloudflare/nginx 설정, Android application
ID/signing, 운영 Compose override, secret 위치, 포크 전용 migration 이력을 포함하지
않는다.

## Modularity decision

포크 변경은 네 lane으로 관리한다.

| lane | 선택 기준 | 배포/제거 기준 |
| --- | --- | --- |
| upstream contribution | 모든 설치에 유효하고 기존 contract를 깨지 않음 | 공식 release에 포함되면 포크 patch 제거 |
| plugin | SDK capability와 plugin-owned DB/UI로 격리 가능 | core 수정 없이 설치/비활성화 가능해야 함 |
| fork core | 현재 SDK가 부족하거나 운영 중인 보안 경계를 즉시 유지해야 함 | patch inventory, 테스트, retirement 조건 필수 |
| instance-only | 특정 도메인·브랜드·서명·인프라에만 유효 | 공식 PR 금지, 배포 runbook에서 관리 |

Plugin은 자체 DB migration을 소유할 수 있지만 TREK core schema를 직접 변경하지
않는다. core table, auth/permission, WebSocket privacy 또는 공통 지도 레이아웃을
바꿔야 하는 변경은 plugin으로 위장하지 않고 upstream contribution 또는 최소
fork-core patch로 분류한다.

## Migration namespace contract

공식 migration 숫자와 포크 숫자를 같은 `schema_version` 배열에 넣는 방식은
v3.4.0에서 실제로 충돌했다. 포크 v3.3은 `172=google_api_usage`,
`173=packing template scope`를 배포했지만 공식 v3.4.0은 같은 번호를 plugin update
metadata와 `trek_range`에 사용한다.

v3.4 통합부터 다음 계약을 사용한다.

- 공식 `server/src/db/migrations.ts`와 `schema_version`은 upstream이 단독 소유한다.
- 포크 migration은 별도 `fork_schema_migrations` 테이블과
  `jsnetworkcorp.<feature>.vN` ID를 사용한다.
- `migrationRunner`는 legacy collision을 정확한 schema signature로만 식별한 뒤
  공식 migration을 먼저 실행하고 포크 migration을 실행한다.
- 이미 적용된 포크 v3.3 DB는 공식 version marker를 `171`로 정상화해 공식
  `172..175`가 실행되도록 한다. 이 작업은 exact signature가 아니면 중단한다.
- 포크 migration은 재실행 가능해야 하고, 이미 배포한 ID의 구현을 고치지 않는다.

세부 state matrix와 rollback/evidence는
`docs/plans/2026-07-19-upstream-v3.4-integration-design.md`를 따른다.

## Patch inventory

| 변경 | 현재 lane | 공식 기여 가능성 | 분리/retirement 조건 |
| --- | --- | --- | --- |
| 지도 label locale 선택 | upstream contribution 후보 | 높음 | 기본값·fallback을 일반화하고 `upstream/dev` 승인 후 단독 PR |
| Fold/태블릿 adaptive map controls | upstream contribution 후보 | 높음 | JSNetworkCorp 표현 없이 responsive regression만 단독 PR |
| packing Personal/Shared privacy | upstream contribution 후보 | 높음, security fix | 공식 privacy contract와 negative tests가 수용된 release 후 local patch 제거 |
| packing template scope R1 | fork core / upstream discussion | 중간 | 개인 템플릿 제품 방향 승인 전 writer는 비활성, migration은 fork namespace 유지 |
| Google place enrichment와 app hard cap | fork core, plugin 추출 검토 | 중간 | provider 호출·usage ledger를 plugin-owned DB/action으로 옮길 SDK gap 분석 필요 |
| Google 사용량 admin UI | plugin 또는 upstream generic 후보 | 중간 | Google 전용 표현과 instance 정책을 분리해야 함 |
| Android TWA/APK | instance-only | 없음 | package identity, assetlinks, signing을 포크에서만 관리 |
| Cloudflare/nginx/Compose 운영 설정 | instance-only | 없음 | repository secret 금지, 외부 deployment runbook에서 관리 |

## Release synchronization procedure

```bash
git fetch --prune upstream main dev --tags
git merge-tree --write-tree --messages HEAD <verified-upstream-tag>
git merge --no-ff --no-commit <verified-upstream-tag>
```

1. release notes, tag commit, required env, Docker image architecture를 확인한다.
2. 충돌을 DB/auth/privacy/provider/UI/docs로 분류한다.
3. migration collision은 숫자 재배치로 덮지 않고 migration namespace contract로 해결한다.
4. 로컬 보안·비용 경계와 upstream 기능을 모두 보존하는 regression test를 먼저 둔다.
5. shared/server/client test와 typecheck/build, SQLite 사본 migration dry run을 통과한다.
6. 운영 전에는 immutable local image를 만들고 기존 image와 DB backup으로 rollback을 연습한다.
7. TOM의 배포 승인 전에는 `main` merge, remote push, Compose 교체를 하지 않는다.

v3.4.0에서 확인된 conflict hotspot은 `server/src/db/migrations.ts`, maps/settings,
packing row/service/tests, Google maps/admin services, locale settings 파일이다. 공식 root
Compose image 이름은 실제 Docker reference가 소문자여야 하므로 배포 override에서
검증한다.
