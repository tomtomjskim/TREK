# Vacay Employment and Balance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the current Vacay data-correctness hazards first, then add a backwards-compatible employment, leave-period, and personal balance model in fork-validated slices that can later be extracted for maintainer-approved upstream contributions.

**Architecture:** Keep plans as collaboration projections while users own employment, policy, entries, and balances. Ship the smallest usable single-employment slice, use immutable period and minute-basis snapshots, an append-only adjustment journal, entry-owned usage, shared authorization across REST/MCP/plugin surfaces, and a confirmed one-way legacy activation.

**Tech Stack:** TypeScript, NestJS, better-sqlite3, Zod, React 19, Zustand, Vitest, Testing Library, Playwright

---

> 작성일: 2026-07-28
> 상태: 3관점 적대 리뷰 PASS, fork-first pilot 실행 가능, 공식 기여 보류
> 설계: [Vacay employment and balance design](2026-07-28-vacay-employment-balance-design.md)
> 제안: [Vacay upstream correctness proposal](2026-07-28-vacay-upstream-correctness-proposal.md)
> 리뷰: [Vacay adversarial review](2026-07-28-vacay-employment-balance-adversarial-review.md)
> 정책: [Fork-first validation policy](../upstream/fork-first-validation-policy.md)

## 실행 원칙

- 현재 실행은 `origin/main` 기반의 격리 worktree에서 하는 로컬·개인 포크
  pilot이다. 아래 correctness 항목은 각각 별도 test와 commit으로 유지한다.
- feature slice는 correctness 결과 뒤에 파일과 fork migration ID를 다시 확인하고
  실행한다. 포크 migration은 공식 numeric slot을 사용하지 않는다.
- Discord 게시, 공식 issue/discussion, `upstream-contrib` branch와 공식 PR 작업은
  현재 실행 대상이 아니다.
- 향후 공식 기여를 재개할 때 아래 `upstream/dev`·Discord·PR 지시는 “기여 재개용
  extraction lane”에만 적용한다. 포크 feature branch를 그대로 공식 PR로 보내지 않는다.
- 개인 포크 push/PR, 포크 `main`, 운영 DB, Compose와 이미지는 각각 TOM의 해당
  작업 명시 승인 없이는 이 계획의 대상이 아니다.
- Architecture gate는 `full_gate_required`, rollback class는 `data_migration`이다.
- upstream의 one-change-per-PR과 제품의 usable release를 구분한다. 여러 작은
  feature PR이 합쳐져도 R1 수직 흐름을 통과하기 전에는 MVP 완료로 부르지 않는다.

### Task 0A: Refresh The Fork Pilot Baseline And Select One Scope

**Files:**

- Read: `AGENTS.md`
- Read: `docs/upstream/fork-first-validation-policy.md`
- Read: current fork `package.json` and relevant workspace package/config files
- Read: relevant Vacay source and tests listed in Task 0B

**Steps:**

1. Confirm the worktree is based on the intended `origin/main` and both remotes
   still have the documented roles.
2. Fetch `upstream/dev` read-only to detect source or contract drift; do not
   create an upstream branch or external post.
3. Select exactly one correctness item or one dependency-ordered feature slice.
4. Record lane, fork migration ownership, focused RED test, full-gate impact and
   retirement signal.
5. Implement only that slice, then stop before personal-fork push, `main`
   integration or deployment unless TOM separately requests it.

### Task 0B: Future Upstream Contribution Gate

Run this task only after TOM explicitly reactivates official contribution.

**Files:**

- Read: `CONTRIBUTING.md`
- Read: `.github/PULL_REQUEST_TEMPLATE.md`
- Read: `.github/workflows/enforce-target-branch.yml`
- Read: `.github/workflows/test.yml`
- Read: `package.json`
- Read: `nest-mcp/package.json`
- Read: `server/src/db/migrations.ts`
- Read: `server/src/nest/vacay/vacay.service.ts`
- Read: `server/src/nest/vacay/vacay.mcp.ts`
- Read: `server/src/nest/plugins/host/plugin-host-deps.factory.ts`
- Read: `server/src/nest/plugins/host/rpc-host.ts`
- Read: `server/tests/unit/nest/vacay.service.test.ts`
- Read: `docs/plans/2026-07-28-vacay-upstream-correctness-proposal.md`

