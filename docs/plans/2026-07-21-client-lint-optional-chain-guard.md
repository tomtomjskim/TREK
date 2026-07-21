# Bulk Place Delete Optional-Chain Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the client's sole unsafe optional-chain non-null assertion while preserving bulk place deletion behavior for selected, unrelated and defensively malformed assignments.

**Architecture:** Keep the existing `deletePlacesMany` flow and replace the asserted optional-chain result with a local nullable assignment-place ID. Preserve assignments whose embedded place is absent, remove only assignments whose place ID is selected, and promote the now-zero ESLint rule to an error so the unsafe pattern cannot regress.

**Tech Stack:** TypeScript, Zustand, Vitest, MSW, ESLint 10 with typescript-eslint.

---

## Scope and lane

- Lane: temporary `fork-core` defensive correctness and lint-gate maintenance; no official upstream branch or PR in this task.
- No public API, shared schema, database, dependency, UI, image, Compose or deployment change.
- Starting client lint baseline: 0 errors / 1,273 warnings, including one `@typescript-eslint/no-non-null-asserted-optional-chain` warning.
- This batch does not include the five `preserve-caught-error` warnings or unused `get` parameter in the same file.

## Root cause and alternatives

`deletePlacesMany` filters each affected day's assignments with
`!idSet.has(a.place?.id!)`. The shared `Assignment` schema requires `place`, but the
slice deliberately uses optional access around embedded places to tolerate legacy or
transient client state. At runtime the current expression passes `undefined` to
`Set.has`, which keeps an orphan assignment, while the non-null assertion incorrectly
claims the value cannot be undefined.

1. **Extract and guard the nullable ID (selected):** explicit, type-safe and preserves orphan assignments.
2. Use `a.place.id` directly: trusts the schema but can crash on defensive legacy/transient state.
3. Drop assignments with no embedded place: removes the lint warning but changes existing recovery behavior and risks unrelated data loss.

### Task 1: Lock the behavior and create the lint RED gate

**Files:**

- Modify: `client/tests/unit/slices/placesSlice.test.ts`
- Modify: `client/eslint.config.mjs`

**Step 1: Add the characterization test**

Add a `deletePlacesMany` test with one selected assignment, one unrelated assignment,
and one runtime-shaped assignment without an embedded place. Assert that the API gets
the selected ID, the selected place/assignment are removed, and the unrelated and
orphan assignments remain.

**Step 2: Run the focused test**

```bash
npm run test --workspace=client -- tests/unit/slices/placesSlice.test.ts
```

Expected: 10/10 pass, documenting the pre-existing runtime behavior before refactoring.

**Step 3: Promote the zero-target rule and verify RED**

Change `@typescript-eslint/no-non-null-asserted-optional-chain` from `warn` to `error`, then run:

```bash
cd client
npx --no-install eslint src/store/slices/placesSlice.ts
```

Expected: exit 1 with the existing expression reported as the sole error for this rule.

### Task 2: Replace the assertion with an explicit nullable guard

**Files:**

- Modify: `client/src/store/slices/placesSlice.ts`

**Step 1: Implement the minimal predicate**

Inside the existing filter callback, derive `const assignedPlaceId = a.place?.id` and
return true when it is nullish or not in `idSet`. Do not change the surrounding
bulk-delete API call, place-pool filtering or assignment-map update condition.

**Step 2: Verify GREEN**

Run the focused test and target ESLint command again.

Expected: 10/10 test pass, target lint exit 0, and
`@typescript-eslint/no-non-null-asserted-optional-chain` count 0.

### Task 3: Document, verify and integrate in the fork

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/upstream/README.md`

**Step 1: Record the batch**

Link this plan from the maintainer index and add an implementation-independent patch
inventory entry whose retirement condition is the same bulk-delete behavior plus a
zero unsafe optional-chain gate in an official release.

**Step 2: Run full validation**

```bash
npm run typecheck --workspaces --if-present
npm test
npm run lint --workspace=client
npm run build
git diff --check
```

Expected: all checks pass; client lint becomes 0 errors / 1,272 warnings and the target
rule remains at zero. Existing build advisories remain separate debt.

**Step 3: Review and publish only to the fork**

Request an independent read-only review, push `fix/bulk-place-delete-null-guard`, open a
PR against `tomtomjskim/TREK:main`, wait for required CI, and merge only if green. Do not
touch the official upstream repository or deploy production.

## Final local evidence

- Characterization baseline: `placesSlice.test.ts` passed 10/10 before the production
  refactor, including selected, unrelated and runtime-shaped orphan assignments.
- Lint RED: after promoting
  `@typescript-eslint/no-non-null-asserted-optional-chain` to `error`, target lint exited
  1 with exactly the existing unsafe optional-chain assertion as its error.
- GREEN: the explicit nullable ID guard kept the focused test at 10/10 and target lint
  passed with 0 errors; six unrelated warnings remain in the target file.
- Full client lint: 0 errors and 1,272 warnings, down exactly one from the 1,273-warning
  baseline; the promoted rule has zero violations.
- `npm run typecheck --workspaces --if-present` passed for client, server and shared.
- `npm test` passed: shared 34 files / 141 tests, server 304 files / 5,430 tests, client
  205 files / 3,435 passed and 38 skipped.
- `npm run build` and `git diff --check` passed. Existing plugin timing, ineffective
  dynamic-import and large-chunk advisories remain separate build debt.
- Independent read-only review found no blocker or major risk. Its two LOW follow-ups
  were applied: the API assertion now fails closed on a missing request, and the ESLint
  severity comment distinguishes the promoted zero-debt error gate.
- No dependency, database, image, Compose service, official upstream repository or
  production deployment was changed.
