# Vacay Invite Membership Integrity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement
> this plan task-by-task.

**Goal:** prevent Vacay invitation flows from creating multiple accepted
memberships, owner-orphaned plans, self-memberships, or false real-time updates.

**Architecture:** keep `acceptInvite()` as the authoritative command and add a
fail-closed membership-topology preflight inside its existing immediate SQLite
transaction. Apply the same eligibility check before `sendInvite()`, normalize
REST identifiers at the controller boundary, and emit decline/cancel events only
after a pending row was actually removed. Do not add a schema migration or
implicitly delete a user's other pending invitations.

**Tech Stack:** TypeScript, NestJS, better-sqlite3, MCP SDK, WebSocket, Vitest,
Supertest.

---

> **Status:** implemented and verified locally; publication held
>
> **Lane:** `fork-core pilot / upstream-contrib candidate`
>
> **Publication:** local worktree only; no push, merge, upstream PR, or deploy

## Architecture readiness

- **Result:** `full_gate_required`
- **Surfaces:** Vacay core service, Nest REST controller, SQLite membership
  reads/writes, authenticated invite permissions, WebSocket fan-out, MCP tools
- **Data ownership:** existing upstream-owned `vacay_plans` and
  `vacay_plan_members`; no schema or migration change
- **Rollback:** `code_only`; revert this source commit
- **Privacy/data risk:** an invalid acceptance can expose and mutate another
  plan's vacation entries and allowances, so rejection must preserve every row
  and emit no event
- **Evidence:** in-memory service tests, REST integration tests, controller
  contract tests, MCP contract tests, focused/full server gates, typecheck, lint,
  production build, and clean diff

## Scope decision

Three approaches were considered.

1. Add a partial unique index for one accepted membership per user. Deferred
   because deployed legacy rows need an audit and migration/rollback rehearsal.
2. Delete all other pending invitations when one is accepted. Rejected because
   it silently changes other owners' outbound state without an audit record or
   explicit user confirmation.
3. Validate topology in the existing immediate transaction and return a stable
   review-required result. Selected because it closes the race, preserves all
   unrelated pending invitations, needs no migration, and is code-only
   reversible.

R0.3a does not change the invitation UI, carry calculation, dissolve behavior,
actual-inviter attribution, idempotency fingerprinting, or socket authentication.

## Contract

`acceptInvite(userId, planId, socketId)` must keep the current invitation pending
and return `409` with
`VACAY_INVITE_MEMBERSHIP_REVIEW_REQUIRED` before any write when:

- the destination plan is missing or is owned by the invitee;
- the invitee has an accepted, NULL, unknown, or dangling membership other than
  the current pending invitation;
- the invitee's own plan has any membership row, regardless of status;
- the destination owner is accepted elsewhere, has a self-membership in the
  destination, or has a NULL, unknown, or dangling membership; or
- the destination contains an unknown or NULL member status.

Other valid pending invitations may coexist before the first acceptance. The
first valid acceptance succeeds and preserves them; a later acceptance returns
the stable `409` because the invitee is already accepted elsewhere.

`sendInvite()` repeats the same eligibility check before inserting a pending row
so REST and MCP cannot create invitations that acceptance must immediately
reject. The accept-time transaction remains authoritative.

REST invite identifiers accept positive safe integers and canonical decimal
strings, normalize them to numbers, and reject zero, negative, fractional,
unsafe, padded, truncated, or missing values with `400` and
`VACAY_INVALID_ID`.

`declineInvite()` and `cancelInvite()` remain idempotent successes but broadcast
only when SQLite reports exactly one removed pending row. A real decline also
notifies the invitee's other sockets.

## Task 1: Service RED tests

**Files:**

- Modify: `server/tests/unit/services/vacayService.test.ts`

**Steps:**

1. Add a test proving an owner with a pending member cannot accept another plan
   and that all membership/data rows and broadcasts remain unchanged.
2. Add a test proving only one of two pending invitations can become accepted
   while the other stays pending.
3. Add table-driven rejection cases for destination-owner self-membership,
   accepted-elsewhere ownership, and NULL/unknown membership state.
