# Vacay Employment and Balance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the current Vacay data-correctness hazards first, then add a backwards-compatible employment, leave-period, and personal balance model in maintainer-approved upstream slices.

**Architecture:** Keep plans as collaboration projections while users own employment, policy, entries, and balances. Use effective-dated immutable periods, an adjustment-only balance journal, entry-owned usage, shared authorization across REST/MCP/plugin surfaces, and legacy API projections during migration.

**Tech Stack:** TypeScript, NestJS, better-sqlite3, Zod, React 19, Zustand, Vitest, Testing Library, Playwright

---

> 작성일: 2026-07-28
> 상태: 계획 완료, Discord 승인 전 코드 실행 금지
> 설계: [Vacay employment and balance design](2026-07-28-vacay-employment-balance-design.md)
> 제안: [Vacay upstream correctness proposal](2026-07-28-vacay-upstream-correctness-proposal.md)

## 실행 원칙

- 아래 correctness 항목은 각각 별도 `upstream/dev` worktree, branch, commit, PR이다.
- Discord에서 승인된 한 항목만 구현한다. 승인되지 않은 다음 항목을 미리 코딩하지
  않는다.
- feature slice는 correctness 결과와 maintainer 피드백 뒤에 파일·migration slot을
  다시 확인하고 실행한다.
- 공식 branch push와 PR 생성은 Discord 승인과 별개로 TOM의 명시 승인을 다시 받는다.
- 포크 `main`, 운영 DB, Compose와 이미지는 이 계획의 대상이 아니다.

### Task 0: Refresh The Contribution Gate And Select One Scope

**Files:**

- Read: `CONTRIBUTING.md`
- Read: `.github/PULL_REQUEST_TEMPLATE.md`
- Read: `.github/workflows/enforce-target-branch.yml`
- Read: `server/src/nest/vacay/vacay.service.ts`
- Read: `server/tests/unit/nest/vacay.service.test.ts`
- Read: `docs/plans/2026-07-28-vacay-upstream-correctness-proposal.md`

**Steps:**

1. Fetch current upstream without changing the deployment branch:

   ```bash
   git fetch --prune upstream dev main --tags
   git rev-parse upstream/dev
   ```

2. Compare the current policy and Vacay paths with the `351b5fb4` design
   snapshot. Update the plan when symbols, tests, or contribution rules moved.
3. Search open issues, PRs, and Discord for the four proposed corrections.
4. Post only the first Discord draft from the proposal document.
5. Record the maintainer response and select exactly one approved PR scope.
6. Stop if no scope is approved. Do not substitute a fork implementation.

### Task 1: Create An Isolated Approved-PR Worktree

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

### Task 2A: Make Stats Projection Side-Effect Free

Execute only when Discord approves the stats scope.

**Files:**

- Modify: `server/tests/unit/nest/vacay.service.test.ts`
- Modify: `server/tests/integration/vacay.test.ts`
- Modify: `server/tests/unit/mcp/tools-vacay.test.ts`
- Modify: `server/src/nest/vacay/vacay.service.ts`

**Steps:**

1. Add a service RED test that seeds the next year, snapshots
   `vacay_user_years`, reads `SELECT total_changes()`, calls `getStats`, and
   asserts the response while requiring zero DB changes.
2. Run:

   ```bash
   npm run test --workspace=server -- \
     tests/unit/nest/vacay.service.test.ts
   ```

   Confirm RED because `getStats()` currently upserts the next-year row.

3. Add REST and MCP RED tests with the same row snapshot and
   `total_changes()` assertion.
4. Remove the next-year write from `VacayService.getStats()`. Keep the return
   shape, current-period arithmetic, half-day and comp behavior unchanged.
5. Re-run the three focused suites until GREEN.
6. Run server typecheck, full server tests and coverage:

   ```bash
   npm run typecheck --workspace=server
   npm run test --workspace=server
   npm run test:coverage --workspace=server
   ```

