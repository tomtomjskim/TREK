import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

const scriptPath = new URL("./build-release.sh", import.meta.url).pathname;
const image =
  "ghcr.io/googlechromelabs/bubblewrap@sha256:bbe57abc1f6c81ff2a10ac110188b0f0a39bbb82d92146562070f9f7ce52293b";

async function executable(path, body) {
  await writeFile(path, `#!/usr/bin/env bash\nset -Eeuo pipefail\n${body}\n`);
  await chmod(path, 0o755);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "trek-android-build-"));
  const bin = join(root, "bin");
  const source = join(root, "source");
  const cache = join(root, "cache");
  const sdk = join(cache, "bubblewrap-home", "android_sdk");
  const signing = join(root, "signing");
  const records = join(root, "records");
  const binfmt = join(root, "binfmt");
  const qemu = join(root, "qemu-x86_64-static");
  const qemuConfig = join(root, "qemu-x86_64.conf");
  const dockerLog = join(root, "docker.args");
  const externalMarker = join(root, "external-called");

  await mkdir(bin);
  await mkdir(join(source, "scripts"), { recursive: true });
  await mkdir(join(source, "gradle", "wrapper"), { recursive: true });
  await mkdir(join(source, "app", "src", "main"), { recursive: true });
  await mkdir(join(sdk, "licenses"), { recursive: true });
  await mkdir(join(sdk, "build-tools", "35.0.0"), { recursive: true });
  await mkdir(join(sdk, "platforms", "android-36"), { recursive: true });
  await mkdir(join(sdk, "tools", "bin"), { recursive: true });
  await mkdir(join(cache, "gradle"), { recursive: true, mode: 0o700 });
  await mkdir(signing, { mode: 0o700 });
  await mkdir(records, { mode: 0o700 });
  await mkdir(binfmt);
  await writeFile(join(binfmt, "register"), "");
  await writeFile(join(source, "twa-manifest.json"), "{}\n");
  await writeFile(join(source, "assetlinks.json"), "[]\n");
  await writeFile(join(source, "app", "build.gradle"), "// fixture\n");
  await writeFile(
    join(source, "app", "src", "main", "AndroidManifest.xml"),
    "<manifest />\n",
  );
  await writeFile(
    join(source, "gradle", "wrapper", "gradle-wrapper.jar"),
    "fixture\n",
  );
  await writeFile(
    join(source, "gradle", "wrapper", "gradle-wrapper.properties"),
    "fixture\n",
  );
  await writeFile(
    join(source, "scripts", "verify-project.mjs"),
    "process.exit(0);\n",
  );
  await writeFile(join(source, "scripts", "verify-project.test.mjs"), "\n");
  await writeFile(join(source, "gradlew"), "#!/bin/sh\nexit 0\n");
  await chmod(join(source, "gradlew"), 0o755);
  await writeFile(
    join(sdk, "licenses", "android-sdk-license"),
    "accepted-fixture\n",
  );
  await writeFile(
    join(sdk, "tools", "bin", "sdkmanager"),
    "#!/bin/sh\nexit 0\n",
  );
  await chmod(join(sdk, "tools", "bin", "sdkmanager"), 0o755);
  await writeFile(
    join(signing, "trek-release.keystore"),
    "fixture-keystore\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(signing, "keystore.password"),
    "super-secret-fixture\n",
    { mode: 0o600 },
  );
  await writeFile(qemu, "fixture qemu\n");
  await chmod(qemu, 0o755);
  await writeFile(qemuConfig, `:qemu-x86_64:M::fixture::${qemu}:OPF\n`);

  await executable(
    join(bin, "sudo"),
    `
if [ "\${1:-}" = -n ]; then shift; fi
if [ "\${1:-}" = tee ]; then
  target=$2
  content=$(cat)
  if [ "$target" = "\${TREK_FAKE_BINFMT_ROOT}/register" ]; then
    if [ "\${TREK_FAKE_BINFMT_INVALID:-0}" = 1 ]; then
      printf '%s\n' disabled > "\${TREK_FAKE_BINFMT_ROOT}/qemu-x86_64"
    else
      cat > "\${TREK_FAKE_BINFMT_ROOT}/qemu-x86_64" <<EOF
enabled
interpreter \${TREK_ANDROID_QEMU}
flags: POF
EOF
    fi
  elif [ "$target" = "\${TREK_FAKE_BINFMT_ROOT}/qemu-x86_64" ] && [ "$content" = -1 ]; then
    rm -f -- "$target"
  else
    printf '%s' "$content" > "$target"
  fi
  exit 0
fi
exec "$@"
`,
  );

  await executable(
    join(bin, "node"),
    `printf called > '${externalMarker}'; exit 0`,
  );
  await executable(
    join(bin, "flock"),
    `
[ "\${TREK_FAKE_LOCK_FAIL:-0}" != 1 ] || exit 1
exit 0
`,
  );
  await executable(
    join(bin, "docker"),
    `
printf called > '${externalMarker}'
case "\${1:-}" in
  image)
    [ "\${2:-}" = inspect ] || exit 2
    case "\${4:-}" in
      *Architecture*) printf '%s\n' amd64 ;;
      *Id*) printf '%s\n' 'sha256:bbe57abc1f6c81ff2a10ac110188b0f0a39bbb82d92146562070f9f7ce52293b' ;;
      *) exit 2 ;;
    esac
    ;;
  ps) exit 0 ;;
  run)
    printf '%s\n' '--- docker run ---' "$@" >> '${dockerLog}'
    [ "\${TREK_FAKE_DOCKER_FAIL:-0}" != 1 ] || exit 42
    case " $* " in
      *trek-android-build-sign-*)
        [ "\${TREK_FAKE_SIGN_FAIL:-0}" != 1 ] || exit 44
        ;;
      *trek-android-build-aab-verify-*)
        [ "\${TREK_FAKE_AAB_VERIFY_FAIL:-0}" != 1 ] || exit 43
        printf '%s\n' 'jar verified.'
        exit 0
        ;;
    esac
    work=
    for arg in "$@"; do
      case "$arg" in
        type=bind,src=*,dst=/work)
          work=\${arg#type=bind,src=}
          work=\${work%,dst=/work}
          ;;
      esac
    done
    [ -n "$work" ] || exit 3
    mkdir -p "$work/output"
    printf 'signed apk fixture\n' > "$work/output/app-release-signed.apk"
    printf 'signed aab fixture\n' > "$work/output/app-release-bundle.aab"
    printf 'package=pass signature=pass\n' > "$work/output/verification.txt"
    ;;
  *) exit 2 ;;
esac
`,
  );

  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    TREK_ANDROID_SOURCE: source,
    TREK_ANDROID_CACHE_ROOT: cache,
    TREK_ANDROID_BUBBLEWRAP_HOME: join(cache, "bubblewrap-home"),
    TREK_ANDROID_GRADLE_HOME: join(cache, "gradle"),
    TREK_ANDROID_SIGNING_ROOT: signing,
    TREK_ANDROID_RECORD_ROOT: records,
    TREK_ANDROID_QEMU: qemu,
    TREK_ANDROID_QEMU_BINFMT_CONFIG: qemuConfig,
    TREK_ANDROID_EXPECTED_QEMU_SHA256: createHash("sha256")
      .update("fixture qemu\n")
      .digest("hex"),
    TREK_ANDROID_EXPECTED_BINFMT_SHA256: createHash("sha256")
      .update(`:qemu-x86_64:M::fixture::${qemu}:OPF\n`)
      .digest("hex"),
    TREK_ANDROID_BINFMT_ROOT: binfmt,
    TREK_ANDROID_EXPECTED_SIGNING_OWNER: `${process.getuid()}:${process.getgid()}`,
    TREK_FAKE_BINFMT_ROOT: binfmt,
  };
  return { root, records, binfmt, dockerLog, externalMarker, env };
}