4. Add `sendInvite()` and `getAvailableUsers()` tests for owner-orphan and
   destination-owner targets.
5. Add decline/cancel tests for real-change notification and no-op silence.
6. Run:

   ```bash
   cd server
   npx vitest run tests/unit/services/vacayService.test.ts -t \
     "membership topology|only one pending|no-op invitation"
   ```

   Expected: FAIL because the current service accepts or broadcasts.

## Task 2: REST and MCP RED tests

**Files:**

- Modify: `server/tests/unit/nest/vacay.controller.test.ts`
- Modify: `server/tests/integration/vacay.test.ts`
- Modify: `server/tests/unit/mcp/tools-vacay.test.ts`

**Steps:**

1. Require canonical positive IDs for send/accept/decline/cancel and prove a
   numeric string is passed to the service as a number.
2. Reproduce the numeric-string self-invite through Supertest and assert no
   membership row is created.
3. Assert REST returns the stable membership-review code and preserves the
   pending topology.
4. Assert MCP send/accept errors expose the same stable code.
5. Run the three focused files and confirm the new cases fail for the intended
   missing behavior.

## Task 3: Minimal GREEN implementation

**Files:**

- Modify: `server/src/services/vacayService.ts`
- Modify: `server/src/nest/vacay/vacay.service.ts`
- Modify: `server/src/nest/vacay/vacay.controller.ts`
- Modify: `server/src/mcp/tools/vacay.ts`

**Steps:**

1. Add the stable membership-review constant and a private topology predicate.
2. Call it in `sendInvite()` and at the beginning of the current
   `acceptInvite()` immediate transaction.
3. Add one controller helper that parses canonical positive safe integer IDs and
   use it on all four invitation routes.
4. Preserve structured error codes in REST and MCP.
5. Return a changed flag from decline/cancel and emit events only for a real
   deletion.
6. Run Tasks 1 and 2 until all focused tests pass.

## Task 4: Regression and closeout

**Files:**

- Update: `docs/README.md`
- Update: `docs/project-source-map.md`
- Update: `docs/upstream/README.md`
- Update: `docs/plans/2026-07-30-vacay-invite-year-reconciliation.md`
- Update: this plan with exact evidence
- Update generated TREK Vacay wiki knowledge after code gates pass

**Steps:**

1. Run the four focused Vacay server files.
2. Run server typecheck and non-mutating lint.
3. Run the complete server suite with constrained workers.
4. Run shared/client typecheck and root production build because the public
   repository contract and bundled server changed.
5. Run `git diff --check` and inspect the complete diff for unrelated changes.
6. Record commands, results, skipped gates, residual risks, and code-only
   rollback. Do not push, merge, deploy, or open an upstream PR.

## Closeout evidence

The RED phase reproduced the missing contracts before implementation:

- the service file produced `10` intended failures across owner orphaning,
  multiple pending invitations, ambiguous/dangling topology, eligibility, and
  no-op event cases;
- the controller file produced `16` intended failures for canonical invite
  identifiers and structured errors;
- REST integration produced `2` intended failures; and
- MCP produced `2` intended failures for structured topology errors.

After the minimal server-side change:

- the four focused server files passed `193` tests;
- server typecheck passed;
- the full server suite passed `304` files / `5,500` tests with one worker;
- shared and client typechecks passed;
- changed-path ESLint exited successfully with `0` errors and `39` warnings;
- the root shared/server/client production build passed; and
- `git diff --check` passed.

The build retained the repository's existing Vite large-chunk and ineffective
dynamic-import warnings. A file-wide Prettier check is not a clean gate for the
touched legacy server files; normalizing them would create unrelated churn, so
this slice relies on non-mutating ESLint, typecheck, tests, production build, and
whitespace-diff validation.

No schema, migration, client layout, or production runtime changed, so migration
rehearsal, browser viewport evidence, deployment, and data backfill were not
performed. Rollback is code-only.

Residual risk is intentionally bounded: no database partial unique index is
added until legacy membership rows can be audited and a migration rehearsed.
The accept-time immediate transaction remains authoritative, while invalid
legacy topology requires operator review rather than automatic deletion. UI
owner attribution and broader real-time convergence remain a separate product
slice.
