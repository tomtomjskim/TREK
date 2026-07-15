#!/usr/bin/env bash

set -Eeuo pipefail

umask 077

readonly SOURCE="${TREK_ANDROID_SOURCE:-/home/ubuntu/projects/TREK/android/twa}"
readonly CACHE_ROOT="${TREK_ANDROID_CACHE_ROOT:-/mnt/oci-block-volume/build-cache/trek-android}"
readonly BUBBLEWRAP_HOME="${TREK_ANDROID_BUBBLEWRAP_HOME:-$CACHE_ROOT/bubblewrap-home}"
readonly GRADLE_HOME="${TREK_ANDROID_GRADLE_HOME:-$CACHE_ROOT/gradle}"
readonly SIGNING_ROOT="${TREK_ANDROID_SIGNING_ROOT:-/mnt/oci-block-volume/services/trek/android-signing}"
readonly RECORD_ROOT="${TREK_ANDROID_RECORD_ROOT:-$CACHE_ROOT/records}"
readonly QEMU="${TREK_ANDROID_QEMU:-$CACHE_ROOT/qemu/root/usr/bin/qemu-x86_64-static}"
readonly QEMU_BINFMT_CONFIG="${TREK_ANDROID_QEMU_BINFMT_CONFIG:-$CACHE_ROOT/qemu/qemu-x86_64-block-volume.conf}"
readonly BINFMT_ROOT="${TREK_ANDROID_BINFMT_ROOT:-/proc/sys/fs/binfmt_misc}"
readonly IMAGE="ghcr.io/googlechromelabs/bubblewrap@sha256:bbe57abc1f6c81ff2a10ac110188b0f0a39bbb82d92146562070f9f7ce52293b"
readonly IMAGE_ID="sha256:bbe57abc1f6c81ff2a10ac110188b0f0a39bbb82d92146562070f9f7ce52293b"
readonly EXPECTED_QEMU_SHA256="${TREK_ANDROID_EXPECTED_QEMU_SHA256:-67c73e1b73f07665f3948ba205b6cd808e5141d8d924d125ccdeb44d6f6d3ff8}"
readonly EXPECTED_BINFMT_SHA256="${TREK_ANDROID_EXPECTED_BINFMT_SHA256:-ea308cc4f5b243426293a8fda5f1a8bfdc4e3a2982dba9bf0310940d27811388}"
readonly EXPECTED_SIGNING_OWNER="${TREK_ANDROID_EXPECTED_SIGNING_OWNER:-1001:1001}"

binfmt_owned=0
controller_lock_fd=

fail() {
  printf 'TREK Android build failed: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage: build-release.sh <action> [record-directory]

actions:
  preflight                    Verify source, SDK, signing, image, and QEMU
  accept-licenses              Accept Android SDK licenses in the persistent cache
  build [record-directory]     Build and verify APK/AAB in a new owner-only record
EOF
}

action=${1:-}
record_argument=${2:-}

# Mutation gates intentionally run before every external command.
case "$action" in
  accept-licenses)
    [ "${TREK_ANDROID_CONFIRM_ACCEPT_LICENSES:-}" = 'accept-trek-android-sdk-licenses' ] || {
      printf '%s\n' 'Refusing accept-licenses. Set TREK_ANDROID_CONFIRM_ACCEPT_LICENSES=accept-trek-android-sdk-licenses' >&2
      exit 1
    }
    ;;
  build)
    [ "${TREK_ANDROID_CONFIRM_BUILD:-}" = 'build-trek-android-release' ] || {
      printf '%s\n' 'Refusing build. Set TREK_ANDROID_CONFIRM_BUILD=build-trek-android-release' >&2
      exit 1
    }
    ;;
  preflight) ;;
  ''|-h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac

require_file() {
  local path=$1 label=$2
  [ -f "$path" ] && [ ! -L "$path" ] || fail "$label is missing or is a symlink"
  [ -s "$path" ] || fail "$label is empty"
}

require_readable_file() {
  local path=$1 label=$2
  [ -e "$path" ] && [ ! -L "$path" ] && [ -r "$path" ] ||
    fail "$label is missing, unreadable, or is a symlink"
}