**Steps:**

1. Fetch current upstream without changing the deployment branch:

   ```bash
   git fetch --prune upstream dev main --tags
   git rev-parse upstream/dev
   ```

2. Compare the current policy and Vacay paths with the `292f1b18` design
   snapshot. Update the plan when symbols, tests, or contribution rules moved.
3. Search open issues, PRs, and Discord for the four proposed corrections.
4. Post only the first Discord draft from the proposal document.
5. Record the maintainer response and select exactly one approved PR scope.
6. Stop the upstream extraction lane if no scope is approved. The already
   authorized fork pilot remains a separate workflow.

### Task 1: Create An Isolated Approved-PR Worktree

Run this task only after Task 0B approval. For the current fork pilot, use the
existing block-volume fork worktree and do not create `upstream-contrib/*`.

Tasks 1–12 below preserve the future upstream extraction sequence. A current
fork pilot may reuse the matching RED specification and technical checks, but
must replace PR/Discord steps with Task 0A, use fork migration ownership and
record the selected slice in a fork-pilot evidence update before implementation.

**Files:**

- No source changes.

**Steps:**

1. Derive the topic from the approved scope:

   ```bash
   git worktree add \
     /mnt/oci-block-volume/worktrees/TREK/upstream-<topic> \
     -b upstream-contrib/<topic> upstream/dev
   ```

2. Confirm the branch contains no fork-only commits:

   ```bash
   git -C /mnt/oci-block-volume/worktrees/TREK/upstream-<topic> \
     log --oneline --decorate -n 3
   git -C /mnt/oci-block-volume/worktrees/TREK/upstream-<topic> status --short
   ```

3. Run `npm ci` in that worktree and record the baseline focused tests.
4. Execute only the matching task below.

## Independent Correctness PR Tasks

### Task 2A: Keep Carry Projection Read-Only And Fresh

Execute only when Discord approves the stats scope.

**Files:**

- Modify: `server/tests/unit/nest/vacay.service.test.ts`
- Modify: `server/tests/integration/vacay.test.ts`
- Modify: `server/tests/unit/mcp/tools-vacay.test.ts`
- Modify: `server/src/nest/vacay/vacay.service.ts`

**Steps:**

1. Record the maintainer-approved authoritative meaning of legacy
   `carried_over`. Prefer a pure projection from the previous period; stop if
   the expected meaning is not agreed.
2. Add a service RED test for an established personal plan that seeds the next
   year, snapshots `vacay_user_years`, reads `SELECT total_changes()`, calls
   `getStats`, and asserts the response while requiring zero DB changes.
3. Add a RED sequence: create/read next-year stats, change the previous
   year's entry or allowance, then require the next-year stats to return the
   new carry without persisting it.
4. Run:

   ```bash
   npm run test --workspace=server -- \
     tests/unit/nest/vacay.service.test.ts
   ```

   Confirm RED because `getStats()` currently upserts the next-year row.

5. Add REST and MCP RED tests using exact Vacay table snapshots. Do not use
   global `total_changes()` for integration requests that may write session or
   audit state.
6. Characterize first-plan lazy provisioning separately; do not claim this PR
   makes a missing-plan GET fully side-effect free.
7. Replace the next-year UPSERT with the selected fresh projection. Keep the
   response shape, current-period arithmetic, half-day and comp behavior
   unchanged.
8. Re-run the three focused suites until GREEN.
9. Run server typecheck, full server tests and coverage:

   ```bash
   npm run typecheck --workspace=server
   npm run test --workspace=server
   npm run test:coverage --workspace=server
   ```

10. Review the diff for any remaining carry write reachable from established
    plan `get_vacay_stats`.
11. Commit only this fix:

```bash
git add server/src/nest/vacay/vacay.service.ts \
  server/tests/unit/nest/vacay.service.test.ts \
  server/tests/integration/vacay.test.ts \
  server/tests/unit/mcp/tools-vacay.test.ts
git commit -m "fix(vacay): keep carry projection read-only"
```