function run(action, record, env, extra = {}) {
  return spawnSync("bash", [scriptPath, action, record], {
    encoding: "utf8",
    env: { ...env, ...extra },
  });
}

test("controller pins the isolated amd64 Gradle build and secret-safe mounts", async () => {
  const source = await readFile(scriptPath, "utf8");
  const buildRunStart = source.indexOf('--name "trek-android-build-$$"');
  const signingRunStart = source.indexOf('--name "trek-android-build-sign-$$"');
  const aabVerifyRunStart = source.indexOf(
    '--name "trek-android-build-aab-verify-$$"',
  );

  assert.ok(
    buildRunStart >= 0,
    "the unsigned Gradle build container is missing",
  );
  assert.ok(
    signingRunStart > buildRunStart,
    "signing must run after the unsigned Gradle build",
  );
  assert.ok(
    aabVerifyRunStart > signingRunStart,
    "AAB verification must run after signing",
  );

  const unsignedBuildRun = source.slice(buildRunStart, signingRunStart);
  const signingRun = source.slice(signingRunStart, aabVerifyRunStart);
  assert.doesNotMatch(
    unsignedBuildRun,
    /SIGNING_ROOT|trek-release[.]keystore|keystore[.]password/,
    "Gradle must not receive release signing material",
  );
  assert.match(signingRun, /--network none/);
  assert.match(signingRun, /SIGNING_ROOT/);
  assert.match(
    source,
    new RegExp(image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(source, /--platform[= ]linux\/amd64/);
  assert.match(source, /--entrypoint[= ]\/bin\/bash/);
  assert.match(source, /qemu-x86_64-static/);
  assert.match(source, /EXPECTED_BINFMT_SHA256/);
  assert.match(
    source,
    /sdkmanager --sdk_root=\/root\/[.]bubblewrap\/android_sdk --licenses/,
  );
  assert.match(source, /Verified using v1 scheme \(JAR signing\): true/);
  assert.match(source, /--v4-signing-enabled false/);
  assert.match(source, /app-release-signed[.]apk[.]idsig/);
  assert.match(source, /apksigner" verify/);
  assert.match(source, /jarsigner -verify/);
  assert.match(source, /trek-android-build-aab-verify-/);
  assert.match(source, /sdkVersion:'21'/);
  assert.match(source, /compileSdkVersion='36'/);
  assert.match(source, /aapt" dump permissions/);
  assert.match(
    source,
    /\^uses-permission\[\^:\]\*: name='android\[\.\]permission\[\.\]/,
  );
  assert.match(
    source,
    /require_readable_file "\$entry" 'qemu-x86_64 binfmt entry'/,
  );
  assert.match(
    source,
    /src=\$SIGNING_ROOT\/trek-release[.]keystore,dst=\/tmp\/trek-release[.]keystore,readonly/,
  );
  assert.match(
    source,
    /src=\$SIGNING_ROOT\/keystore[.]password,dst=\/tmp\/trek-keystore[.]password,readonly/,
  );
  assert.match(
    source,
    /src=\$SIGNING_ROOT\/keystore[.]password,dst=\/tmp\/trek-key[.]password,readonly/,
  );
  assert.match(source, /--key-pass file:\/tmp\/trek-key[.]password/);
  assert.doesNotMatch(source, /\bbubblewrap (?:build|doctor|update|init)\b/);
  assert.doesNotMatch(
    source,
    /cat .*keystore[.]password|BUBBLEWRAP_KEYSTORE_PASSWORD/,
  );
  assert.doesNotMatch(
    source,
    /--key-pass file:\/tmp\/trek-keystore[.]password/,
    "apksigner must open the one-line password through a second bind path",
  );
});

test("containers retain write access to the owner-only host build record", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.doesNotMatch(
    source,
    /--cap-drop ALL/,
    "container root needs DAC override for the host-UID-owned record mount",
  );
});

for (const [action, variable] of [
  ["accept-licenses", "TREK_ANDROID_CONFIRM_ACCEPT_LICENSES"],
  ["build", "TREK_ANDROID_CONFIRM_BUILD"],
]) {
  test(`${action} refuses before external commands without confirmation`, async () => {
    const f = await fixture();
    try {
      const env = { ...f.env };
      delete env[variable];
      const result = run(action, join(f.records, "change-1"), env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing/);
      await assert.rejects(readFile(f.externalMarker), /ENOENT/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("build confines records to the configured owner-only record root", async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside-record");
    const result = run("build", outside, f.env, {
      TREK_ANDROID_CONFIRM_BUILD: "build-trek-android-release",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /record directory must be under/);
    await assert.rejects(stat(outside), /ENOENT/);
    await assert.rejects(stat(join(f.binfmt, "qemu-x86_64")), /ENOENT/);
    await assert.rejects(readFile(f.dockerLog), /ENOENT/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("build refuses before Docker and QEMU work when the controller lock is held", async () => {
  const f = await fixture();
  try {
    const record = join(f.records, "change-1");
    const result = run("build", record, f.env, {
      TREK_ANDROID_CONFIRM_BUILD: "build-trek-android-release",
      TREK_FAKE_LOCK_FAIL: "1",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /controller lock is held/);
    await assert.rejects(readFile(f.dockerLog), /ENOENT/);
    await assert.rejects(stat(join(f.binfmt, "qemu-x86_64")), /ENOENT/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("build publishes owner-only verified outputs and removes its binfmt registration", async () => {
  const f = await fixture();
  try {
    const record = join(f.records, "change-1");
    const result = run("build", record, f.env, {
      TREK_ANDROID_CONFIRM_BUILD: "build-trek-android-release",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /trek_android_build=pass/);
    for (const name of [
      "app-release-signed.apk",
      "app-release-bundle.aab",
      "verification.txt",
      "build.json",
    ]) {
      const path =
        name === "build.json"
          ? join(record, name)
          : join(record, "output", name);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    assert.equal(
      JSON.parse(await readFile(join(record, "build.json"), "utf8")).published,
      false,
    );
    await assert.rejects(stat(join(f.binfmt, "qemu-x86_64")), /ENOENT/);
    const args = await readFile(f.dockerLog, "utf8");
    assert.match(args, /linux\/amd64/);
    assert.match(args, /\/bin\/bash/);
    assert.match(args, /dst=\/tmp\/trek-release[.]keystore,readonly/);
    assert.match(args, /dst=\/tmp\/trek-keystore[.]password,readonly/);
    assert.match(args, /dst=\/tmp\/trek-key[.]password,readonly/);
    assert.match(args, /trek-android-build-aab-verify-/);
    assert.doesNotMatch(args, /super-secret-fixture/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed build removes its temporary binfmt registration and publishes no success record", async () => {
  const f = await fixture();
  try {
    const record = join(f.records, "change-1");
    const result = run("build", record, f.env, {
      TREK_ANDROID_CONFIRM_BUILD: "build-trek-android-release",
      TREK_FAKE_DOCKER_FAIL: "1",
    });
    assert.notEqual(result.status, 0);
    await assert.rejects(stat(join(f.binfmt, "qemu-x86_64")), /ENOENT/);
    await assert.rejects(readFile(join(record, "build.json")), /ENOENT/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed isolated signing removes binfmt and publishes no success record", async () => {
  const f = await fixture();
  try {
    const record = join(f.records, "change-1");
    const result = run("build", record, f.env, {
      TREK_ANDROID_CONFIRM_BUILD: "build-trek-android-release",
      TREK_FAKE_SIGN_FAIL: "1",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /isolated signing verification failed/);
    await assert.rejects(stat(join(f.binfmt, "qemu-x86_64")), /ENOENT/);
    await assert.rejects(readFile(join(record, "build.json")), /ENOENT/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed isolated AAB verification removes binfmt and publishes no success record", async () => {
  const f = await fixture();
  try {
    const record = join(f.records, "change-1");
    const result = run("build", record, f.env, {
      TREK_ANDROID_CONFIRM_BUILD: "build-trek-android-release",
      TREK_FAKE_AAB_VERIFY_FAIL: "1",
    });
    assert.notEqual(result.status, 0);
    await assert.rejects(stat(join(f.binfmt, "qemu-x86_64")), /ENOENT/);
    await assert.rejects(readFile(join(record, "build.json")), /ENOENT/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("failed binfmt validation removes the entry created by the controller", async () => {
  const f = await fixture();
  try {
    const record = join(f.records, "change-1");
    const result = run("build", record, f.env, {
      TREK_ANDROID_CONFIRM_BUILD: "build-trek-android-release",
      TREK_FAKE_BINFMT_INVALID: "1",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /binfmt entry is disabled/);
    await assert.rejects(stat(join(f.binfmt, "qemu-x86_64")), /ENOENT/);
    await assert.rejects(readFile(join(record, "build.json")), /ENOENT/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
