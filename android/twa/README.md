# TREK Android TWA

This directory contains the Android wrapper for `https://trek.jsnetworkcorp.com`.
It is an owned Trusted Web Activity (TWA), not the browser-generated WebAPK that
Samsung Internet creates from **Add to Apps screen**.

## Release identity

- Package: `com.jsnetworkcorp.trek`
- Version: `3.3.0` (`versionCode` 1)
- `compileSdkVersion`: 36
- `targetSdkVersion`: 35
- Signing alias: `trek`
- Digital Asset Links source: `assetlinks.json`

`twa-manifest.json`, `app/build.gradle`, the Android manifest, and
`assetlinks.json` are checked together by:

```bash
node --test android/twa/scripts/verify-project.test.mjs
node android/twa/scripts/verify-project.mjs
```

## Signing material

Production signing material is deliberately outside Git:

```text
/mnt/oci-block-volume/services/trek/android-signing/
├── trek-release.keystore
└── keystore.password
```

The directory must be mode `0700`; both files must be mode `0600`. Never copy
the keystore or password into this directory, a container image, logs, or the
runtime data mounted into TREK. The keystore is required for every future app
update, so keep an independently protected backup outside this block volume.

## Build and publish contract

Bubblewrap CLI is pinned to `1.24.1`. The current ARM64 host keeps Android SDK,
Gradle, and transient build files under:

```text
/mnt/oci-block-volume/build-cache/trek-android/
```

The release outputs are:

```text
app-release-signed.apk
app-release-bundle.aab
```

Run the guarded controller from the repository root. `preflight` is read-only;
license acceptance and release builds require explicit confirmation tokens:

```bash
android/twa/scripts/build-release.sh preflight

TREK_ANDROID_CONFIRM_ACCEPT_LICENSES=accept-trek-android-sdk-licenses \
  android/twa/scripts/build-release.sh accept-licenses

TREK_ANDROID_CONFIRM_BUILD=build-trek-android-release \
  android/twa/scripts/build-release.sh build
```

The controller temporarily registers only the pinned x86_64 QEMU interpreter,
uses the digest-pinned Bubblewrap image as an isolated JDK/Android SDK build
environment, and removes a registration that it created. License and build
actions hold an exclusive lock under the owner-only cache so concurrent jobs
cannot remove each other's host-wide binfmt registration. The controller mounts
only the keystore and password files it needs, each read-only; the one-line
password file is exposed through separate container paths for the keystore and
key password readers. Each build writes to a new mode `0700` record under the
block-volume cache. A successful record has a mode `0600` `build.json` with
`published=false`; publishing is deliberately a separate reviewed operation.

Before publishing, verify all of the following:

1. APK signature schemes v1, v2, and v3 pass.
2. The signing certificate SHA-256 matches `twa-manifest.json` and
   `assetlinks.json`.
3. Package, version, and target SDK are
   `com.jsnetworkcorp.trek`, `3.3.0` / `1`, and `35`.
4. The merged manifest contains no `android.permission.*` request. AndroidX
   adds only the package-local
   `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` with `protectionLevel="signature"`.
5. `jarsigner -verify` accepts the AAB. A self-signed release certificate and
   absence of a timestamp produce expected trust-chain warnings; they do not
   invalidate Android app signing.

The controller disables the optional APK v4 `.idsig` sidecar because the direct
download contract publishes only the signed APK. AAB verification runs in a
separate digest-pinned container and persists its owner-only log in the build
record.

Publish only the signed APK and `assetlinks.json` to the TREK runtime release
directory:

```text
/mnt/oci-block-volume/services/trek/data/android/
├── assetlinks.json
└── trek-android.apk
```

The server exposes those files at:

- `https://trek.jsnetworkcorp.com/.well-known/assetlinks.json`
- `https://trek.jsnetworkcorp.com/downloads/trek-android.apk`

Do not publish the AAB. Keep it as a release input for a future app-store
submission.

## Updating a release

For every Android update, increase `appVersionCode` and normally
`appVersion` in `twa-manifest.json`, regenerate the Bubblewrap project, update
the verifier constants/tests, and rebuild with the same signing key. Changing
the package name, origin, or certificate also requires a coordinated
`assetlinks.json` update.

After deployment, test the APK on a current physical Android device. Confirm
installation, first launch without a Custom Tab address bar, authentication,
trip navigation, map rendering, and an update installed over the previous
version. Installing from the public download URL can still show Android's
unknown-source or Play Protect prompts; those are separate from the obsolete
target-SDK warning this wrapper resolves.