### Task 2B: Preserve Entries Under Holiday Overlays

Execute only when Discord approves the holiday scope.

**Files:**

- Modify: `server/tests/unit/nest/vacay.service.test.ts`
- Modify: `server/tests/integration/vacay.test.ts`
- Modify: `server/src/nest/vacay/vacay.service.ts`

**Steps:**

1. Change `VACAY-SVC-036` into a RED preservation test: entry ID, author,
   fraction and kind survive company-holiday add/remove.
2. Change `VACAY-SVC-047` into a RED preservation test: provider refresh
   preserves personal entries and manual company holidays.
3. Add RED stats tests proving a durable manual company holiday makes the
   overlapping vacation entry non-deducting and removing the holiday includes
   the preserved entry again.
4. Add a two-user and two-plan negative fixture so no cross-user/plan row is
   changed.
5. Run the two owning suites and confirm RED:

   ```bash
   npm run test --workspace=server -- \
     tests/unit/nest/vacay.service.test.ts \
     tests/integration/vacay.test.ts
   ```

6. Remove only the destructive entry/company-holiday deletes in
   `toggleCompanyHoliday`, `updatePlan` and `applyHolidayCalendars`; preserve
   non-deduction arithmetic for stored manual company holidays.
7. Do not add automatic entitlement rewriting, holiday classification UI or
   provider persistence in this PR. Public provider refresh must preserve the
   entry but cannot claim immutable historical non-deduction until Task 8 adds
   durable occurrences.
8. Re-run focused tests, server typecheck, full server tests and coverage.
9. Commit only this fix:

   ```bash
   git add server/src/nest/vacay/vacay.service.ts \
     server/tests/unit/nest/vacay.service.test.ts \
     server/tests/integration/vacay.test.ts
   git commit -m "fix(vacay): preserve entries under holiday overlays"
   ```

### Task 2C: Preserve User-Year State On Dissolution

Execute only when Discord approves the fusion/dissolution scope.

**Files:**

- Modify: `server/tests/unit/nest/vacay.service.test.ts`
- Modify: `server/tests/integration/vacay.test.ts`
- Modify: `server/src/nest/vacay/vacay.service.ts`

**Steps:**

1. Add RED fixtures for member self-dissolve and owner full-dissolve. Seed
   different old personal and latest fused `vacation_days`/`carried_over`
   values.
2. Assert latest values return to the correct personal plan, without duplicate
   rows or cross-user swaps.
3. Add join → fused edit → leave → solo edit → same-plan rejoin fixtures and
   require the solo latest values to win without stale shared rows.
4. Add a forced mid-upsert failure and assert membership, entries and
   user-year rows all rollback.
5. Run the owning service/integration suites and confirm RED.
6. Inside the existing dissolution transaction, upsert each affected user's
   current plan rows into that user's own plan and remove that member's stale
   shared user-year rows before deleting membership. If maintainers choose
   join-time upsert instead, encode the same authoritative lifecycle explicitly.
7. Keep current entry and company-holiday behavior otherwise unchanged.
8. Re-run focused tests, server typecheck, full server tests and coverage.
9. Commit only this fix:

   ```bash
   git add server/src/nest/vacay/vacay.service.ts \
     server/tests/unit/nest/vacay.service.test.ts \
     server/tests/integration/vacay.test.ts
   git commit -m "fix(vacay): preserve user-year state after plan dissolution"
   ```

### Task 2D: Stop Moving Unlinked Vacay Entries With Trips

Execute only when Discord approves the trip scope.

**Files:**

- Modify: `server/tests/unit/services/tripService.test.ts`
- Modify: `server/tests/unit/mcp/tools-trips.test.ts`
- Modify: `server/tests/unit/nest/vacay.service.test.ts`
- Modify: `server/src/services/tripService.ts`
- Modify or delete if unreferenced: `server/src/nest/vacay/vacay.bridge.ts`

**Steps:**

1. Replace the MCP and bridge characterization with RED tests requiring
   in-window and out-of-window Vacay rows to remain byte-for-byte unchanged
   after a trip date edit.
2. Add a service-level test that still validates existing reservation,
   accommodation and `date_shift_mode` behavior.
