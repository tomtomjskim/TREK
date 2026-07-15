# Android ARM64 Build Design

## Goal

Make the TREK Trusted Web Activity release reproducible on the ARM64 OCI host
without running Bubblewrap's Node.js CLI under QEMU or exposing signing secrets.

## Root Cause

The pinned official Bubblewrap image is `linux/amd64`, while the host is
`aarch64`. A minimal `npm` invocation in that image segfaults under QEMU, and a
plain container run does not mount the persistent Android SDK. That fresh SDK
path enters an interactive Build Tools license flow and can remain idle after
the license is rejected. The generated Android project itself later completed
Gradle, APK signing, and AAB signing, so project generation and release builds
must be treated as separate concerns.

## Considered Approaches

1. Keep running the Bubblewrap CLI in the official image under QEMU. Rejected:
   Node.js reproducibly segfaults, and first-run dependency setup is interactive.
2. Install a permanent host-wide `qemu-user-static` and binfmt configuration.
   Rejected for now: it expands the host execution surface for one build job and
   adds an operating-system dependency that TREK does not otherwise need.
3. Version the generated Android project and use a guarded build controller.
   Selected: Bubblewrap Node is removed from the ARM64 release path. The
   controller temporarily registers one exact cached QEMU interpreter, bypasses
   the image entrypoint, runs Gradle and Android signing tools, and unregisters
   binfmt on exit when it created the registration.

## Contract

- `android/twa/` contains generated source, the Gradle wrapper, public Digital
  Asset Links metadata, source verification, and no build output or signing
  material.
- The Bubblewrap image is digest-pinned and used only for its reviewed JDK and
  Android tool environment. The controller never invokes `bubblewrap` or Node.
- Android SDK and Gradle caches remain under the OCI build-cache volume.
- SDK license acceptance is a separate confirmation-gated action. Build never
  accepts legal terms implicitly.
- Only the keystore and password files are mounted read-only. The same one-line
  password file is exposed through distinct container paths so keystore and key
  readers get independent streams without putting the value in an argument,
  environment variable, log, Git, or release evidence.
- Mutating actions hold an exclusive cache-local lock for the entire QEMU,
  Docker, signing, and cleanup interval.
- Every build uses a new owner-only record directory. It cannot publish to the
  live TREK runtime or Play Store.
- APK and AAB verification binds package, version, target SDK, signature, and
  certificate fingerprint to the tracked project contract.
- Optional APK v4 signing is disabled; release evidence requires v1/v2/v3 and
  the standalone `.idsig` file is not part of the publish contract.

## Failure And Rollback

On failure, the owner-only record may retain logs and temporary project files
for diagnosis, but it has no `build.json` success record and cannot be treated
as publishable. Any binfmt registration created by the controller is removed.
Completed build records are immutable inputs for a separate reviewed publish
step. Reverting the tracked controller and Android source is sufficient; no
database, runtime container, or production data rollback is involved.

## Evidence

- RED/GREEN tests for confirmation gates, path confinement, QEMU cleanup, and
  secret-safe Docker arguments.
- Source verifier and full TREK tests.
- One isolated build from a clean record with final APK/AAB verification.
- No remaining build container or temporary binfmt registration.
- Release registry and HTTP smoke remain green after the build.
