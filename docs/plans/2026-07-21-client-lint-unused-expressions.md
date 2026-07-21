# Client Unused Expressions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove all three client `@typescript-eslint/no-unused-expressions` violations while preserving the existing admin scope, day expansion and mobile route-distance toggle behavior.

**Architecture:** Replace only the three statement-position conditional expressions that mutate `Set` instances with explicit `if/else` branches. Keep each toggle local to its current state updater, strengthen the admin collapse characterization, and promote the now-zero ESLint rule to an error so the expression pattern cannot regress.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, ESLint 10 with typescript-eslint.

---

## Scope and lane

- Lane: temporary `fork-core` lint-gate maintenance with an upstream-compatible source diff; no official upstream branch or PR in this task.
- The three warnings are in `AdminMcpTokensPanel.tsx` once and `DayPlanSidebar.tsx` twice.
- No public API, state shape, dependency, database, provider, image, Compose, layout or deployment change.
- Starting full client lint baseline: 0 errors / 1,272 warnings, including exactly three `@typescript-eslint/no-unused-expressions` warnings.
- The target-file baseline is 0 errors / 62 warnings. The other 59 warnings remain outside this focused batch.
- Relevant baseline tests pass: `AdminMcpTokensPanel.test.tsx` and `DayPlanSidebar.test.tsx`, 126/126.

## Root cause and alternatives

Each violation uses a conditional expression as a statement solely for its branch side
effect:

```ts
next.has(id) ? next.delete(id) : next.add(id)
```

The returned boolean or `Set` is discarded, so the lint rule correctly reports an
unused expression even though the runtime side effect works.

1. **Explicit local `if/else` (selected):** communicates mutation intent, preserves the exact truth table and creates no new abstraction.
2. Extract a shared `toggleSetMember` helper: removes duplication but adds an import and generic helper for only three unrelated local state updaters.
3. Disable or relax the lint rule: preserves terse syntax but hides statement expressions and prevents a zero-debt correctness gate.

## Behavior contract

- Admin OAuth scope preview: collapsed → expanded reveals hidden scopes; expanded → collapsed restores the `+N more` affordance.
- Planner day card: expanded → collapsed hides its content; collapsed → expanded restores it and persists the same set value.
- Mobile inline route distances: hidden → visible calculates and shows the leg; visible → hidden removes the inline distance without selecting the day.
- Set copies remain immutable from React state's perspective; only the new `Set` is mutated and returned.

### Task 1: Strengthen characterization and create the lint RED gate

**Files:**

- Modify: `client/src/components/Admin/AdminMcpTokensPanel.test.tsx`
- Modify: `client/eslint.config.mjs`

**Step 1: Complete the admin round-trip characterization**

Extend `FE-ADMIN-MCP-014` to click `show less`, then assert the hidden scope disappears
and the `+1 more` control returns. Do not alter production code.

**Step 2: Run focused tests**

```bash
npm run test --workspace=client -- \
  src/components/Admin/AdminMcpTokensPanel.test.tsx \
  src/components/Planner/DayPlanSidebar.test.tsx
```

Expected: 126/126 pass, documenting existing behavior before the syntax refactor.

**Step 3: Promote the target rule and verify RED**

Change `@typescript-eslint/no-unused-expressions` from `warn` to `error`, update the
nearby zero-debt comment to cover multiple promoted guardrails, then run:

```bash
cd client
npx --no-install eslint \
  src/components/Admin/AdminMcpTokensPanel.tsx \
  src/components/Planner/DayPlanSidebar.tsx
```

Expected: exit 1 with exactly three errors from the promoted rule.

### Task 2: Replace statement expressions with explicit branches

**Files:**

- Modify: `client/src/components/Admin/AdminMcpTokensPanel.tsx`
- Modify: `client/src/components/Planner/DayPlanSidebar.tsx`

**Step 1: Fix the admin scope toggle**

Inside `setExpandedScopes`, replace the conditional expression with an `if/else` that
deletes an existing ID or adds a missing ID. Run the admin test and target lint; the
admin file must have zero target-rule errors while the two planner errors remain.

**Step 2: Fix both planner toggles**

Apply the same explicit branch to `toggleDay` and the mobile
`setExpandedRouteDayIds` updater. Do not change persistence, route calculation,
selection or callback flow.

**Step 3: Verify GREEN**

Run both focused test files and target lint again.

Expected: 126/126 tests pass, target lint exits 0, and
`@typescript-eslint/no-unused-expressions` count is zero.

### Task 3: Document, verify and integrate in the fork

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/upstream/README.md`

**Step 1: Record the batch**

Link this plan from the maintainer index and add one implementation-independent
patch-inventory entry for zero-debt client correctness lint guardrails. Its retirement
condition must be equivalent toggle behavior plus zero target-rule violations in an
official release.

**Step 2: Run full validation**

```bash
npm run typecheck --workspaces --if-present
npm test
npm run lint --workspace=client
npm run build
git diff --check
```

Expected: all commands pass; full client lint becomes 0 errors / 1,269 warnings and
the promoted rule remains at zero. Existing build advisories remain separate debt.

**Step 3: Review and publish only to the fork**

Request an independent read-only review, push `fix/client-no-unused-expressions`, open
a PR against `tomtomjskim/TREK:main`, wait for required CI, and merge only if green.
Do not touch the official upstream repository or deploy production.

## Final local evidence

- Characterization baseline: the two focused files passed 126/126 before production
  changes. The admin case now verifies collapsed → expanded → collapsed, while the
  existing planner cases cover day and mobile route-distance round trips.
- Lint RED: promoting `@typescript-eslint/no-unused-expressions` to `error` produced
  exactly three errors at the known Set-toggle expressions and 59 unrelated warnings.
- Incremental GREEN: the admin branch reduced the target errors from three to two with
  its 16/16 tests passing; the two planner branches then reduced the rule to zero.
- Final focused gate: 126/126 passed and target lint exited 0 with only the 59 unrelated
  warnings in the two production files.
- Full client lint: 0 errors and 1,269 warnings, down exactly three from the 1,272-warning
  baseline; the promoted rule has zero violations.
- `npm run typecheck --workspaces --if-present` passed for client, server and shared.
- `npm test` passed: shared 34 files / 141 tests, server 304 files / 5,430 tests, client
  205 files / 3,435 passed and 38 skipped.
- `npm run build` and `git diff --check` passed. Existing plugin timing, ineffective
  dynamic-import and large-chunk advisories remain separate build debt.
- Independent read-only review found no HIGH, MED or LOW findings and returned
  `proceed`. The reviewer independently passed the 126 focused tests, target lint
  (0 errors / 59 unrelated warnings), src/test `--print-config` severity check and
  `git diff --check`; no files were modified during review.
- No public API, database, dependency, image, Compose service, layout, official upstream
  repository or production deployment was changed.
