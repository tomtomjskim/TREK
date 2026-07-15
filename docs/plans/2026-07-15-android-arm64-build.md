# Android ARM64 Build Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Provide a repeatable, secret-safe TREK TWA build on the ARM64 OCI host without executing Bubblewrap Node under QEMU.

**Architecture:** Track the generated Android project in the TREK repository. A confirmation-gated Bash controller validates exact artifacts, creates a record, temporarily registers the pinned QEMU interpreter, and runs Gradle plus Android signing tools from the digest-pinned Bubblewrap image while mounting caches and signing files with least privilege.

**Tech Stack:** Bash, Docker, QEMU user-static, Gradle, Android SDK Build Tools, Node.js test runner

---

### Task 1: Track The Generated Project

**Files:**

- Create: `android/twa/**`
- Create: `android/twa/.gitignore`

**Steps:**

1. Copy only generated source, Gradle wrapper files, public metadata, icons, and
   verifier files from the isolated build cache.
2. Exclude `.gradle`, `build`, APK/AAB/idsig files, local SDK paths, cores,
   keystores, and password files.
3. Run the source verifier and confirm the project contract passes.

### Task 2: Define The Controller Contract With RED Tests

**Files:**

- Create: `android/twa/scripts/build-release.test.mjs`
- Create: `android/twa/scripts/build-release.sh`

**Steps:**

1. Add tests for missing confirmation tokens before external commands.
2. Add tests for exact cache, signing metadata, image digest, QEMU interpreter,
   record confinement, and no Bubblewrap CLI invocation.
3. Add a fake Docker/QEMU flow that proves registration cleanup on success and
   failure and keeps password values out of host arguments.
4. Run the test and confirm RED because the controller does not exist.

### Task 3: Implement Preflight, License, And Build Actions

**Files:**

- Modify: `android/twa/scripts/build-release.sh`

**Steps:**

1. Implement `preflight`, `accept-licenses`, and `build` actions with exact
   confirmation tokens for mutations.
2. Validate source, cache, signing metadata, image architecture, and runtime
   absence before registering binfmt.
3. Acquire the cache-local controller lock, register only the pinned QEMU
   interpreter, and remove only a registration the controller created.
4. Run Gradle, align/sign the APK, sign the AAB, verify both, and publish them
   only into a new owner-only build record.
5. Run focused tests and `bash -n` until GREEN.

### Task 4: Rebuild And Close Out

**Files:**

- Modify: `android/twa/README.md`
- Modify: generated TREK/server operations wiki pages

**Steps:**

1. Run preflight and verify current SDK licenses without modifying production.
2. Execute one isolated build and verify package, SDK, version, signatures, and
   certificate binding.
3. Confirm no build container or temporary binfmt registration remains.
4. Run TREK tests, release registry, HTTP smoke, wiki tests, graph generation,
   validation, and diff checks.
