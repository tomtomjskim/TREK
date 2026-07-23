# Custom Version SemVer Comparison Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop the admin update banner and scheduled admin notification from treating a JSNetworkCorp build of the current official release as outdated, while preserving the full custom version string in the UI and API.

**Architecture:** Keep `APP_VERSION` as the display and API source of truth. Replace the hand-written numeric parser in `adminService` with the server's existing `semver` dependency so SemVer build metadata does not affect precedence; invalid versions compare as unknown/equal and therefore fail closed with no update warning.

**Tech Stack:** TypeScript, Node.js 22, `semver`, Vitest, Docker Compose

---

## Design and scope

### Root cause

`compareVersions()` splits `3.4.1+jsnetworkcorp.e1be01e` on dots and converts every
segment with `Number`. The patch segment becomes `NaN`, and the later `|| 0` fallback
makes the running version compare as if it were `3.4.0`. The official `3.4.1` release
therefore creates a false update banner and can create one deduplicated admin
notification from the daily scheduler.

### Behavior contract

1. `3.4.1` and `3.4.1+jsnetworkcorp.<revision>` have equal update precedence.
2. The API continues to return the complete raw custom version as `current`.
3. Official `3.4.2` remains newer than a custom `3.4.1` build.
4. Prerelease ordering remains SemVer-correct even when the current version has build
   metadata.
5. An invalid build value such as `dev` does not throw or produce an update warning.
6. A same-base custom build does not create the scheduled `version_available`
   notification or change `last_notified_version`.
7. No API shape, client component, database schema, permission, dependency, or provider
   behavior changes.

### Alternatives considered

- **Use `semver.compare` with validation (selected):** reuses an existing production
  dependency, follows SemVer build-metadata precedence, and keeps the change local.
- **Patch the manual parser:** smaller textual diff, but continues a partial SemVer
  implementation and risks prerelease/build edge cases.
- **Strip `+...` in the client:** hides only the banner and leaves the server scheduler's
  false notification unchanged.

### Change lane and retirement

This is a temporary `fork-core` correctness patch with an upstream-compatible server
diff. The official repository remains read-only in this task. Remove the local patch
when a verified official release compares valid SemVer build metadata as equal and
passes equivalent API and notification regressions.

Rollback is `code_only`: restore the previous immutable image. The patch has no
migration or persistent-data write except preventing the erroneous future notification.

## Task 1: Lock the false-positive behavior with RED tests

**Files:**

- Modify: `server/tests/unit/services/adminService.test.ts`
- Modify: `server/tests/unit/services/versionNotification.test.ts`

**Step 1: Add comparator and API regressions**

Add focused cases proving equal base/build metadata precedence, newer patch ordering,
prerelease ordering, invalid-version fail-closed behavior, and preservation of the raw
`current` value from `APP_VERSION`.

**Step 2: Add the scheduler regression**

Set `APP_VERSION=3.4.1+jsnetworkcorp.testrev`, mock official `v3.4.1`, invoke
`checkAndNotifyVersion()`, and assert that neither a notification nor
`last_notified_version` is created.

**Step 3: Verify RED**

Run:

```bash
npm run test --workspace=server -- tests/unit/services/adminService.test.ts tests/unit/services/versionNotification.test.ts
```

Expected: only the equal-build comparator/API/notification cases fail because the
manual parser treats the running patch as zero.

## Task 2: Replace the partial parser with existing SemVer precedence

**Files:**

- Modify: `server/src/services/adminService.ts`

**Step 1: Implement the minimum fix**

Import the existing `semver` package. Validate both inputs and return `0` when either is
invalid; otherwise return `semver.compare(a, b)`. Do not use `compareBuild`, because
build metadata must not make an official release newer or older.

**Step 2: Verify GREEN**

Run the two focused test files again. Expected: all tests pass, including the new
banner/API and scheduled-notification regressions.

**Step 3: Run server checks**

```bash
npm run typecheck --workspace=server
npm run test --workspace=server
git diff --check
```

## Task 3: Record the fork patch and complete repository gates

**Files:**

- Modify: `docs/README.md`
- Modify: `docs/upstream/README.md`

**Step 1: Document ownership and retirement**

Link this plan from the maintainer index and add one patch-inventory row. The source map
does not change because no runtime entry point or ownership boundary moves.

**Step 2: Run the final repository gate**

```bash
npm run typecheck --workspaces --if-present
npm test
npm run i18n:parity:strict --workspace=shared
npm run build
git diff --check
```

Run the existing disposable migration validation used by the v3.4 integration gate;
no migration file is changed. Request an independent read-only review before merging.

## Task 4: Integrate only into the fork and build an immutable image

1. Commit the reviewed source, tests, and project documentation on
   `fix/custom-version-semver`.
2. Push only to `tomtomjskim/TREK`, open a PR against that fork's `main`, wait for
   required CI, and merge without touching `liketrek/TREK`.
3. Fast-forward local `main` and build a native ARM64 image from the exact merged commit
   with `APP_VERSION=3.4.1+jsnetworkcorp.<short-sha>` plus OCI revision/version labels.
4. Smoke the candidate with temporary data/upload filesystems and verify health and the
   exact public app version.

## Task 5: Deploy with backup and rollback evidence

1. Preserve the current image as the immediate `code_only` rollback target.
2. Create and integrity-check an owner-only SQLite online backup even though the patch
   has no migration.
3. Validate the canonical two-file Compose configuration and confirm only the app image
   and semantic `APP_VERSION` change.
4. Recreate the app, wait for `healthy`, and verify restart count, mounts, schema/fork
   migration markers, logs, local/public health, HTTPS redirect, raw version API, and
   unauthenticated admin guard.
5. Record the immutable artifact, rollback target, tests, and production evidence in the
   generated TREK wiki, regenerate graph/meta, and validate without recording secrets.

## Local verification evidence

- RED: four expected regressions failed under the hand-written parser (build metadata
  comparator, invalid-version fail-closed, API same-release result, and scheduled
  notification suppression).
- GREEN: focused service and scheduler suites passed, 90/90 tests.
- Full gate: shared 141/141, server 5,436/5,436, and client 3,441/3,441 runnable tests
  passed (38 client skips); shared/server/client typechecks and strict i18n parity passed.
- Production build completed. Existing non-blocking migration-test duplicate-column
  warnings, an intentional demo-module error-path message, dynamic-import warnings, and
  bundle-size warnings remain unchanged by this patch.