3. Run:

   ```bash
   npm run test --workspace=server -- \
     tests/unit/services/tripService.test.ts \
     tests/unit/mcp/tools-trips.test.ts \
     tests/unit/nest/vacay.service.test.ts
   ```

4. Confirm RED because `updateTrip()` calls
   `shiftOwnerEntriesForTripWindow()`.
5. Remove the implicit call/import. Delete the bridge only if `git grep` proves
   it has no remaining consumer; do not bundle other bridge cleanup.
6. Re-run the focused tests, server typecheck, full server tests and coverage.
7. Commit only this fix:

   ```bash
   git add server/src/services/tripService.ts \
     server/src/nest/vacay/vacay.bridge.ts \
     server/tests/unit/services/tripService.test.ts \
     server/tests/unit/mcp/tools-trips.test.ts \
     server/tests/unit/nest/vacay.service.test.ts
   git commit -m "fix(trips): stop moving unrelated vacay entries"
   ```

### Task 3: Complete One Correctness PR Gate

**Files:**

- Modify only documentation requested by the maintainer.

**Steps:**

1. Rebase or recreate the local branch on the latest `upstream/dev` if it moved.
2. Run root tests, typecheck, non-mutating lint/format checks, coverage and
   production build:

   ```bash
   npm run build --workspace=shared
   npm run build --workspace=nest-mcp
   npm test
   npm run test:cov
   npm run typecheck --workspace=shared
   npm run typecheck --workspace=nest-mcp
   npm run typecheck --workspace=server
   npm run typecheck --workspace=client
   npm run i18n:parity:strict --workspace=shared
   npm exec --workspace=shared -- eslint "src/**/*.ts"
   npm run lint:check --workspace=nest-mcp
   npm run lint:check --workspace=server
   npm run lint:check --workspace=client
   npm run lint:pages --workspace=client
   npm run format:check
   npm exec -- prettier --check "server/tests/**/*.ts"
   npm run build
   (cd server && node --require tsconfig-paths/register -e "require('@trek/nest-mcp')")
   git diff --check upstream/dev...HEAD
   ```

   Root `npm run lint` is intentionally excluded because some workspaces run
   `eslint --fix` and mutate the review diff.

3. Confirm coverage remains at least the project threshold and no verification
   command changed tracked files.
4. Run an independent blocker-first review for correctness, auth/privacy,
   migrations, concurrency and missing tests.
5. Prepare the PR template with the Discord approval reference and one focused
   change only.
6. Stop before push/PR. Ask TOM for explicit official-repository publication
   approval.

## R0 → R1 Dependency Gate

Maintainer가 correctness 일부를 거절해도 무관한 v2 schema 연구까지 막지는 않지만,
관련 legacy 경로를 우회해 출시해서는 안 된다.

| R1 surface                    | 필요한 R0 결과                  | 미수용 시 fail-closed 범위                                          |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| legacy carry/stats projection | Task 2A fresh pure carry        | v2 값을 legacy carry endpoint에 투영하지 않고 신규 v2 query만 사용  |
| holiday import/provider       | Task 2B entry preservation      | provider refresh와 legacy holiday bridge 비활성화, 수동 solo만 허용 |
| fusion cohort activation      | Task 2C + Task 11 access/grants | connected fusion activation 금지, solo/new user만 허용              |
| trip-linked leave             | Task 2D unlinked shift 차단     | `source_trip_id` 생성·이동 UI/API를 비활성화                        |

각 feature task는 시작할 때 이 표를 다시 평가하고 accepted commit 또는
fail-closed negative test를 evidence로 남긴다. 전체 R1 release는 선택한 persona의
경로에 필요한 dependency가 모두 닫힌 경우에만 가능하다.

## Feature Tasks — Run Only After Maintainer Direction

### Task 4: Rebaseline The V2 Contract

**Files:**

- Modify: `docs/plans/2026-07-28-vacay-employment-balance-design.md`
- Modify: `docs/plans/2026-07-28-vacay-employment-balance.md`

**Steps:**

