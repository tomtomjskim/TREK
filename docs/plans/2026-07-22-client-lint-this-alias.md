# Client This Alias Lint Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the single client `@typescript-eslint/no-this-alias` warning without changing `PlaceAvatar` visibility or photo-fetch behavior, then make new violations fail client CI.

**Architecture:** Keep the production `PlaceAvatar` and its `IntersectionObserver` lifecycle unchanged. Narrow the test double's captured state from a whole observer instance to the callback the tests actually invoke, characterize the callback's disconnect side effect, and promote the zero-debt ESLint rule to an error.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, ESLint flat config

---

## Design and scope

### Root cause

`PlaceAvatar.test.tsx` stores `this` from `MockIntersectionObserver`'s constructor in an
outer `observerInstance` variable. ESLint correctly treats that as an alias whose
identity and lifetime can diverge from the constructed object. The tests never need the
object identity: they only call its stored observer callback to simulate an intersecting
entry. `observe`, `disconnect`, and `unobserve` are already independent mock methods.

The current client lint baseline is 0 errors / 1,265 warnings. The target file has three
warnings, exactly one of which is `@typescript-eslint/no-this-alias` at the constructor's
`observerInstance = this` assignment.

### Behavior contract

1. A place without `image_url` creates an observer when photo loading is enabled.
2. Emitting an intersecting entry makes the avatar visible, disconnects that observer,
   and requests a photo when there is no cached/loading entry.
3. A loading photo registers `onThumbReady` after the same intersection callback.
4. Unmounting a pending avatar still disconnects the observer.
5. A place with `image_url` does not create or observe an element.
6. Production component, API, store, browser behavior, layout, dependency, database,
   image, Compose, and deployment state are unchanged.
7. `@typescript-eslint/no-this-alias` applies as `error` to client `src` and `tests`;
   unrelated warning severities remain unchanged.

### Alternatives considered

- **Capture only the callback (selected):** matches the test's actual seam and removes
  the unnecessary object alias with the smallest diff.
- **Store a static `lastInstance`:** avoids a local alias but preserves unnecessary
  shared object state and makes parallel construction semantics less clear.
- **Allow or disable the alias:** avoids the refactor but retains the debt and cannot
  establish a zero-violation CI gate.

### Change lane and retirement

This is temporary `fork-core maintenance` with an upstream-compatible test-only source
diff. Remove the local patch when a verified official release preserves the same
`PlaceAvatar` observer callback/disconnect contract and carries zero
`@typescript-eslint/no-this-alias` violations. Do not push or open a PR against
`liketrek/TREK`, and do not deploy production in this batch.

## Task 1: Characterize the observer callback lifecycle

**Files:**

- Modify: `client/src/components/shared/PlaceAvatar.test.tsx`

**Step 1: Strengthen the visible-photo case**

Extend `FE-COMP-AVATAR-011` to assert that `mockDisconnect` is called exactly once after
the intersecting entry is emitted. Keep its existing `fetchPhoto` assertion. Move the
observer mock clears to `beforeEach`: the shared setup's later `cleanup()` can otherwise
record the previous test's unmount after a file-local `afterEach` has already cleared the
calls, contaminating the next test's count.

**Step 2: Verify the characterization on the original mock**

Run:

```bash
npm run test --workspace=client -- src/components/shared/PlaceAvatar.test.tsx
```

Expected: one file and 16 tests pass before the mock implementation changes.

**Step 3: Commit**

```bash
git add client/src/components/shared/PlaceAvatar.test.tsx
git commit -m "test: characterize avatar observer disconnect"
```

## Task 2: Create the static RED and remove the unnecessary alias

**Files:**

- Modify: `client/eslint.config.mjs`
- Modify: `client/src/components/shared/PlaceAvatar.test.tsx`

**Step 1: Promote the target rule before changing the mock**

Move `@typescript-eslint/no-this-alias` from the warning-debt block to the zero-debt
guardrails.

**Step 2: Verify RED**

Run:

```bash
cd client
npx --no-install eslint src/components/shared/PlaceAvatar.test.tsx
```

Expected: exit non-zero with exactly one `@typescript-eslint/no-this-alias` error and
two unrelated warnings.

**Step 3: Capture only the observer callback**

Replace `observerInstance` with a nullable callback variable. In the mock constructor,
assign the constructor argument to that variable; remove the unused instance callback
property. Reset the callback in `beforeEach` and invoke it in the two intersection tests.
Keep the observer method mocks and production component unchanged.

**Step 4: Verify GREEN**

Run the 16 focused tests and target lint again.

Expected: 16/16 tests pass; target lint exits zero with two unrelated warnings and zero
`@typescript-eslint/no-this-alias` messages.

**Step 5: Commit**

```bash
git add client/eslint.config.mjs client/src/components/shared/PlaceAvatar.test.tsx
git commit -m "test: remove avatar observer this alias"
```

## Task 3: Document, verify, and integrate only in the fork

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/upstream/README.md`

**Step 1: Record the maintenance batch**

Link this plan from the maintainer index. Add a patch-inventory row with the selected
lane, observer behavior contract, and objective retirement signal. The source map does
not change because no entry point, ownership, or runtime boundary moves.

**Step 2: Run full local validation**

```bash
npm run typecheck --workspaces --if-present
npm test
npm run lint --workspace=client
npm run build
git diff --check
```

Expected: all commands pass. Full client lint becomes 0 errors / 1,264 warnings, down
exactly one from the 1,265-warning baseline, and src/test `--print-config` reports the
promoted rule at severity 2. Existing build advisories remain separate debt.

**Step 3: Review and publish only to the fork**

Request an independent read-only review. If no material finding remains, push
`fix/client-no-this-alias`, open a draft PR against `tomtomjskim/TREK:main`, wait for all
required CI, mark ready, and squash-merge only while the PR is clean and mergeable. Do
not touch the official upstream repository or production deployment.

**Step 4: Synchronize generated knowledge and clean up**

Fast-forward the local fork `main`, verify the squash tree equals the reviewed branch
tree, remove the temporary branch/worktree, and record the evidence in
`personal-wiki/wiki/generated/llm/codebase/trek/client-test-warning-gates.md`. Regenerate
and validate wiki graph/meta artifacts before pushing the wiki commit.
