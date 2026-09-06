# TREK Fork Extension Manifest

이 문서는 공식 release 동기화 때 포크 기능을 누락 없이 재적용하거나 제거하기 위한
목록이다. 최신 공식 기준은 `v4.2.0` peeled commit
`09ce5cb733bb681c992dfd4f029706718aae58cc`이며, 포크 기능은 공식 source를 덮어쓴
별도 배포판이 아니라 아래의 제한된 extension surface로 관리한다.

## Toggle semantics

- `addon`: 첫 global guard의 REST 404-before-auth/MFA, MCP/plugin RPC,
  desktop/mobile/admin entry가 같은 addon id로 함께 닫힌다.
- `config`: 외부 provider 호출 또는 표시만 끄며 keyless/local fallback은 남는다.
- `user-setting`: 사용자별 표시 선택이며 기능 코드 제거 스위치가 아니다.
- `always-on invariant`: 보안, 개인정보, 데이터 보존, 동시성, 오류 수정이다. 이를
  runtime에서 끄면 과거 취약 동작이 되므로 toggle을 만들지 않는다.
- `instance-only`: Git 기본값이 아니라 host-local 배포 설정으로만 활성화한다.

Addon off는 데이터를 삭제하거나 fork migration을 되돌리지 않는다. schema retirement는
별도 migration과 backup/restore 계획이 필요한 독립 작업이다.

## Retained extensions

| Extension | Lane / activation | Owning seam | Persistent state | Required evidence | Retirement signal |
| --- | --- | --- | --- | --- | --- |
| OpenFreeMap basemap fallback | fork-core config adapter; keyless fallback always available | `client/src/constants/mapDefaults.ts`, `client/src/utils/tileUrl.ts`, `client/src/components/Map/VectorBasemap.tsx`, `client/e2e/map-label-language.spec.ts` | app/user map URL 설정만 사용; secret 추가 없음 | missing/blank/CARTO-incomplete key unit test, planner/public map browser smoke | 공식 release가 같은 keyless fallback과 locale/style contract를 제공 |
| Public shared place notes | upstream-contrib 후보; `share_map` contract에 종속 | `server/src/nest/share/`, shared public DTO, `client/src/pages/SharedTripPage.tsx` | 공식 `places.notes`; 개인 메모 field 추가 없음 | anonymous exact allowlist, `share_map=false` no-query/no-render, zero-coordinate popup/plan E2E | 공식 release가 동일 projection·비노출·표시 회귀를 통과 |
| Vacay product | fork-core addon; `ADDON_IDS.VACAY` | `server/src/nest/vacay/`, `/vacay` desktop/mobile, Vacay MCP/RPC | 공식 Vacay tables; runtime off 시 보존 | REST 404-before-auth, route redirect/nav hidden, MCP unavailable | 공식 addon lifecycle이 모든 surface를 같은 id로 gate하고 포크 정책이 불필요해짐 |
| Vacay data-safety rules | upstream-contrib 후보 + fork-core policy; always-on while Vacay is enabled | Vacay service/controller/MCP and targeted client confirmation flows | 기존 Vacay rows를 transaction으로 보존 | holiday overlay, fusion/year/invite topology, carry/balance rollback tests | 공식 release가 각 독립 invariant와 negative data test를 수용 |
| Packing + Todo/List product | fork-core addon; `ADDON_IDS.PACKING` | `server/src/nest/{packing,todo,trips,notifications}/`, trip read model/public share projection, client trip hydration, planner desktop/mobile, packing/todo MCP/RPC | official packing/todo tables + retained fork ledger | REST 404-before-auth, bundle/public-share/copy no-query, plugin RPC/reminder no-side-effect, cold/reconnect hydration wait, disabled planner/share/admin mount 없음, MCP unavailable | 공식 addon lifecycle이 packing/todo/admin/share/aggregate/copy/scheduler surface를 함께 gate |
| Packing privacy and template scope | upstream-contrib 후보 / fork-core; always-on while Packing is enabled | packing service/contracts/UI/plugin host permissions | `jsnetworkcorp.packing-template-*` fork migrations 및 core rows | cross-user read/write negatives, template graph/concurrency, migration replay/restore | 공식 release가 Personal/Shared 및 template scope 계약을 수용; schema는 별도 retirement |
| Google place enrichment and hard cap | fork-core provider adapter; config toggles | maps/places/enrichment, Google usage module, admin desktop/mobile | `google_api_usage` fork state와 encrypted config | no-key/no-call, pre-call reservation/cap, admin auth/redaction, concurrent usage tests | provider port와 native UI hook이 공식/SDK에 생기고 ledger를 안전하게 이전 |
| Calendar week start | upstream-contrib 후보; user setting | display settings, common/Journey/Vacay pickers | `calendar_week_start`; legacy Vacay field는 read fallback | Sunday/Monday/fallback parity across desktop/mobile/pickers | 공식 release가 사용자별 공용 setting과 legacy fallback을 제공 |
| Map/iPad/mobile interaction fixes | upstream-contrib 후보; always-on correctness | adaptive map controls, touch drag bridge, sheet/scroll helpers and paired desktop/mobile tests | 없음 | responsive widths, pointer/touch cleanup, focus/scroll browser tests | 공식 release가 같은 device/state matrix를 통과 |
| Packing template exact-once UI | upstream-contrib 후보; always-on correctness | desktop/mobile packing template managers | 새 schema 없음 | IME/repeat, Enter+blur, single-flight, stale response, count reconciliation | 공식 양쪽 UI가 같은 request-count/concurrency suite를 통과 |
| Audit/auth/privacy redaction fixes | fork-core 또는 upstream-contrib 후보; always-on security | audit/auth/storage/plugin boundary와 negative tests | 기존 audit/security state | secret non-disclosure, unauthorized/cross-user negatives | 공식 release가 동일 negative tests를 통과 |
| Account-scoped offline/session fencing | upstream-contrib 후보; always-on privacy/correctness | `client/src/db/offlineDb.ts`, `client/src/{repo,store,sync}/`의 lease adapters | 사용자별 Dexie DB, 브라우저 cache와 pending mutation; 새 server schema 없음 | logout/account-switch 중 늦은 REST·Dexie·WS 응답이 새 계정에 적용되지 않음, teardown 후 재로그인, offline boot/retry, stale mutation negative tests | 공식 release가 DB·cache·store·sync 전 경계에 같은 account generation 계약을 제공 |
| Backup operation isolation | upstream-contrib 후보; always-on data-safety | `server/src/nest/backup/`, request quiescence interceptor, plugin runtime lifecycle, deployment runbook | backup archives, restore journal, host-local rollback snapshots | concurrent create/restore serialization, process-wide request/background-work drain, unique scratch/final paths, crash recovery, failed-operation cleanup isolation; deployment rollback uses write-stopped full-state snapshot | 공식 release가 동시성 회귀와 process-wide maintenance/crash-recovery 계약을 제공 |
| Restore session-authority boundary | upstream-contrib 후보; always-on auth/data-safety | `server/src/nest/auth/session-{authority,revocation}.ts`, `server/src/nest/backup/restored-auth-state.ts`, restore rollback path | `.session-revocations-pending`, `.jwt_secret`의 존재/내용 및 live JWT binding; 값은 문서화하지 않음 | 복원 성공 시 기존 session lineage 폐기, 시작 시 journal replay/fail-closed, 실패 시 파일과 live authority가 함께 원복, 두 번째 복원/migration도 멱등 | 공식 release가 backup restore와 durable session revocation/JWT authority를 하나의 원자적 계약으로 제공 |
| Custom SemVer display/update comparison | fork-core; build metadata | app config/update service/admin banner | 없음 | same-release build metadata comparison and exact public version | 공식 release가 SemVer build metadata precedence를 올바르게 처리 |
| Optional Sonar Scan provider | instance-only CI provider adapter; default skip unless `SONAR_ENABLED=true` | `.github/workflows/test.yml`, `scripts/ci-workflow-contract.test.mjs`, `sonar-project.properties`, `README.md` | repository vars `SONAR_ENABLED`/`SONAR_PROJECT_KEY`/`SONAR_ORGANIZATION`와 secret `SONAR_TOKEN`; same-workflow coverage artifact reuse | `node --test scripts/ci-workflow-contract.test.mjs`, workflow YAML parse, `git diff --check`, historical run `33970857309` | `SONAR_ENABLED=false` 또는 vars/secret/identity 삭제; checked-in Sonar badge/identity 제거가 app runtime, DB, deploy에 영향 없음 |
| Android identity and OCI/Compose settings | instance-only | `android/twa/`, platform release route, host-local Compose/runbook | signing/host state는 Git 밖 | signed artifact/asset links, immutable ARM64 image, Compose diff/health | 운영 채널 폐기 또는 별도 배포 시스템으로 이전 |

