# TREK Fork and Upstream Strategy

이 문서는 `tomtomjskim/TREK`을 실제 배포 가능한 포크로 유지하면서 공식
`liketrek/TREK`의 release를 반복해서 받아들이고, 일반화 가능한 변경은 공식
프로젝트에 기여하기 위한 운영 계약이다.

현재 runtime 진입점과 fork hotspot은 [`docs/project-source-map.md`](../project-source-map.md)를
먼저 확인한다.

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

공식 `CONTRIBUTING.md`, PR template, target-branch workflow를 2026-07-19
`upstream/dev` `483b2b1d`에서 다시 확인했다. 현재 계약은 다음과 같다.

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

## Feature decision checklist

새 기능이나 기존 포크 patch를 수정하기 전에 다음 항목을 patch inventory 또는 별도
설계 문서에 고정한다.

1. **lane**: `upstream-contrib`, `plugin`, `fork-core`, `instance-only` 중 하나를 선택한다.
2. **사용자와 contract**: 모든 TREK 설치에 필요한지, 이 인스턴스 정책인지, public API나
   권한 의미가 바뀌는지 적는다.
3. **데이터 소유권**: 공식 core DB, `fork_schema_migrations`, plugin-owned SQLite,
   instance config 중 어디에 저장하는지 정한다.
4. **integration seam**: core 변경이 필요하면 import/controller/UI hook 수를 최소화하고
   포크 adapter 위치를 명시한다.
5. **검증과 rollback**: negative auth/privacy, migration 재실행, provider 비용, responsive
   UI, backup/restore 중 해당하는 증거를 지정한다.
6. **retirement signal**: 공식 release tag, SDK capability 추가, 운영 설정 이전처럼 로컬
   patch를 제거할 객관적 조건을 적는다.

서로 다른 lane은 커밋과 PR을 분리한다. 배포를 위한 통합 merge commit은 여러 lane을
포함할 수 있지만, 공식 기여 브랜치의 source로 재사용하지 않는다.

## v3.4 plugin extraction feasibility

v3.4의 실제 SDK/host 계약을 기준으로 한 판단이다. 다음 release에서는 capability가
변할 수 있으므로 재검증한다.

| 기능 surface | v3.4에서 plugin으로 가능한 부분 | 현재 SDK gap / 결론 |
| --- | --- | --- |
| Google place enrichment | `http:outbound:<host>`, `db:own` usage ledger/migration, user/instance settings, settings action, authenticated route, `ctx.places.update`, `ctx.meta` external ID | native import modal과 admin usage panel에 provider UI를 주입하는 전용 hook이 없다. provider/ledger를 먼저 plugin service로 추출하고 native UI adapter는 얇은 fork-core로 남기는 hybrid가 현실적이다. |
| Google hard cap | plugin-owned DB의 선예약과 외부 호출 wrapper | 앱 core의 다른 Google 호출까지 한 plugin이 강제할 수 없다. 모든 provider call이 plugin을 통과하기 전에는 core guard를 유지한다. |
| packing personal templates/privacy | 별도 plugin DB와 독립 page는 가능 | core packing table, native list/template UI, REST/MCP/plugin write 권한을 일관되게 바꾸는 hook이 없다. 보안 contract를 포함한 단독 upstream PR 또는 최소 fork-core가 맞다. |
| 지도 label locale | plugin frame 안의 별도 지도만 가능 | 공통 MapLibre/Mapbox style expression과 Settings를 바꾸므로 단독 upstream PR 후보다. |
| Fold adaptive controls | table contributor로 대체 불가 | planner의 공통 responsive layout이므로 단독 upstream PR 후보다. |
| Android/Cloudflare/Compose | 해당 없음 | package identity, signing, domain, reverse proxy는 instance-only로 유지한다. |

Google plugin 추출은 한 번에 UI까지 옮기지 않는다. 권장 순서는 provider client와 usage
ledger를 interface 뒤로 격리하고, plugin-owned DB/route로 옮길 수 있는지 contract test를
만든 뒤, SDK에 native place-enrichment/admin metric hook을 공식 제안하고, 마지막으로 core
adapter를 제거하는 방식이다.

## Upstream PR extraction lifecycle

1. 포크 patch의 재현 테스트와 일반적인 사용자 문제를 분리한다.
2. 공식 최신 정책과 `upstream/dev` 상태를 다시 확인하고 Discord에서 범위를 승인받는다.
3. `upstream/dev` 기반 `upstream-contrib/<topic>` worktree에서 한 기능만 최소 구현한다.
4. JSNetworkCorp 설정과 포크 migration 없이 공식 전체 테스트/coverage를 통과시킨다.
5. TOM이 명시 승인한 경우에만 공식 PR을 생성한다.
6. merge 후에도 포크 patch는 유지한다. 변경이 포함된 공식 release tag를 격리 통합하고
   동등성 회귀가 통과할 때 patch와 adapter를 제거한다.

이 lifecycle을 따르면 공식 PR과 실제 배포 포크의 upgrade 주기가 분리되어, PR 검토가
늦어지거나 거절돼도 운영 배포를 막지 않고 수용 후에는 자연스럽게 divergence를 줄일 수
있다.

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
| PlaceInspector nullable selection Hook 순서 | fork core | 높음 | 공식 release가 같은 mount의 null↔place 회귀를 통과하고 Hook 규칙 위반을 제거하면 구현 방식과 무관하게 local patch 제거 |
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

### v3.4.1 synchronization note

- 공식 `v3.4.1`은 exact target `a0994658890eae96624fb9cbe7f55867f047fea2`로
  고정한다. tag target이 unsigned이므로 signed tag라고 표현하지 않는다.
- v3.4.0 통합 branch에서 `merge-tree`와 실제 merge 모두 충돌이 없었고 DB migration,
  packing, Google hard cap 및 Fold/map hotspot을 건드리지 않았다.
- per-user ntfy가 admin topic으로 fallback하지 않는 negative privacy test를 필수 gate로
  둔다. transit arrive-by, AirTrail closed-to-open, accommodation morning leg, Synology
  streaming/log redaction, Atlas bundle과 plugin registry 테스트도 함께 실행한다.
- schema가 175로 유지되므로 배포 rollback은 현재 v3.4.0 R2 image로의 code-only 교체다.
  그래도 운영 교체 전 owner-only SQLite online backup과 public app version을 확인한다.
- 포크 merge commit `e1be01e`와 ARM64 image
  `trek:3.4.1-upstream-integration-e1be01e`는 전체 test/typecheck/i18n/build, 격리
  smoke와 운영 backup/public browser gate를 통과해 2026-07-20 배포했다.
- 최종 integration head `1c59f44f`는 GitHub Actions server/client/shared/i18n/lint를
  통과했고 PR #1을 merge commit `86d3e9a0`로 포크 `main`에 병합했다. 병합 뒤 임시
  branch와 block-volume worktree는 삭제했으며 공식 upstream에는 branch나 PR을 만들지
  않았다. 다음 공식 release도 이 v3.4.1 기준점에서 exact tag를 병합한다.
