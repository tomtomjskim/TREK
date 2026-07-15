# Android TWA Distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build, sign, publish, and production-verify an API 35 TREK Trusted Web Activity at `com.jsnetworkcorp.trek` while preserving the existing PWA and authentication surface.

**Architecture:** A pinned Bubblewrap Android shell is associated with the canonical TREK origin through Digital Asset Links. TREK serves one fixed association document and one fixed signed APK from its block-volume-backed data directory; the long-lived signing key remains in a separate non-runtime block-volume directory.

**Tech Stack:** React/Vite PWA, TypeScript, Express/NestJS, Vitest/Supertest, Bubblewrap 1.24.1, Gradle, Android SDK 35/36, Docker Compose, OCI block volume.

---

### Task 1: Stabilize PWA install identity

**Files:**

- Create: `client/pwa-manifest.js`
- Create: `client/tests/unit/pwaManifest.test.ts`
- Modify: `client/vite.config.js`

1. Write a failing test for `id: '/'`, `lang: 'ko'`, the canonical scope/start URL, and `/downloads/` navigation-fallback exclusion.
2. Run the focused test and confirm RED.
3. Extract the existing manifest/workbox exclusions into an importable configuration with the new stable identity and exclusion.
4. Run the focused test and client build; verify generated `manifest.webmanifest`.

### Task 2: Add fixed public Android release routes

**Files:**

- Create: `server/src/nest/platform/android-release.routes.ts`
- Create: `server/tests/unit/nest/android-release.routes.test.ts`
- Modify: `server/src/bootstrap.ts`
- Modify: `server/tests/integration/bootstrap.test.ts`

1. Write failing unit tests for the exact public paths, MIME/disposition/cache headers, valid JSON, missing/invalid files, and absence of any variable path.
2. Run the focused test and confirm RED.
3. Implement the smallest fixed-file route helper using `server/data/android` by default and an isolated test override.
4. Add it to bootstrap before `applyPlatformTransport` so the generic well-known middleware cannot intercept Digital Asset Links.
5. Add failing-then-passing bootstrap integration checks for the route contract and preserved unknown-well-known 404 behavior.

### Task 3: Add a reproducible API 35 TWA source project

**Files:**

- Create: `android/twa/**`
- Create: `android/twa/scripts/verify-project.mjs`
- Create: `android/twa/scripts/verify-project.test.mjs`
- Modify: `.gitignore`
- Modify: relevant repository documentation

1. Write a failing verifier test for package ID, host, start URL, version, compile SDK 36, target SDK 35, and prohibited tracked signing/build paths.
2. Run it and confirm RED.
3. Generate the Bubblewrap 1.24.1 project from the live manifest, then make only deterministic configuration adjustments required by the design.
4. Ignore generated APK/AAB outputs, Gradle caches, local SDK settings, keystores, and password files.
5. Run the project verifier and inspect the generated manifest/Gradle diff.

### Task 4: Provision signing and build on OCI block storage

**Operational paths:**

- Signing: `/mnt/oci-block-volume/services/trek/android-signing`
- Tool/cache: `/mnt/oci-block-volume/build-cache/trek-android`
- Runtime release: `/mnt/oci-block-volume/services/trek/data/android`

1. Verify mount, capacity, ownership, and that Docker's data root is block-volume-backed.
2. Create mode-`0700` signing and cache directories, generate password material without terminal output, and generate the release key only if it does not already exist.
3. Confirm keystore/password modes are `0600`; never print their contents.
4. Build the signed APK/AAB with the pinned toolchain and all large caches on the block volume.
5. Verify signing certificate, application ID, version code/name, target SDK, requested permissions, and artifact checksum.
6. Generate Digital Asset Links from the verified public fingerprint and atomically publish the APK/document to the runtime release directory.

### Task 5: Run gates and merge deliberately

**Files:**

- All changed source, tests, plans, and Android project files

1. Run focused tests, server/client typechecks, format checks for changed files, relevant integration tests, and production builds.
2. Run the full shared/server/client suites when focused gates are green.
3. Review the diff for secrets, path traversal, public-route auth intent, OAuth well-known regression, SDK target, update identity, and rollback.
4. Commit coherent changes on `feat/android-twa`, verify the base branch is unchanged, and fast-forward `main` only after all gates pass.

### Task 6: Deploy and verify the public release

**Files:**

- Modify: host-local `docker-compose.override.yml` image tag after build
- Modify: generated TREK deployment/operations wiki documentation

1. Record the current healthy image as the rollback target and confirm there is no DB migration.
2. Build a unique ARM64 TREK image from the merged commit, validate Compose, update the host-local override, and deploy only the TREK app service.
3. Wait for healthy state and verify restart count, bind mounts, logs, HTTP-to-HTTPS redirect, HTTPS health, manifest fields, Digital Asset Links JSON, APK content headers/checksum, and unknown well-known 404.
4. Confirm OAuth discovery and public registration policy are unchanged.
5. Update generated operational knowledge without secrets, regenerate graph/meta, and validate the wiki.
6. Hand off the signed APK URL and a physical-device checklist; record that actual warning removal is unverified until installation on the user's Android device.