## Upgrade procedure

1. 공식 tag의 peeled commit을 기록하고 isolated merge의 parent로 보존한다.
2. 위 각 행의 owning seam이 이동했는지 확인하고, 구현이 아니라 required evidence를
   먼저 새 upstream owner에 이식한다.
3. addon/config/user-setting/always-on/instance-only 분류가 바뀌면 이 manifest와 설계를
   먼저 갱신한다.
4. 공식 동등 기능이 보여도 즉시 포크 코드를 지우지 않는다. 동일 회귀가 통과한 tag에서
   local adapter와 test를 함께 retirement한다.
5. official numeric migration과 `fork_schema_migrations` string id를 합치거나 이미 배포한
   migration 구현을 수정하지 않는다.
6. 배포 전 immutable image, production-copy migration, full-state restore rehearsal과
   이전 image+backup pair를 새로 만든다.
7. upstream sync가 CI 또는 Sonar seam을 건드리면
   `node --test scripts/ci-workflow-contract.test.mjs`를 먼저 실행한다. repository settings가
   새 fork identity로 검증되기 전에는 `SONAR_ENABLED`를 `false`로 유지한다.

## Detachment acceptance

- 선택 addon을 끄면 새로고침 뒤 내비게이션, 직접 route, REST, MCP/plugin RPC,
  public/bundle projection, desktop/mobile panel과 admin 전용 feature UI가 모두 닫힌다.
- config provider를 끄면 외부 호출과 과금 ledger 증가가 멈추고 OpenFreeMap 등 명시된
  fallback은 계속 동작한다.
- `SONAR_ENABLED`가 없거나 `true`가 아니면 Optional Sonar Scan은 의도적으로 skip되고 core
  10 jobs는 Sonar 계정 없이 실행된다. `true`일 때만 `SONAR_TOKEN`,
  `SONAR_PROJECT_KEY`, `SONAR_ORGANIZATION`이 필요하며 누락 시 preflight가 값을
  노출하지 않고 fail-closed한다.
- addon을 다시 켜면 schema backfill이나 data restore 없이 기존 데이터가 보인다.
- checked-in upstream Sonar identity와 badge는 제거되고 fork identity는 repository
  settings에서만 주입한다.
- always-on invariant는 별도 기능처럼 토글하지 않으며, upstream parity가 입증되면 작은
  revertable patch/test 단위로 제거한다.
- 다음 release merge는 공식 source를 baseline으로 두고 이 manifest의 seam만 재검토한다.