1. Fetch the current dev branch after accepted correctness work.
2. Record the current migration count and all Vacay schema/API changes.
3. Incorporate maintainer decisions on:
   - whether employment belongs in core;
   - whether the first slice may add API without complete UI;
   - compatibility duration for legacy plan/year endpoints;
   - preferred naming for employment and leave periods.
4. Measure the target Fold 7 CSS viewport, orientation and browser chrome
   before UI PR selection. Record the current route matrix:
   `<768px → MVacay`, `>=768px → VacayPageDesktop`, and assign every measured
   Fold state to the component it actually renders.
5. Freeze a surface matrix for REST, MCP, plugin and WebSocket. For every
   command/query record actor, owner, capability, idempotency, revision and
   redacted response/event fields.
6. Re-run architecture, product/UX and adversarial review against the updated
   contract.
7. Obtain a second Discord approval for exactly one feature PR below before
   writing source code.

### Task 5A: Add Employment And Leave-Period DDL Invariants

Execute only if maintainers accept core-owned employment/period data.

**Files:**

- Modify: `server/src/db/migrations.ts`
- Modify: `server/src/db/schema.ts`
- Create: `server/tests/unit/db/vacay-v2-migration.test.ts`
- Modify: shared Vacay schema/tests only when required by the approved DDL

**Steps:**

1. Write RED migration fixtures for fresh DB, stock release DB, current dev DB,
   repeated execution, invalid dates and cross-owner references.
2. Append the next current migration slot. Add only employment, policy and
   leave-period tables; do not backfill legacy rows.
3. Enforce `[start, end)`, one active employment per user in R1,
   policy/period non-overlap, same-employment composite ownership, positive
   day-minute bounds, immutable period snapshot columns and legal state
   transitions with CHECK/FK/UNIQUE/trigger constraints.
4. Put one `revision` on the employment aggregate for employment/policy/period
   lifecycle commands and one on each leave-period aggregate for later
   balance/entry commands.
5. Add fixtures for a `2026-07-15` hire with January-cycle period versus
   employment coverage, the exact first and next boundary under both February
   29 leap rules, cross-year periods, inclusive UI/exclusive DB termination
   boundaries and rejection of new entries outside employment coverage.
6. Run migration tests against fresh and upgraded copies, then Task 3 gate.
7. Commit only this schema seam:

   ```bash
   git commit -m "feat(vacay): add leave period schema"
   ```

### Task 5B: Add Self-Only Employment Commands And Queries

Execute as a separate approved PR after Task 5A is accepted.

**Files:**

- Modify: `server/src/db/migrations.ts`
- Modify: `server/src/db/schema.ts`
- Modify: `server/tests/unit/db/vacay-v2-migration.test.ts`
- Create: `server/src/nest/vacay/vacay-access.policy.ts`
- Create: `server/src/nest/vacay/vacay-employment.service.ts`
- Modify: Vacay module/controller/DTO/MCP and shared schema owning files
- Modify: owning unit, integration, MCP, plugin capability and e2e tests

**Steps:**

1. Write RED permission tests for owner, fusion member, busy viewer and admin
   across REST/MCP/plugin. An unsupported plugin v2 write must fail closed;
   fusion membership must never imply employment write.
2. Add command-receipt DDL with unique `(actor_id, operation, key)`, request
   hash, status and serialized result. Do not reuse the post-response HTTP
   interceptor as the v2 source of truth.
3. Add create/read/close commands with `expected_revision`. Employment, policy
   and period lifecycle uses `EmploymentPeriod.revision`; later journal/entry
   commands use `LeavePeriod.revision`. R1 policy changes take effect only on
   the next leave-period boundary.
4. Recheck overlap and revision inside the write transaction and return
   structured `409` without discarding the submitted draft.
5. Claim the receipt, execute the domain write, increment revision and persist
   the result in one application-service transaction. Same key/different
   payload is `409`.
6. Make existing endpoints call the same access policy or explicitly reject
   v2 writes. Characterize first-plan lazy provisioning instead of hiding it.
7. Expose a read-only v2 candidate projection; do not infer or write a company
   record.
8. Race REST, MCP and unsupported plugin calls against the same key/revision and
   prove the shared transaction applies one write or fails closed.
