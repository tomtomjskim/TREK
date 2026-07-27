# Packing Template Admin Submission Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure every packing-template admin create or inline-rename gesture produces at most one API mutation, stale template-detail responses cannot overwrite the current selection, and visible category/item counts stay synchronized with successful CRUD operations.

**Architecture:** Keep the existing REST, database, permission, and toast contracts unchanged. Add synchronous component-local action locks, keyboard composition/repeat filtering, edit-session commit guards, and generation-scoped detail sessions inside `PackingTemplateManager`. Serialize all writes for one template, reconcile successful mutations only into the matching detail session, and refresh authoritative detail when the user has reopened that same template.

**Tech Stack:** React 19, TypeScript, Testing Library, MSW, Vitest, Playwright

---

## Design and scope

### Root cause

The create handlers accept Enter and click events without a synchronous pending guard.
Until the first request resolves and React removes or clears the input, a repeated key,
IME completion event, or second gesture can issue another POST. Template and category
rename inputs also bind the same async save to both Enter and blur, allowing two PUTs.

Template expansion has a separate race: every completed detail request writes the same
`categories` and `items` state even if another template is now expanded. Category and
item mutations update their detail arrays but not the summary counts stored in
`templates`. A pending mutation has the same stale-response problem: after the user
switches templates, its completion can append an old category/item to the new detail or
collapse the new selection. Concurrent category/item writes can also apply count deltas
against different snapshots.

Browser evidence also exposed a narrow-layout defect in the add-item row. The flex
input kept its intrinsic minimum width, pushing the confirm and cancel buttons beyond
the clipped category card at 390px.

### Behavior contract

1. Create-template, create-category, and create-item accept a valid gesture at most once
   while its mutation is pending.
2. Composing, legacy IME `keyCode=229`, and repeated Enter events never submit.
3. A template/category rename committed by Enter is not committed again by the blur
   caused when the editor closes. A failed commit remains retryable.
4. Only the newest still-active template-detail request may update detail state.
5. Successful category/item add and delete operations immediately update the expanded
   template's visible counts; failures leave counts unchanged.
6. A pending mutation from template A may update A's summary after success, but it
   cannot change template B's detail or editor state.
7. Writes for one template do not overlap. Switching to another template remains
   available, while the pending template's write controls are disabled.
8. Reopening the same template creates a new detail generation. A successful mutation
   from the prior generation is merged by ID and followed by an authoritative refresh,
   so it is neither lost nor duplicated.
9. Existing API routes, payloads, idempotency middleware, database schema, admin
   permission boundary, and public behavior outside this component remain unchanged.
10. At 390px, the add-item input and both action buttons remain fully inside their row,
    and the cancel action stays clickable.

### Alternatives considered

- **Component-local exact-once guards (selected):** fixes the confirmed UI event paths
  with no API or persistence migration and provides deterministic request-count tests.
  A template-scoped write lock prevents ambiguous local count deltas, while
  generation-scoped reconciliation prevents cross-template state contamination.
- **Stable client idempotency keys plus server reservation:** stronger across retries and
  multiple clients, but changes the API client seam and server reservation lifecycle.
  Reconsider separately if duplicate traffic is observed outside this component.
- **Database uniqueness constraints:** can prevent some identical rows but requires a
  product decision about whether same-named categories/items are legal and a production
  data cleanup/migration. It is intentionally excluded.

### Feature decision checklist

- **lane:** `fork-core`, with a generic upstream-contribution candidate after independent
  reproduction on current `upstream/dev`.
- **users and contract:** admin-only packing-template management becomes exact-once per
  gesture; public API and authorization semantics do not change.
- **data ownership:** existing official core tables remain the owner; no migration,
  backfill, or new persistent field is added.
- **integration seam:** one existing React component and its focused regression suite.
- **evidence and rollback:** focused RED/GREEN request-count tests, client typecheck/lint,
  full relevant tests, and 390/1440 browser evidence. Rollback is `code_only`.
- **retirement signal:** remove the fork patch after an official release provides
  equivalent exact-request-count, IME/repeat, rename, detail-race, and count regressions.

## Task 1: Lock exact-once keyboard and rename behavior with RED tests