7. Review the diff for any remaining write reachable from `get_vacay_stats`.
8. Commit only this fix:

   ```bash
   git add server/src/nest/vacay/vacay.service.ts \
     server/tests/unit/nest/vacay.service.test.ts \
     server/tests/integration/vacay.test.ts \
     server/tests/unit/mcp/tools-vacay.test.ts
   git commit -m "fix(vacay): make stats projection side-effect free"
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
3. Add a two-user and two-plan negative fixture so no cross-user/plan row is
   changed.
4. Run the two owning suites and confirm RED:

   ```bash
   npm run test --workspace=server -- \
     tests/unit/nest/vacay.service.test.ts \
     tests/integration/vacay.test.ts
   ```

5. Remove only the destructive entry/company-holiday deletes in
   `toggleCompanyHoliday`, `updatePlan` and `applyHolidayCalendars`.
6. Do not add automatic entitlement rewriting or provider persistence in this
   PR.
7. Re-run focused tests, server typecheck, full server tests and coverage.
8. Commit only this fix:

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
3. Add a forced mid-upsert failure and assert membership, entries and
   user-year rows all rollback.
4. Run the owning service/integration suites and confirm RED.
5. Inside the existing dissolution transaction, upsert each affected user's
   current plan rows into that user's own plan before deleting membership.
6. Keep current entry and company-holiday behavior otherwise unchanged.
7. Re-run focused tests, server typecheck, full server tests and coverage.
8. Commit only this fix:

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
2. Run root tests, typecheck, lint/format check and production build:

   ```bash
   npm test
   npm run typecheck --workspace=shared
   npm run typecheck --workspace=server
   npm run typecheck --workspace=client
   npm run lint
   npm run format:check
   npm run build
   git diff --check upstream/dev...HEAD
   ```

3. Confirm coverage remains at least the project threshold.
4. Run an independent blocker-first review for correctness, auth/privacy,
   migrations, concurrency and missing tests.
5. Prepare the PR template with the Discord approval reference and one focused
   change only.
6. Stop before push/PR. Ask TOM for explicit official-repository publication
   approval.

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
4. Re-run architecture, product/UX and adversarial review against the updated
   contract.
5. Obtain a second Discord approval for the selected feature slice before
   writing source code.

### Task 5: Add Effective-Dated Employment And Fixed Leave Periods

Execute only if the maintainer selects this first feature slice.

**Files:**

- Modify: `server/src/db/migrations.ts`
- Modify: `server/src/db/schema.ts`
- Create: `server/src/nest/vacay/vacay-employment.service.ts`
- Modify: `server/src/nest/vacay/vacay.module.ts`
- Modify: `server/src/nest/vacay/vacay.controller.ts`
- Modify: `server/src/nest/vacay/vacay.dto.ts`
- Modify: `shared/src/vacay/vacay.schema.ts`
- Modify: `shared/src/vacay/vacay.schema.spec.ts`
- Modify: `server/tests/unit/nest/vacay.service.test.ts`
- Modify: `server/tests/integration/vacay.test.ts`
- Modify: `server/tests/e2e/vacay.e2e.test.ts`

**Steps:**

1. Add shared-schema RED tests for strict ISO dates, `[start, end)`, one active
   employment in MVP, policy non-overlap and closed response objects.
2. Add migration RED fixtures for fresh DB, stock release DB, current dev DB,
   repeat execution and overlapping/invalid legacy rows.
3. Append the next official migration slot; never hardcode the
   `351b5fb4` migration number after dev moves.
4. Add employment, policy segment and leave-period tables with owner FKs,
   date checks, overlap service validation and immutable period snapshots.
5. Implement self-only application service methods and REST DTOs. Do not infer
   write permission from fusion membership.
6. Add legacy read projection for a default employment without changing the
   existing endpoint response shape.
7. Run shared schema, migration, service, REST and e2e tests in that order.
8. Run the full contribution gate from Task 3.
9. Commit this slice only:

   ```bash
   git commit -m "feat(vacay): add effective-dated leave periods"
   ```

### Task 6: Add Opening Balance Journal And Entry Status

Execute as a separate approved PR after Task 5 is accepted.

**Files:**

- Modify: `server/src/db/migrations.ts`
- Modify: `server/src/db/schema.ts`
- Create: `server/src/nest/vacay/vacay-balance.service.ts`
- Modify: `server/src/nest/vacay/vacay.module.ts`
- Modify: `server/src/nest/vacay/vacay.controller.ts`
- Modify: `server/src/nest/vacay/vacay.dto.ts`
- Modify: `server/src/nest/vacay/vacay.mcp.ts`
- Modify: `shared/src/vacay/vacay.schema.ts`
- Modify: `shared/src/vacay/vacay.schema.spec.ts`
- Modify: `server/tests/unit/nest/vacay.service.test.ts`
- Modify: `server/tests/integration/vacay.test.ts`
- Modify: `server/tests/unit/mcp/tools-vacay.test.ts`

**Steps:**

1. Write RED tests for both opening modes, minute quantities, journal reversal,
   planned/taken/cancelled entries, comp non-deduction and idempotent retry.
2. Add the adjustment-only journal and entry status/source fields. Do not add a
   second usage transaction for an entry.
3. Implement one transaction boundary per command and a unique idempotency key.
4. Implement pure balance projections:

   ```text
   current = opening + grants + carry + adjustments - expiry - taken
   available_after_planned = current - planned
   ```

5. Make pre-opening legacy entries visible but non-deducting.
6. Add strict REST and MCP contracts that call the same self-only service.
7. Run focused and full contribution gates.
8. Commit this slice only:

   ```bash
   git commit -m "feat(vacay): track opening balances and planned leave"
   ```

### Task 7: Add Employment-Scoped UI And Busy-Date Sharing

Execute as a separate approved PR after Tasks 5–6 are accepted.

**Files:**

- Modify: `client/src/pages/VacayPage.tsx`
- Modify: `client/src/pages/vacay/useVacay.ts`
- Modify: `client/src/store/vacayStore.ts`
- Modify: `client/src/components/Vacay/VacayStats.tsx`
- Modify: `client/src/components/Vacay/VacayCalendar.tsx`
- Modify: `client/src/components/Vacay/VacaySettings.tsx`
- Modify: `client/src/components/Vacay/VacaySharedCalendars.tsx`
- Modify: `client/src/mobile/screens/vacay/useMVacay.ts`
- Modify: `client/src/mobile/screens/vacay/MVacay.tsx`
- Modify: `client/src/mobile/screens/vacay/MVacayMonth.tsx`
- Modify: `client/src/mobile/screens/vacay/MVacaySettingsSheet.tsx`
- Modify: `shared/src/i18n/en/vacay.ts`
- Modify: `shared/src/i18n/ko/vacay.ts`
- Modify: all owning Vacay component/page/mobile tests
- Modify: server access/share service and tests selected by the accepted API
  contract

**Steps:**

1. Add RED UI tests for first setup, company change, exact period labels,
   opening modes, planned/taken display, archive, provider partial error and
   overlap conflict.
2. Add RED privacy tests proving shared payloads omit employer, policy,
   balance, journal, note and employment dates.
3. Implement the employment/period context selector and balance drawer/sheet
   using existing TREK visual tokens.
4. Keep 390px annual view read-only, use a month edit sheet, and keep Fold
   context controls collision-free.
5. Replace clickable calendar divs with keyboard-operable buttons/gridcells,
   labelled state and focus restoration.
6. Implement employment-scoped busy-date grants; do not carry them to a new
   employment automatically.
7. Run focused client/server tests, i18n parity, typecheck, full tests and build.
8. Run Playwright at 390px, an unfolded Fold viewport and 1440px for normal,
   empty, loading, partial error, blocking error, conflict and archived states.
9. Commit this slice only:

   ```bash
   git commit -m "feat(vacay): add employment-scoped leave tracking"
   ```

### Task 8: Defer The Korea Policy Provider To R2

**Files:**

- No production source changes in MVP.
- Create a new design/implementation plan only after the generic provider
  contract and current law are revalidated.

**Steps:**

1. Recheck current law, effective dates and final subordinate regulations.
2. Define a versioned provider response containing assumptions, unknown inputs,
   source URLs and proposed journal commands.
3. Require explicit user confirmation; never auto-post legal entitlement.
4. Keep HR approval, payroll, attendance and legal certification out of scope.

## Final Release Boundary

Even after upstream PR acceptance, do not deploy `upstream/dev` to the
JSNetworkCorp service. Wait for an official release tag, integrate it in the
fork release-sync worktree, run migration/backup/rollback gates, and obtain a
separate production deployment approval.