9. Run the cross-surface negative permission matrix and Task 3 gate.
10. Commit only this access/API slice:

```bash
git commit -m "feat(vacay): add self-owned leave periods"
```

### Task 6: Add Opening Journal And Entry Commands

Execute as a separate approved PR after Tasks 5A–5B are accepted.

**Files:**

- Modify: `server/src/db/migrations.ts`
- Modify: `server/src/db/schema.ts`
- Create: `server/src/nest/vacay/vacay-balance.service.ts`
- Modify: Vacay module/controller/DTO/MCP and shared schema owning files
- Modify: owning migration, unit, integration, MCP and e2e tests

**Steps:**

1. Write RED tests for both opening modes, inclusive cutoff, pre/on/post-cutoff
   taken versus planned, `taken_only` versus `taken_and_planned`, late
   backdated entry, signed negative opening, 480/240 minute basis snapshots and
   `comp` summary separation.
2. Add signed journal rows and entry status/balance-effect fields. Enforce one
   active opening, exact single reversal, immutable journal rows, positive
   entry quantities, one non-cancelled entry per employment/date in R1 and
   same-employment composite ownership in the DB. Store cutoff/scope only in
   active opening metadata; period/query values are derived.
3. Implement journal `create/read/reverse`, planned direct edit and taken
   `cancel + replacement` commands through the receipt/revision contract.
4. Implement pure projections:

   ```text
   current = sum(signed journal) - deductible taken
   available_after_planned = current - deductible planned
   ```

5. Do not mutate `planned` on GET. Use employment timezone to derive
   `needs_confirmation`, then require an explicit confirmation command.
6. Treat every imported or existing entry on/before
   `usage_included_through` as `included_in_opening` only when it is taken, or
   when the user confirms `usage_scope=taken_and_planned`. Default planned
   entries remain deductible.
7. Allow R1 opening replacement only with the same cutoff and usage scope.
   Reject cutoff/scope changes until a separately designed rebaseline command
   can preview and atomically reclassify affected entries.
8. Add concurrent-tab tests for receipt retry, changed-payload key reuse,
   stale revision, opening race and reversal race.
9. Run focused tests and Task 3 gate.
10. Commit only this ledger slice:

```bash
git commit -m "feat(vacay): track opening balances and leave status"
```

### Task 7: Add Resumable Legacy Preview And Activation

Execute as a separate approved PR after the v2 read/write contract is accepted.

**Files:**

- Modify: `server/src/db/migrations.ts`
- Modify: `server/src/db/schema.ts`
- Create: importer/reconciliation service selected by maintainers
- Modify: Vacay controller/DTO and owning tests

**Steps:**

1. Add importer states `legacy_active`, `preview`, `review_required`,
   `reconciled`, `activation_locked` and `activated`, plus source checksum and
   provenance. `activation_locked` exists only inside the final transaction.
   Startup migration must not infer/backfill business data or disable v1 writes.
2. Write RED fixtures for multi-plan user-year conflicts, unknown legacy
   day-minute basis, duplicate dates, different-company fusion users, orphan
   rows, interrupted/resumed runs and connected fusion activation refusal.
3. Preview source value, period, entry/holiday counts, opening result and every
   conflict while existing v1 writes remain enabled. Keep plan holidays as
   `legacy_plan_overlay/unverified`.
4. Reconcile owner/FK, source uniqueness, signed sum, quantities, dates,
   conflicts and row counts exactly.
5. R1 activates only new or solo users. In the final write transaction, acquire
   the short lock and recheck solo membership plus every source checksum and
   revision. On mismatch release the lock, return `review_required`, preserve
   v1 writes and require a new preview.
6. On user cancellation discard staged rows and remain `legacy_active`. On
   success atomically switch to v2 single-write, route legacy APIs to v2
   projection and reject legacy writes; never dual-write.
7. Connected fusion users remain v1 until they explicitly dissolve after Task
   2C or Task 11 adds EmploymentAccess and cohort activation.
8. Add activation-failure/cancel rollback tests and an explicit report showing
   whether code-only rollback, staged-row discard or forward-fix is allowed.
9. Run backup/restore rehearsal tests only on disposable fixtures, then Task 3
   gate.
