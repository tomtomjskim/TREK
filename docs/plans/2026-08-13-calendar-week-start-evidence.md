# Calendar Week Start Verification Evidence

## Result

`feat/calendar-week-start`에서 사용자별 `calendar_week_start: 0 | 1` 설정을 구현했다.
설정 화면에서 Sunday/Monday를 한 번 선택하면 공용 날짜 picker, Journey picker와
Vacay 월 달력이 같은 값을 사용한다. 값이 없는 기존 사용자에게는 공용 picker가
Monday를 사용하고, Vacay만 기존 plan 값을 compatibility fallback으로 보존한다.

TOM의 승인 뒤 검증된 tree를 개인 포크 `main`에 fast-forward하고 개인 `origin`에
push한 다음, 같은 source를 ARM64 불변 image로 빌드해 운영 배포했다. 공식
`liketrek/TREK` issue/PR/branch에는 변경을 제출하지 않았다.

## Contract and ownership

| Surface     | Contract                                                                   |
| ----------- | -------------------------------------------------------------------------- |
| 저장        | 인증 사용자별 generic `/api/settings` key/value row; migration 없음        |
| 값          | `0` = Sunday, `1` = Monday; invalid/unset 공용 기본값은 Monday             |
| UI          | Settings → General → Language & region, Time Format 다음의 단일 control    |
| 공용 소비자 | Trip/Reservation/Todo/Budget 등이 사용하는 `CustomDatePicker`              |
| 별도 소비자 | Journey `DatePicker`                                                       |
| Vacay       | 개인 설정 우선 → legacy `vacay_plans.week_start` → Monday                  |
| 호환        | legacy column/API 유지, Vacay plan 편집 control만 제거, 자동 backfill 없음 |

핵심 구현 commit은 `848924f9`, `914fd57e`, `80c2fb44`, `80db4d32`다. 최종 문서와
E2E commit을 포함한 runtime source는
`7a50356e4cc469ea8cab902739642cf62e8ef24c`다.

## Verification

| Gate               | Result                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| RED→GREEN coverage | helper normalization/offset, Settings default/save/error, shared·Journey picker order/offset, Vacay precedence/fallback/control ownership |
| Focused Vitest     | 7 files, 108 tests passed                                                                                                                 |
| TypeScript         | client and shared `tsc --noEmit` passed                                                                                                   |
| Strict i18n parity | file parity and key parity passed for all supported locales                                                                               |
| ESLint             | passed with 0 errors; 1,269 existing repository warnings remain                                                                           |
| Production build   | shared and client builds passed; existing ineffective-import and large-chunk warnings remain                                              |
| Browser E2E        | auth setup + 390×844 + 1440×900 = 3 passed                                                                                                |
| Patch hygiene      | `git diff --check` passed                                                                                                                 |

Browser E2E asserts settings PUT success, `aria-pressed`, keyboard focus, reload persistence,
visible Sunday-first shared picker, horizontal overflow, browser page errors and console
errors. It resets the test user's setting to Monday after each scenario. The screenshot step
waits for the picker animation itself rather than using a fixed timeout; `/tmp` contains
separate settings and picker captures for both viewports.

The repository-wide client format gate is not green on the base revision. A changed-path
comparison found the same ten existing files out of format before and after this branch;
new helper/test/E2E files and this evidence document pass Prettier. This branch therefore
adds no formatting regression, but it does not claim to repair the repository baseline.

E2E uses isolated backend port `3301`, not the operational `3001`. Its disposable database
setup emits pre-existing non-fatal duplicate-column migration warnings; all migrations finish,
the application starts, and both browser scenarios have no page or console errors.

## Main integration and production deployment

- 개인 포크 `main`을 `68e6b7df`에서 runtime source `7a50356e`로 `--ff-only`
  통합하고 개인 `origin/main`에 push했다. 공식 upstream에는 push하거나 PR을 열지
  않았다.
- 통합 전 root `npm test`가 exit 0이었고, 통합 후 shared/server/client typecheck,
  strict i18n parity, focused calendar 6 files/95 tests와 root production build가
  통과했다. build에는 기존 large-chunk/ineffective dynamic import 경고만 남았다.
- native `linux/arm64` image `trek:3.4.1-jsnetworkcorp-7a50356e`를 배포했다. image
  ID는 `sha256:97a4312f262b53c36bc3364ba62ae84282782003db7b68b59ebc60f37c02bd07`,
  public version은 `3.4.1+jsnetworkcorp.7a50356e`다.
- 운영 교체 전 online backup은
  `/app/data/backups/predeploy-calendar-week-start-20260814T004949Z-travel.db`이며,
  mode `0600`, 크기 2,592,768 bytes, SHA-256
  `4060209729727d210f6cebd28bb1ac8949d10de71cfc9ab34013c87cae5985cd`다.
  live/backup 모두 `quick_check=ok`, FK violation 0이었다.
- app container만 재생성해 block-volume data/uploads mount와 loopback port를
  보존했다. 배포 후 container는 healthy/restart 0이고 시작 오류 신호는 0이다.
  local/public health와 HTTPS homepage `200`, HTTP→HTTPS `301`, 비인증 settings
  `401`, nginx config를 확인했다.
- 공개 Chromium smoke는 로그인 화면, secure context, manifest `200`, active 및
  controlling Service Worker, 정확한 app version, 비예상 console/page/network
  오류 0을 확인했다. 실제 사용자 계정으로 로그인하거나 운영 데이터를 열지 않았다.
- 2026-08-14 TOM의 운영 인수에서 비용 추가 화면의 날짜 picker가 저장된 주 시작
  설정을 정상 반영하는 것을 확인했다. 이는 운영 계정에서 확인한 shared picker
  consumer 수용 증거이며, 자동화가 사용자 계정으로 로그인하거나 데이터를 변경한
  결과가 아니다.
- 즉시 rollback image는 `trek:3.4.1-jsnetworkcorp-68e6b7df`다. schema migration과
  backfill이 없으므로 문제 발생 시 image reference만 되돌린다.

## Review and residual risk

- Bounded adversarial review result: pass, with 0 blockers and 0 major findings across
  product ownership, UX/accessibility, settings architecture, auth/privacy, rollback and
  evidence. Repository baseline warnings remain observations, not branch regressions.
- 새 key는 기존 settings API가 임의 key와 JSON-compatible scalar를 저장하므로 DB
  migration이 필요 없다. admin default allowlist에는 의도적으로 추가하지 않았다.
- legacy Vacay 값은 삭제하지 않아 rollback 시 기존 앱이 다시 읽을 수 있다.
- 저장 API는 optimistic update 실패 시 값을 자동 rollback하지 않는 기존 store
  contract를 그대로 따른다. 사용자는 toast를 받고 reload 시 서버 값을 다시 읽는다.
- 날짜 직렬화, 선택, 월 이동, timezone 계산은 변경하지 않았다.
- 공식 기여 재개 시 최신 `upstream/dev`에서 기능 commit만 재구성하고 fork 문서나
  instance 운영 이력을 포함하지 않는다.

## Rollback

기능·Settings·picker·Vacay commit을 역순으로 revert한다. schema migration과
backfill이 없으므로 DB rollback은 없다. 남아 있는 `calendar_week_start` setting row는
이전 버전이 무시하며, legacy Vacay plan 값은 계속 보존된다.
