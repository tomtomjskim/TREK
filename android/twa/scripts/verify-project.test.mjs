import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyProject } from "./verify-project.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");

test("the tracked TREK TWA meets the Android release contract", () => {
  assert.deepEqual(verifyProject(projectDir), []);
});

test("the verifier rejects a stale SDK target and tracked signing material", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "trek-twa-verifier-"));
  try {
    fs.mkdirSync(path.join(fixture, "app/src/main"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "twa-manifest.json"),
      JSON.stringify({
        packageId: "com.jsnetworkcorp.trek",
        host: "trek.jsnetworkcorp.com",
        startUrl: "/",
        appVersion: "3.3.0",
        appVersionCode: 1,
      }),
    );
    fs.writeFileSync(
      path.join(fixture, "app/build.gradle"),
      'compileSdkVersion 33\ntargetSdkVersion 33\napplicationId "com.jsnetworkcorp.trek"',
    );
    fs.writeFileSync(
      path.join(fixture, "app/src/main/AndroidManifest.xml"),
      "<manifest />",
    );
    fs.writeFileSync(path.join(fixture, "release.keystore"), "secret");

    const errors = verifyProject(fixture, ["release.keystore"]);

    assert.ok(errors.some((error) => error.includes("compileSdkVersion 36")));
    assert.ok(errors.some((error) => error.includes("targetSdkVersion 35")));
    assert.ok(errors.some((error) => error.includes("signing material")));
    assert.ok(
      errors.some((error) => error.includes("fingerprints must contain")),
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("the verifier rejects Digital Asset Links that do not match the release certificate", () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "trek-twa-assetlinks-"),
  );
  try {
    fs.cpSync(projectDir, fixture, { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "assetlinks.json"),
      JSON.stringify([
        {
          relation: ["delegate_permission/common.handle_all_urls"],
          target: {
            namespace: "android_app",
            package_name: "com.jsnetworkcorp.trek",
            sha256_cert_fingerprints: [
              "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
            ],
          },
        },
      ]),
    );

    const errors = verifyProject(fixture, []);

    assert.ok(
      errors.some((error) =>
        error.includes("must match the release fingerprint"),
      ),
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("the verifier rejects a non-statement Digital Asset Links document", () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "trek-twa-assetlinks-shape-"),
  );
  try {
    fs.cpSync(projectDir, fixture, { recursive: true });
    fs.writeFileSync(path.join(fixture, "assetlinks.json"), "null");

    const errors = verifyProject(fixture, []);

    assert.ok(errors.some((error) => error.includes("delegation statement")));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("the verifier rejects additional Digital Asset Links relations", () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "trek-twa-assetlinks-relation-"),
  );
  try {
    fs.cpSync(projectDir, fixture, { recursive: true });
    const assetLinksPath = path.join(fixture, "assetlinks.json");
    const assetLinks = JSON.parse(fs.readFileSync(assetLinksPath, "utf8"));
    assetLinks[0].relation.push("delegate_permission/common.get_login_creds");
    fs.writeFileSync(assetLinksPath, JSON.stringify(assetLinks));

    const errors = verifyProject(fixture, []);

    assert.ok(errors.some((error) => error.includes("delegation statement")));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("the verifier rejects an unpinned Gradle distribution", () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "trek-twa-gradle-wrapper-"),
  );
  try {
    fs.cpSync(projectDir, fixture, { recursive: true });
    const wrapperPath = path.join(
      fixture,
      "gradle/wrapper/gradle-wrapper.properties",
    );
    fs.appendFileSync(wrapperPath, "\ndistributionSha256Sum=not-the-release\n");

    const errors = verifyProject(fixture, []);

    assert.ok(
      errors.some((error) => error.includes("Gradle distribution checksum")),
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("the verifier rejects stale embedded PWA identity metadata", () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "trek-twa-web-manifest-"),
  );
  try {
    fs.cpSync(projectDir, fixture, { recursive: true });
    const manifestPath = path.join(
      fixture,
      "app/src/main/res/raw/web_app_manifest.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.id;
    manifest.lang = "en";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const errors = verifyProject(fixture, []);

    assert.ok(errors.some((error) => error.includes("embedded PWA manifest")));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
