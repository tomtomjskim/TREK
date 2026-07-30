# Vacay Invite Year Reconciliation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** prevent accepting a Vacay fusion invitation from moving historical
entries or user-year rows into a destination plan that does not contain those
years.

**Architecture:** keep `acceptInvite()` as the single command, but resolve its
required migration years before changing membership. Run the check and the
existing membership/data/color writes in one immediate SQLite transaction.
Return one stable review-required result and keep the invitation pending when
the destination is missing a required year.

**Tech Stack:** TypeScript, NestJS, better-sqlite3, MCP SDK, React/Zustand,
Vitest, Supertest.

---

> **Status:** implemented and verified locally; publication held
>
> **Lane:** `fork-core pilot / upstream-contrib candidate`
>
> **Publication:** local worktree only; no push, merge, upstream PR, or deploy

## Scope Decision

Three approaches were considered:

1. Automatically add the invitee's source years to the destination plan.
   Rejected because accepting an invite would silently change the owner's plan.
2. Migrate only rows whose years already exist in the destination. Rejected
   because this splits one user's vacation history across plans.
3. Reject acceptance while any migrated entry or user-year references a missing
   destination year. Selected because it is explicit, retryable, and does not
   mutate policy.

R0.3 does not add a preview endpoint, reconcile all `vacay_years`, delete source
rows, change dissolve/rejoin behavior, or convert `getStats()` to a pure read.

## Contract

`acceptInvite(userId, planId, socketId)` must:

- return the existing `404` result when no pending invitation exists;
- collect distinct years from the invitee's source `vacay_user_years` and
  `vacay_entries`;
- return `409`, code `VACAY_INVITE_YEAR_REVIEW_REQUIRED`, and sorted
  `missing_years` when any required year is absent from destination
  `vacay_years`;
- leave membership pending and leave all source and destination rows unchanged
  on that result;
- accept normally after the destination owner adds the missing years;
- run the check, status update, data move/copy, color assignment, and target
  default-row creation in one immediate transaction; and
- broadcast `vacay:accepted` only after a committed success.

REST exposes the code and `missing_years`. MCP returns the same structured
fields in a tool error. The existing invitation overlay remains open and shows
the server's actionable error text. No new locale key is introduced in this
compatibility slice.

## Task 1: Service RED Tests

**Files:**

- Modify: `server/tests/unit/services/vacayService.test.ts`
- Test: `server/tests/unit/services/vacayService.test.ts`

**Step 1: Write the failing tests**

- Seed an invitee user-year and an entry-only historical year that the target
  plan lacks.
- Assert the result code/list, pending membership, unchanged row snapshots, and
  zero accepted broadcast.
- Add the missing destination years and assert a retry succeeds.
- Install a failing SQLite trigger during migration and assert the status and
  source rows roll back.

**Step 2: Verify RED**

Run:

```bash
npx vitest run tests/unit/services/vacayService.test.ts -t "invite year reconciliation"
```

Expected: FAIL because current acceptance succeeds or partially commits.

## Task 2: Public Boundary RED Tests

**Files:**

- Modify: `server/tests/integration/vacay.test.ts`
- Modify: `server/tests/unit/nest/vacay.controller.test.ts`
- Modify: `server/tests/unit/mcp/tools-vacay.test.ts`

**Step 1: Write the failing tests**

- REST must return `409`, the stable code, and sorted `missing_years`, with the
  pending invite and source rows intact.
- Controller mapping must preserve optional code/details without changing
  legacy plain-error bodies.
- MCP must return the same structured code/details as a tool error.

**Step 2: Verify RED**

Run:

```bash
npx vitest run tests/integration/vacay.test.ts \
  tests/unit/nest/vacay.controller.test.ts \
  tests/unit/mcp/tools-vacay.test.ts -t "invite year"
```

Expected: FAIL because the current public surfaces do not expose this contract.

## Task 3: Minimal Service and Adapter GREEN

**Files:**

- Modify: `server/src/services/vacayService.ts`
- Modify: `server/src/nest/vacay/vacay.controller.ts`
- Modify: `server/src/mcp/tools/vacay.ts`

**Step 1: Implement the minimum command**

- Add the stable code/result fields.
- Derive required years from only rows the command already migrates.
- Return before writes when review is required.
- Wrap the existing successful path in `db.transaction(...).immediate()`.
- Move the accepted broadcast after commit.

**Step 2: Verify GREEN**

Run the Task 1 and Task 2 commands.

Expected: all new and existing focused tests pass.

## Task 4: Minimal Invitation Error UX

**Files:**

- Modify: `client/src/pages/vacay/useVacay.ts`
- Modify: `client/src/pages/VacayPage.tsx`
- Modify: `client/src/pages/VacayPage.test.tsx`

**Step 1: Write the failing test**

- Reject the mocked accept action with an Axios-style server error.
- Assert the invitation remains visible and its card exposes the actionable
  message with `role="alert"`.

**Step 2: Verify RED**

Run:

```bash
npx vitest run src/pages/VacayPage.test.tsx -t "invite acceptance error"
```

Expected: FAIL because the current click handler drops the rejected promise.

**Step 3: Implement and verify GREEN**

- Catch acceptance failure in `useVacay`.
- Keep only `{ planId, message }` as local UI state.
- Render the message only on the matching invitation card.

Run the same test, then the full Vacay page test file.

## Task 5: Closeout

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/project-source-map.md`
- Modify: `docs/upstream/README.md`
- Modify: `docs/plans/2026-07-30-vacay-year-deletion-safety.md`
- Modify: this plan with final evidence

**Step 1: Run gates**

- focused Vacay service/controller/integration/MCP/client tests;
- server and client full suites with constrained workers;
- shared/server/client typecheck;
- strict i18n parity and client page-pattern;
- root production build and `git diff --check`.

No migration rehearsal or browser viewport run is required because R0.3 changes
neither schema nor layout. If the invitation card layout materially changes,
run the existing Vacay Playwright scenario before closeout.

**Step 2: Record and commit**

- Record exact evidence and remaining risk.
- Update generated personal-wiki TREK knowledge and graph/meta.
- Create one local TREK commit and one local generated-wiki commit.
- Do not push, merge, or deploy.

## Closeout Evidence

The TDD cycle reproduced the previous behavior before implementation:

- three service cases failed because acceptance was not blocked and a forced
  migration failure left membership accepted;
- REST, controller, and MCP cases failed because the structured `409` contract
  was absent; and
- the Vacay page case failed because a rejected acceptance had no visible
  alert.

After the minimal command and UI change:

- the four focused server files passed `162` tests;
- the Vacay page file passed `30` tests;
- shared passed `34` files / `141` tests;
- server passed `304` files / `5,469` tests;
- client passed `206` files / `3,466` tests with `38` pre-existing skips;
- shared, server, and client typechecks passed;
- strict i18n parity and the client page-pattern check passed;
- changed-path ESLint reported zero errors, with only pre-existing warnings;
- the root production build and `git diff --check` passed.

No schema or layout changed, so no migration rehearsal or browser viewport run
was required. The bounded adversarial review found zero blockers and zero major
findings. The actionable server message remains English in this compatibility
slice, and a malformed legacy entry date fails closed before any mutation;
neither observation expands R0.3.