**Files:**

- Modify: `client/src/components/Admin/PackingTemplateManager.test.tsx`

1. Add delayed MSW handlers and assert exactly one POST for rapid duplicate Enter on
   template, category, and item creation.
2. Assert composing, keyCode 229, and repeated Enter events issue no request before a
   normal Enter submits once.
3. Commit template and category renames with Enter followed immediately by blur and
   assert exactly one PUT.
4. Run:

```bash
npm run test --workspace=client -- src/components/Admin/PackingTemplateManager.test.tsx
```

Expected RED: the new exact-request-count cases fail against the unguarded component.

## Task 2: Implement the minimum submission and edit-session guards

**Files:**

- Modify: `client/src/components/Admin/PackingTemplateManager.tsx`

1. Add one keyboard predicate for valid non-composing, non-repeat Enter events.
2. Add synchronous per-action single-flight locks mirrored into button disabled state.
3. Add per-edit-session commit guards; clear them only when a new edit begins or a
   failed request becomes retryable.
4. Re-run the focused suite and client typecheck. Expected GREEN.

## Task 3: Lock and fix detail races and summary counts

**Files:**

- Modify: `client/src/components/Admin/PackingTemplateManager.test.tsx`
- Modify: `client/src/components/Admin/PackingTemplateManager.tsx`

1. Add a deferred two-template detail test that resolves the older request last.
2. Extend successful add/delete tests to assert the visible category and item counts.
3. Verify RED, then add generation-scoped detail sessions, template-level write
   serialization, ID-based same-template reconciliation, and local count deltas.
4. Disable nested writes until initial detail loading finishes. When the same template
   is reopened during a mutation, invalidate the older GET and refresh authoritative
   detail after the mutation succeeds.
5. Re-run the focused suite until GREEN.

## Task 4: Record the patch and run repository evidence

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/upstream/README.md`

1. Link this plan from the maintainer index and add a patch-inventory row with its
   retirement condition.
2. Run focused tests, client typecheck, lint for changed files, the relevant/full client
   suite as practical, and `git diff --check`.
3. Capture authenticated browser evidence at 390px and 1440px without modifying
   production data. Assert that nested item-editor controls remain inside their row at
   390px, then request an independent read-only review.
4. Commit only to the local fork worktree branch. Do not push, merge `main`, build an
   image, or deploy until TOM gives a separate explicit approval.

## Verification evidence — 2026-07-27

### RED

- Rapid duplicate submission, Enter-plus-blur rename, stale detail response, stale
  mutation response, overlapping writes, count drift, and same-template re-entry tests
  failed against the prior component as expected.
- The 390px browser boundary check failed before the layout fix: an item action button
  ended at x=340 while its editor row ended at x=323.

### GREEN

- Focused Vitest: `34 passed`.
- Full client Vitest: `206 passed` files; `3455 passed`, `38 skipped` tests.
- Client TypeScript check: passed.
- Changed component/test ESLint and no-ignore E2E ESLint: passed with no findings.
- Repository-wide client ESLint: `0 errors`, `1262 warnings`; the changed paths are clean.
- Direct Vite production build: passed (`2378` modules transformed). Existing bundle
  size and ineffective dynamic-import warnings remain non-blocking.
- Isolated Playwright run on backend port 3101 with fresh servers: setup plus app `2/2`
  passed. Desktop 1440px and mobile 390px screenshots were inspected; the mobile action
  buttons stay inside the editor and cancel remains clickable.
- `git diff --check`: passed.
- Independent read-only review: no blocker or major finding after the stale-session,
  stale-delete, overlap, authoritative-refresh, and E2E-cleanup follow-ups.

### Deliberately not run

- Server unit/integration suites: no server, API, schema, authorization, or migration
  code changed; the isolated browser test exercised the existing admin API contract.
- Docker image build, branch merge, push, and production deployment: require a separate
  explicit TOM approval.

### Residual risk

- Exact-once protection is component-local. It does not replace a future server-side
  stable idempotency reservation if duplicates are observed from another client or
  retry path.
- Same-name category/item uniqueness remains a product decision; no data cleanup or
  uniqueness migration was introduced.