require_directory() {
  local path=$1 label=$2
  [ -d "$path" ] && [ ! -L "$path" ] || fail "$label is missing or is a symlink"
}

acquire_controller_lock() {
  local lock_path="$CACHE_ROOT/controller.lock"
  require_directory "$CACHE_ROOT" 'Android build cache'
  [ ! -L "$lock_path" ] || fail 'controller lock is a symlink'
  exec {controller_lock_fd}>>"$lock_path"
  chmod 0600 "$lock_path"
  flock -n "$controller_lock_fd" || fail 'controller lock is held by another Android operation'
}

canonical_record() {
  local requested=$1 root_canonical requested_canonical
  root_canonical=$(realpath -m -- "$RECORD_ROOT")
  requested_canonical=$(realpath -m -- "$requested")
  case "$requested_canonical/" in
    "$root_canonical"/*) printf '%s\n' "$requested_canonical" ;;
    *) fail "record directory must be under $root_canonical" ;;
  esac
}

require_source() {
  local path
  require_directory "$SOURCE" 'tracked Android source'
  for path in \
    twa-manifest.json \
    assetlinks.json \
    gradlew \
    gradle/wrapper/gradle-wrapper.jar \
    gradle/wrapper/gradle-wrapper.properties \
    app/build.gradle \
    app/src/main/AndroidManifest.xml \
    scripts/verify-project.mjs \
    scripts/verify-project.test.mjs; do
    require_file "$SOURCE/$path" "Android source $path"
  done
  [ -x "$SOURCE/gradlew" ] || fail 'Gradle wrapper is not executable'
  node --test "$SOURCE/scripts/verify-project.test.mjs" >/dev/null
  node "$SOURCE/scripts/verify-project.mjs" >/dev/null
}

require_qemu() {
  require_file "$QEMU" 'QEMU x86_64 interpreter'
  [ -x "$QEMU" ] || fail 'QEMU x86_64 interpreter is not executable'
  [ "$(sha256sum "$QEMU" | cut -d' ' -f1)" = "$EXPECTED_QEMU_SHA256" ] ||
    fail 'QEMU x86_64 interpreter digest mismatch'
  require_file "$QEMU_BINFMT_CONFIG" 'QEMU binfmt registration'
  [ "$(sha256sum "$QEMU_BINFMT_CONFIG" | cut -d' ' -f1)" = "$EXPECTED_BINFMT_SHA256" ] ||
    fail 'QEMU binfmt registration digest mismatch'
  grep -Fq ':qemu-x86_64:' "$QEMU_BINFMT_CONFIG" || fail 'QEMU binfmt name mismatch'
  grep -Fq ":$QEMU:" "$QEMU_BINFMT_CONFIG" || fail 'QEMU binfmt interpreter mismatch'
  require_directory "$BINFMT_ROOT" 'binfmt filesystem'
  [ -e "$BINFMT_ROOT/register" ] && [ ! -L "$BINFMT_ROOT/register" ] ||
    fail 'binfmt register endpoint is missing or is a symlink'
}

require_sdk_base() {
  require_directory "$CACHE_ROOT" 'Android build cache'
  require_directory "$BUBBLEWRAP_HOME" 'persistent Bubblewrap home'
  require_directory "$GRADLE_HOME" 'persistent Gradle home'
  require_directory "$BUBBLEWRAP_HOME/android_sdk/build-tools/35.0.0" 'Android Build Tools 35.0.0'
  require_directory "$BUBBLEWRAP_HOME/android_sdk/platforms/android-36" 'Android platform 36'
  require_file "$BUBBLEWRAP_HOME/android_sdk/tools/bin/sdkmanager" 'Android sdkmanager'
}

require_sdk() {
  require_sdk_base
  require_file "$BUBBLEWRAP_HOME/android_sdk/licenses/android-sdk-license" 'Android SDK license record'
}

require_signing() {
  local metadata
  require_directory "$SIGNING_ROOT" 'Android signing root'
  metadata=$(stat -Lc '%u:%g:%a' "$SIGNING_ROOT")
  [ "$metadata" = "$EXPECTED_SIGNING_OWNER:700" ] || fail 'Android signing root metadata mismatch'
  for file in trek-release.keystore keystore.password; do
    require_file "$SIGNING_ROOT/$file" "Android signing $file"
    metadata=$(stat -Lc '%u:%g:%a' "$SIGNING_ROOT/$file")
    [ "$metadata" = "$EXPECTED_SIGNING_OWNER:600" ] || fail "Android signing $file metadata mismatch"
  done
}

require_image() {
  [ "$(docker image inspect --format '{{.Architecture}}' "$IMAGE")" = 'amd64' ] ||
    fail 'Bubblewrap build image architecture mismatch'
  [ "$(docker image inspect --format '{{.Id}}' "$IMAGE")" = "$IMAGE_ID" ] ||
    fail 'Bubblewrap build image identity mismatch'
  [ -z "$(docker ps --filter 'name=^/trek-android-build-' --format '{{.Names}}')" ] ||
    fail 'another TREK Android build container is running'
}

preflight() {
  require_source
  require_qemu
  require_sdk
  require_signing
  require_image
}

validate_binfmt_entry() {
  local entry="$BINFMT_ROOT/qemu-x86_64"
  require_readable_file "$entry" 'qemu-x86_64 binfmt entry'
  grep -Fq 'enabled' "$entry" || fail 'qemu-x86_64 binfmt entry is disabled'
  grep -Fq "interpreter $QEMU" "$entry" || fail 'qemu-x86_64 binfmt entry uses another interpreter'
}

register_binfmt() {
  local entry="$BINFMT_ROOT/qemu-x86_64"
  if [ -e "$entry" ] || [ -L "$entry" ]; then
    validate_binfmt_entry
    return
  fi
  sudo -n tee "$BINFMT_ROOT/register" <"$QEMU_BINFMT_CONFIG" >/dev/null ||
    fail 'qemu-x86_64 binfmt registration failed'
  binfmt_owned=1
  validate_binfmt_entry
}

unregister_binfmt() {
  local entry="$BINFMT_ROOT/qemu-x86_64"
  [ "$binfmt_owned" -eq 1 ] || return 0
  printf '%s\n' -1 | sudo -n tee "$entry" >/dev/null || return 1
  binfmt_owned=0
  [ ! -e "$entry" ] && [ ! -L "$entry" ]
}

cleanup_exit() {
  local status=$?
  trap - EXIT
  if ! unregister_binfmt; then
    printf '%s\n' 'TREK Android build failed: temporary binfmt cleanup failed' >&2
    status=1
  fi
  exit "$status"
}

accept_licenses() {
  acquire_controller_lock
  require_source
  require_qemu
  require_sdk_base
  require_signing
  require_image
  trap cleanup_exit EXIT
  register_binfmt
  docker run --rm \
    --name "trek-android-build-licenses-$$" \
    --platform linux/amd64 \
    --mount "type=bind,src=$BUBBLEWRAP_HOME,dst=/root/.bubblewrap" \
    --entrypoint /bin/bash \
    "$IMAGE" \
    -lc 'set -Eu; set +o pipefail; yes | /root/.bubblewrap/android_sdk/tools/bin/sdkmanager --sdk_root=/root/.bubblewrap/android_sdk --licenses; status=${PIPESTATUS[1]}; exit "$status"' ||
    fail 'Android SDK license acceptance failed'
  unregister_binfmt || fail 'temporary binfmt cleanup failed'
  trap - EXIT
  require_sdk
  printf 'trek_android_licenses=pass sdk=%s\n' "$BUBBLEWRAP_HOME/android_sdk"
}

build_container_script=$(cat <<'CONTAINER_SCRIPT'
set -Eeuo pipefail

project=/work/project
output=/work/output
build_tools=/root/.bubblewrap/android_sdk/build-tools/35.0.0

cp -a /source "$project"
printf 'sdk.dir=/root/.bubblewrap/android_sdk\n' > "$project/local.properties"
cd "$project"
./gradlew --no-daemon clean assembleRelease bundleRelease > /work/build.log 2>&1

mkdir -p "$output"
"$build_tools/zipalign" -p -f 4 \
  app/build/outputs/apk/release/app-release-unsigned.apk \
  "$output/app-release-unsigned-aligned.apk"
"$build_tools/apksigner" sign \
  --ks /tmp/trek-release.keystore \
  --ks-key-alias trek \
  --ks-pass file:/tmp/trek-keystore.password \
  --key-pass file:/tmp/trek-key.password \
  --v4-signing-enabled false \
  --out "$output/app-release-signed.apk" \
  "$output/app-release-unsigned-aligned.apk"
cp app/build/outputs/bundle/release/app-release.aab "$output/app-release-bundle.aab"
jarsigner \
  -keystore /tmp/trek-release.keystore \
  -storepass:file /tmp/trek-keystore.password \
  -keypass:file /tmp/trek-key.password \
  "$output/app-release-bundle.aab" trek > /work/jarsigner.log 2>&1

apk_verify=$("$build_tools/apksigner" verify --verbose --print-certs "$output/app-release-signed.apk")
printf '%s\n' "$apk_verify" | grep -Fq 'Verified using v1 scheme (JAR signing): true'
printf '%s\n' "$apk_verify" | grep -Fq 'Verified using v2 scheme (APK Signature Scheme v2): true'
printf '%s\n' "$apk_verify" | grep -Fq 'Verified using v3 scheme (APK Signature Scheme v3): true'
expected_fingerprint=$(grep -Eo '([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}' /source/twa-manifest.json | head -n 1 | tr -d ':' | tr '[:upper:]' '[:lower:]')
actual_fingerprint=$(printf '%s\n' "$apk_verify" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr '[:upper:]' '[:lower:]')
[ -n "$expected_fingerprint" ]
[ "$actual_fingerprint" = "$expected_fingerprint" ]

badging=$("$build_tools/aapt" dump badging "$output/app-release-signed.apk")
printf '%s\n' "$badging" | grep -Fq "package: name='com.jsnetworkcorp.trek' versionCode='1' versionName='3.3.0'"
printf '%s\n' "$badging" | grep -Fq "sdkVersion:'21'"
printf '%s\n' "$badging" | grep -Fq "targetSdkVersion:'35'"
printf '%s\n' "$badging" | grep -Fq "compileSdkVersion='36'"
permissions=$("$build_tools/aapt" dump permissions "$output/app-release-signed.apk")
if printf '%s\n' "$permissions" | grep -Eq "^uses-permission[^:]*: name='android[.]permission[.]"; then
  printf '%s\n' 'APK unexpectedly requests an Android platform permission' >&2
  exit 1
fi

rm -f "$output/app-release-unsigned-aligned.apk" "$output/app-release-signed.apk.idsig"
printf '%s\n' \
  'package=com.jsnetworkcorp.trek' \
  'version_name=3.3.0' \
  'version_code=1' \
  'min_sdk=21' \
  'target_sdk=35' \
  'compile_sdk=36' \
  'android_platform_permissions=none' \
  'apk_signature_v1=pass' \
  'apk_signature_v2=pass' \
  'apk_signature_v3=pass' \
  'certificate_binding=pass' > "$output/verification.txt"
chmod 0600 "$output/app-release-signed.apk" "$output/app-release-bundle.aab" "$output/verification.txt" \
  /work/build.log /work/jarsigner.log
chown -R "$HOST_UID:$HOST_GID" "$output" /work/build.log /work/jarsigner.log
rm -rf -- "$project"
CONTAINER_SCRIPT
)

write_build_record() {
  local record=$1
  local record_tmp="$record/.build.json.tmp"
  jq -n \
    --argjson version 1 \
    --argjson built_at_epoch "$(date +%s)" \
    --arg image_id "$IMAGE_ID" \
    --arg qemu_sha256 "$EXPECTED_QEMU_SHA256" \
    --arg binfmt_sha256 "$EXPECTED_BINFMT_SHA256" \
    --arg manifest_sha256 "$(sha256sum "$SOURCE/twa-manifest.json" | cut -d' ' -f1)" \
    --arg apk_sha256 "$(sha256sum "$record/output/app-release-signed.apk" | cut -d' ' -f1)" \
    --arg aab_sha256 "$(sha256sum "$record/output/app-release-bundle.aab" | cut -d' ' -f1)" \
    '{
      version: $version,
      built_at_epoch: $built_at_epoch,
      image_id: $image_id,
      qemu_sha256: $qemu_sha256,
      binfmt_sha256: $binfmt_sha256,
      manifest_sha256: $manifest_sha256,
      apk_sha256: $apk_sha256,
      aab_sha256: $aab_sha256,
      published: false
    }' >"$record_tmp"
  chmod 0600 "$record_tmp"
  mv -f -- "$record_tmp" "$record/build.json"
}

build_release() {
  local requested record host_uid host_gid file
  acquire_controller_lock
  preflight
  requested=${record_argument:-"$RECORD_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"}
  record=$(canonical_record "$requested")
  [ ! -e "$record" ] && [ ! -L "$record" ] || fail 'build record already exists'
  install -d -m 0700 -- "$RECORD_ROOT" "$record" "$record/output"

  trap cleanup_exit EXIT
  register_binfmt
  host_uid=$(id -u)
  host_gid=$(id -g)
  docker run --rm \
    --name "trek-android-build-$$" \
    --platform linux/amd64 \
    --mount "type=bind,src=$SOURCE,dst=/source,readonly" \
    --mount "type=bind,src=$record,dst=/work" \
    --mount "type=bind,src=$BUBBLEWRAP_HOME,dst=/root/.bubblewrap,readonly" \
    --mount "type=bind,src=$GRADLE_HOME,dst=/root/.gradle" \
    --mount "type=bind,src=$SIGNING_ROOT/trek-release.keystore,dst=/tmp/trek-release.keystore,readonly" \
    --mount "type=bind,src=$SIGNING_ROOT/keystore.password,dst=/tmp/trek-keystore.password,readonly" \
    --mount "type=bind,src=$SIGNING_ROOT/keystore.password,dst=/tmp/trek-key.password,readonly" \
    --env "ANDROID_HOME=/root/.bubblewrap/android_sdk" \
    --env "GRADLE_USER_HOME=/root/.gradle" \
    --env "HOST_UID=$host_uid" \
    --env "HOST_GID=$host_gid" \
    --entrypoint /bin/bash \
    "$IMAGE" -lc "$build_container_script" || fail 'isolated Gradle build or signing verification failed'

  docker run --rm \
    --name "trek-android-build-aab-verify-$$" \
    --platform linux/amd64 \
    --mount "type=bind,src=$record/output,dst=/output,readonly" \
    --entrypoint /bin/bash \
    "$IMAGE" -lc 'exec jarsigner -verify /output/app-release-bundle.aab' \
    >"$record/aab-verify.log" 2>&1 || fail 'isolated AAB signature verification failed'
  grep -Fq 'jar verified.' "$record/aab-verify.log" || fail 'AAB verification evidence is missing'
  chmod 0600 "$record/aab-verify.log"
  printf '%s\n' 'aab_signature=pass' >>"$record/output/verification.txt"
  unregister_binfmt || fail 'temporary binfmt cleanup failed'
  trap - EXIT

  for file in app-release-signed.apk app-release-bundle.aab verification.txt; do
    require_file "$record/output/$file" "build output $file"
    [ "$(stat -Lc '%u:%g:%a' "$record/output/$file")" = "$host_uid:$host_gid:600" ] ||
      fail "build output $file metadata mismatch"
  done
  write_build_record "$record"
  printf 'trek_android_build=pass record=%s published=false\n' "$record"
}

case "$action" in
  preflight)
    preflight
    printf 'trek_android_preflight=pass image=%s sdk=35.0.0 platform=36\n' "$IMAGE_ID"
    ;;
  accept-licenses) accept_licenses ;;
  build) build_release ;;
esac