10. Commit only this importer/activation slice:

```bash
git commit -m "feat(vacay): add confirmed legacy activation"
```

### Task 7B: Add The Legacy Review And Activation Wizard

Execute as a separate client PR after Task 7 backend acceptance and before
claiming existing-user R1 completion.

**Files:**

- Modify: desktop/mobile Vacay entry routes selected by the accepted IA
- Create or modify: activation preview, conflict resolution and confirmation UI
- Modify: shared i18n and owning component/Playwright tests

**Steps:**

1. Add RED tests that show source plan/year values, period, entry/holiday
   counts, day-minute basis, expected opening, unverified overlays and every
   importer conflict.
2. Keep only the v2 candidate read-only during preview/review/reconciliation;
   explain that existing v1 remains writable and a changed source will require
   a new preview at final confirmation.
3. For connected fusion users, show activation as unavailable without exposing
   another member's values. Offer only “stay on v1” or the existing explicit
   self-dissolve path after Task 2C; do not claim cohort activation in R1.
4. Require an irreversible single-write transition confirmation that explains
   backup/forward-fix limits. Do not present the UI feature flag as a data
   rollback.
5. Preserve selections and draft explanations in memory across partial error,
   offline and `409` revision conflict, scoped by actor/import preview/base
   revision/checksum. Do not persist sensitive draft fields in browser storage; clear on
   success, cancel, logout, account change or route unmount and warn before
   dirty navigation/reload.
6. Verify cancellation returns to writable `legacy_active` and new-user setup
   remains available without entering this wizard, then
   run accessibility, responsive and Task 3 gates.
7. Commit only the activation UX:

   ```bash
   git commit -m "feat(vacay): add legacy activation review"
   ```

### Task 8: Add Employment Holiday Classification And Projection

Execute as its own approved PR; do not combine it with UI or sharing.

**Files:**

- Modify: Vacay DDL/schema/service/controller/DTO owning files
- Modify: provider adapter and owning unit/integration tests selected by the
  accepted contract

**Steps:**

1. Add RED tests for `public_holiday`, `paid_company_day`,
   `annual_leave_substitution` and `unknown` provenance.
2. Persist versioned holiday occurrences with provider/source identity,
   observed/effective dates, active/superseded state and
   `balance_treatment=pending | non_deduct | deduct` so restart or provider
   failure cannot silently reinterpret past balances.
3. Provider occurrences start as `pending`, preserve every entry and do not
   change balance projection. Apply non-deduction only after explicit user
   confirmation; confirmed deduct keeps the ordinary entry calculation.
4. Do not infer annual-leave substitution from a date or provider label.
   Confirm it only with an explicitly linked deducting vacation entry.
5. Keep provider partial failure and unresolved pending conflicts isolated from
   core balance reads and manual
   entry writes.
6. Run focused tests and Task 3 gate.
7. Commit only the durable occurrence slice:

   ```bash
   git commit -m "feat(vacay): persist employment holidays"
   ```

### Task 9A: Add The Minimal Desktop Flow

Execute after Tasks 5A–8, including Task 7B, are accepted; sharing is not part
of this PR.

**Files:**

- Modify: desktop Vacay page, store, components, i18n and owning tests

**Steps:**

1. Add RED tests for first setup, exact inclusive period label, opening cutoff,
   planned/taken confirmation, holiday conflict, loading/empty/partial error/
   blocking error/conflict/archived/offline states.
2. Implement employment context, balance summary, calendar and correction
   drawer with existing TREK tokens.
3. On conflict preserve the local draft and show refetch/compare/retry. Offline
   may keep read cache and in-memory draft but must disable write; do not add a
   write queue or persistent browser-storage draft. Clear the scoped draft on
   success/cancel/logout/account change/unmount.
4. Implement calendar roving tabindex, arrow/Home/End/Enter/Space, accessible
   date-state labels, drawer focus trap/restoration, 200% zoom and color-
   independent states.
5. Run focused tests, axe/manual keyboard evidence, 1440px Playwright and every
   measured Fold fixture that resolves to `VacayPageDesktop`, then Task 3 gate.
