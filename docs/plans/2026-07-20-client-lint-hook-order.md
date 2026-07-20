# PlaceInspector Hook Order Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve a stable React Hook order when `PlaceInspector` changes from no selected place to a selected place, and remove the sole client `react-hooks/rules-of-hooks` warning.

**Architecture:** Keep `PlaceInspector` as one component and move its memoized file-upload callback before the nullable-place early return. Capture a nullable `placeId` and guard inside the callback so every render calls the same Hooks while existing upload behavior remains unchanged.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, ESLint 10 with `eslint-plugin-react-hooks`.

---

## Scope and lane

- Lane: temporary `fork-core` correctness fix with an upstream-compatible diff; no official upstream branch or PR in this task.
- Production behavior, DOM shape, API contract, database, dependencies, image, Compose and deployment remain unchanged.
- The full client lint baseline is 1,274 warnings across 14 rule buckets:
  - `@typescript-eslint/no-explicit-any`: 560
  - `@typescript-eslint/no-unused-vars`: 472
  - `react-hooks/exhaustive-deps`: 121
  - `preserve-caught-error`: 46
  - `no-empty`: 37
  - `react-refresh/only-export-components`: 18
  - unused disable directives: 6
  - all remaining low-volume rules: 14
- This PR fixes only the single `react-hooks/rules-of-hooks` violation. Bulk typing, dependency-array changes and stylistic cleanup are separate reviewable batches.

## Root cause and alternatives

`PlaceInspector` returns early when `place` is `null`, before reaching `handleFileUpload`'s `useCallback`. Re-rendering the same mounted component with a place therefore adds a Hook and violates React's stable Hook-order contract.

1. **Move `useCallback` above the early return (selected):** smallest diff and preserves callback memoization.
2. Replace `useCallback` with a normal function: removes the Hook but changes callback identity on every render.
3. Extract the non-null inspector body into a child component: valid but disproportionate refactoring for one defect.

### Task 1: Add the missing transition regression

**Files:**

- Modify: `client/src/components/Planner/PlaceInspector.test.tsx`

**Step 1: Write the failing test**

Render `PlaceInspector` with `place={null}`, rerender the same component with the existing valid `place` fixture, and assert that the place name appears.

**Step 2: Run the focused test and verify RED**

```bash
npm run test --workspace=client -- src/components/Planner/PlaceInspector.test.tsx
```

Expected: the new test fails with React's Hook-order/rendered-more-hooks diagnostic.

### Task 2: Preserve Hook order with the smallest production change

**Files:**

- Modify: `client/src/components/Planner/PlaceInspector.tsx`

**Step 1: Implement the minimal fix**

- Derive `const placeId = place?.id` before the early return.
- Move `handleFileUpload` before `if (!place) return null`.
- Guard `placeId == null` inside the callback.
- Append the captured `placeId` to the upload form and use it in the dependency list.

**Step 2: Verify GREEN**

Run the focused test again and confirm all tests pass without Hook-order diagnostics.

**Step 3: Verify the lint contract**

```bash
npx --no-install eslint src/components/Planner/PlaceInspector.tsx
```

Expected: no `react-hooks/rules-of-hooks` warning; the file's unrelated pre-existing warnings are reported separately.

### Task 3: Verify and integrate in the fork

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/upstream/README.md`

**Step 1: Run validation**

```bash
npm run typecheck --workspace=client
npm run test --workspace=client
npm run lint --workspace=client
npm run build
git diff --check
```

Expected: typecheck, client tests and build pass; full client warning count drops from 1,274 to 1,273 with `react-hooks/rules-of-hooks` at zero.

**Step 2: Review the patch**

Confirm null→place and place→null transitions, upload behavior, dependencies and docs. Do not widen the PR to unrelated lint warnings.

**Step 3: Publish only to the fork**

Push `fix/place-inspector-hook-order`, open a PR against `tomtomjskim/TREK:main`, wait for required CI, then merge only if green. Do not deploy.
