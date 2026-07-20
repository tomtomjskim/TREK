# Client Test Warning Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove actionable Vitest, MSW, React `act()`, router and jsdom warnings from the client test suite without weakening runtime contracts or hiding console output.

**Architecture:** Keep the existing custom jsdom environment and shared MSW server, but update them to current Vitest APIs and complete the default background-fetch contracts. Once the suite has explicit handlers, collect `request:unhandled` events and fail in `afterEach` so caught network errors cannot escape the gate. Fix React warnings in the owning tests, keep test routers on the production v6 semantics, and isolate real browser navigation behind a minimal adapter; do not suppress `console` output globally.

**Tech Stack:** Vitest 4.1, React 19, Testing Library, MSW 2, TypeScript.

---

## Scope and lane

- Lane: generic test-infrastructure maintenance applied only to `tomtomjskim/TREK` in this task.
- API/auth contracts, dependencies, database and deployment are unchanged.
- Production-file edits are limited to a behavior-preserving browser redirect seam and omitting an empty PDF `data` attribute while its authenticated URL is loading.
- Official `liketrek/TREK` push/PR is out of scope.
- Dependency-install and production-build performance warnings are recorded separately; this plan targets client test execution warnings.

### Task 1: Update the custom Vitest environment

**Files:**

- Modify: `client/tests/environment/jsdom-native-abort.ts`

**Step 1: Verify RED**

Run one small client test and fail the command when output contains either
`vitest/environments` deprecation or `transformMode` deprecation.

Expected: the test passes but the warning gate fails with two matches.

**Step 2: Implement the minimal API migration**

- Import `builtinEnvironments` from `vitest/runtime`.
- Replace `transformMode: 'web'` with `viteEnvironment: 'client'`.
- Preserve the native AbortController and Web Storage setup exactly.

**Step 3: Verify GREEN**

Run the same warning gate.

Expected: test exit 0 and deprecation warning count 0.

### Task 2: Complete MSW background-fetch contracts

**Files:**

- Modify: `client/tests/helpers/msw/handlers/admin.ts`
- Modify: `client/tests/helpers/msw/handlers/shared.ts` or the closest domain handler
- Modify: `client/tests/setup.ts`
- Test: affected page/component tests and the full client suite

**Step 1: Verify RED**

Run `AdminPage.test.tsx` and the full client suite with a collector that reports unique MSW unhandled requests.

Expected: tests may pass, but the warning gate fails and prints the missing method/path contracts.

**Step 2: Add only contract-accurate defaults**

For each request that is a normal mount/background fetch, add the smallest response matching the production API shape. Keep scenario-specific success/failure handlers inside their tests.

**Step 3: Make future omissions fail**

After the full inventory reaches zero, change MSW `onUnhandledRequest` from `warn` to `error`. Also collect `request:unhandled` events per test and throw in `afterEach`, because an application catch can otherwise turn the intercepted fetch failure into a passing test. Do not use a catch-all bypass or warning filter.

**Step 4: Verify GREEN**

Run the affected tests, then the full client suite.

Expected: test exit 0 and MSW unhandled request count 0.

### Task 3: Remove React `act()` warnings at their owners

**Files:**

- Modify only test files named by the full-suite warning inventory.
- Production components are modified only if the warning exposes a real lifecycle bug and a failing behavior test proves it.

**Step 1: Verify RED per component**

Run each affected test file through a warning gate that fails on `not wrapped in act(...)`.

Expected: the test file passes but the warning gate fails and names the updating component.

**Step 2: Synchronize the test**

Use `findBy*`, `waitFor`, `userEvent`, explicit `act()` for external store/timer callbacks, or deterministic store setup as appropriate. Do not mock `console.error` to hide the warning.

**Step 3: Verify GREEN per component**

Run the same gate and confirm warning count 0 before moving to the next component.

### Task 4: Preserve runtime contracts while removing router/jsdom warnings

**Files:**

- Modify: `client/tests/helpers/render.tsx`
- Modify: `client/src/App.test.tsx`
- Modify: `client/src/pages/OAuthAuthorizePage.test.tsx`
- Modify: `client/src/pages/oauthAuthorize/useOAuthAuthorize.ts`
- Add: `client/src/pages/oauthAuthorize/browserNavigation.ts`
- Modify: `client/src/components/Collab/CollabNotesFilePreviewPortal.tsx`
- Test: `client/src/components/Collab/CollabNotes.test.tsx`

- Set both MemoryRouter future flags explicitly to `false`: this suppresses the v7 notice while matching production's implicit v6 semantics.
- Keep OAuth fixtures as absolute callback URLs and mock/assert the browser redirect adapter instead of replacing the server contract with hash URLs.
- Render the PDF object without a `data` attribute until `getAuthUrl` resolves, then assert the authenticated URL is attached.

### Task 5: Full verification and integration

**Files:**

- Update this plan with final evidence only if the observed scope differs materially.

**Step 1: Run focused gates**

```bash
npm run typecheck --workspace=client
npm run lint --workspace=client
```

**Step 2: Run the full suites**

```bash
npm run test --workspace=client
npm test
```

Expected: all tests pass; targeted Vitest/MSW/React warning counts are zero. Existing intentional application-error logs and unrelated build/dependency warnings are reported separately rather than suppressed.

**Step 3: Commit and publish to the fork**

```bash
git add client docs/README.md docs/project-source-map.md docs/plans/2026-07-20-client-test-warning-cleanup.md
git commit -m "test: clean up client suite warnings"
git push -u origin chore/client-test-warning-cleanup
```

Create and merge a PR only in `tomtomjskim/TREK` after GitHub Actions succeeds. Do not deploy in this task because no release was requested and the runtime changes are limited to the redirect seam and safe PDF loading state above.

## Final local evidence

- MSW fail-fast RED/GREEN probe: an unhandled request that catches its fetch rejection first exited 0 with `onUnhandledRequest: 'error'` alone, then exited 1 after the `request:unhandled`/`afterEach` gate was added. The temporary probe file was removed.
- Contract-focused tests: `App.test.tsx` and `OAuthAuthorizePage.test.tsx` passed 37/37 with router, navigation and MSW warning counts at 0.
- PDF loading regression: `CollabNotes.test.tsx` passed 57/57 and verifies that the `<object>` has no `data` attribute before token resolution and receives the authenticated URL afterwards.
- Full client: 205 files passed; 3,433 tests passed and 38 skipped. Vitest deprecation, MSW unhandled, React `act()`, router future flag, jsdom navigation and schema-contract warning counts were all 0.
- Shared: 34 files and 141 tests passed.
- Server: 304 files and 5,430 tests passed. The suite exercised fresh and repeated official migrations through schema version 175; no migration files changed.
- `npm run typecheck --workspaces --if-present` and `npm run build` passed.
- Client lint: 0 errors and 1,274 pre-existing warnings. On changed TypeScript paths, `origin/main` and this branch both report 182 warnings and 0 errors, so the branch adds no lint warning.
- `git diff --check` passed. Production build retained the existing plugin-timing, ineffective dynamic-import and large-chunk advisories.
- Independent blocker-first re-review found no HIGH/MED/LOW finding after the three contract fixes and two documentation/test follow-ups were applied.
- No production database, image, Compose service or deployment was changed.