6. Commit only desktop UI:

   ```bash
   git commit -m "feat(vacay): add employment leave desktop flow"
   ```

### Task 9B: Add The Minimal Mobile And Fold Flow

Execute as a separate approved PR after desktop contract acceptance.

**Files:**

- Modify: mobile Vacay screens/hooks/settings sheet, i18n and owning tests

**Steps:**

1. Reuse the Task 4 Fold measurements and assert each `<768px` fixture actually
   resolves to `MVacay`; do not assume every Fold state is mobile.
2. Keep 390px annual view read-only and use a month edit sheet.
3. Add mobile parity tests for first setup, activation review, opening,
   planned/taken confirmation and correction, holiday pending resolution,
   conflict, archived and offline states.
4. At 390px and every measured Fold fixture routed to `MVacay`, assert no
   horizontal overflow, no CTA
   bounding-box collision, 44px targets, visible focused control while the
   sheet scrolls and in-memory draft survival after rotation/conflict.
5. Capture normal, empty, loading, partial/blocking error, conflict, archived
   and offline evidence.
6. Run focused tests and Task 3 gate.
7. Commit only mobile/Fold UI:

   ```bash
   git commit -m "feat(vacay): add responsive leave flow"
   ```

### Task 10: Add Company Change As A Follow-Up Release

Do not include this in the first vertical slice.

1. Show old-employment planned entries, holidays, trip links and grants before
   ending employment.
2. Keep entries on/before the last coverage date unchanged. For every later
   planned entry require `cancelled audit record` or `recreate after new
opening`; default to cancel and never leave an active entry outside coverage.
3. Allow future employment and gaps, reject only overlap, and preserve all
   historical period/journal basis snapshots.
4. Ship backend commands and UI as separately reviewed PRs.

### Task 10B: Add Custom Period And Rebaseline As Separate Follow-Ups

1. Add `custom_once` only with an exact user-confirmed `[start, end)` preview,
   employment coverage checks and immutable period snapshot.
2. Design rebaseline separately from opening replacement. Preview every entry
   whose `balance_effect` changes, then apply opening reversal, new opening and
   entry reclassification atomically.
3. Do not combine custom-period creation and rebaseline in one PR.

### Task 11: Add Busy-Date Sharing And Scoped WebSocket Later

Do not combine access backend, WebSocket and UI in one PR.

1. First PR: `EmploymentAccess` DDL plus grant
   create/accept/revoke/expire/archive lifecycle and negative privacy tests.
2. Payload contains only busy dates; planned and taken are busy, cancelled is
   excluded. Omit employer, dates of employment, policy, balance, journal,
   fraction/status and note.
3. Second PR: post-commit aggregate revision invalidation. A revoked viewer
   receives neither event nor refetch data.
4. Third PR: grant UI and accessibility/responsive evidence.
5. Only after those PRs, add connected-cohort activation: each user confirms
   only their checksum/revision, readiness exposes counts/status only, and the
   final transaction rechecks membership plus all checksums. Until then fused
   users remain v1 or explicitly self-dissolve.

### Task 12: Defer The Korea Policy Provider To R2

**Files:**

- No production source changes in R1.
- Create a new design/implementation plan only after the generic provider
  contract and current law are revalidated.

**Steps:**

1. Recheck current law, effective dates and final subordinate regulations.
2. Define sources as
   `statute/enacted_future/draft/interpretation/counseling` with checked/effective
   dates and binding status.
3. Define a versioned response containing `rule_set_id`, assumptions, unknown
   inputs, source URLs and proposed signed journal commands.
4. Require explicit user confirmation through a host-mediated proposal/apply
   capability; never give a plugin direct core DB access or auto-post legal
   entitlement.
5. Keep HR approval, payroll, attendance and legal certification out of scope.

## Final Release Boundary

Even after upstream PR acceptance, do not deploy `upstream/dev` to the
JSNetworkCorp service. Wait for an official release tag, integrate it in the
fork release-sync worktree, run migration/backup/rollback gates, and obtain a
separate production deployment approval.

During the current publication hold, a fork pilot reaching this boundary still
stops before personal-fork push, `main` integration and deployment unless TOM
explicitly authorizes the corresponding action.
