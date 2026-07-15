import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ID = "com.jsnetworkcorp.trek";
const HOST = "trek.jsnetworkcorp.com";
const VERSION_NAME = "3.3.0";
const VERSION_CODE = 1;
const GRADLE_DISTRIBUTION_SHA256 =
  "f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6";
const SHA256_FINGERPRINT = /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i;

function readText(projectDir, relativePath, errors) {
  try {
    return fs.readFileSync(path.join(projectDir, relativePath), "utf8");
  } catch {
    errors.push(`missing required file: ${relativePath}`);
    return "";
  }
}

function discoverTrackedPaths(projectDir) {
  const repoDir = path.resolve(projectDir, "../..");
  try {
    return execFileSync(
      "git",
      ["-C", repoDir, "ls-files", "--", "android/twa"],
      {
        encoding: "utf8",
      },
    )
      .split("\n")
      .filter(Boolean)
      .map((entry) => entry.replace(/^android\/twa\//, ""));
  } catch {
    return [];
  }
}

export function verifyProject(
  projectDir,
  trackedPaths = discoverTrackedPaths(projectDir),
) {
  const errors = [];
  const manifestText = readText(projectDir, "twa-manifest.json", errors);
  const assetLinksText = readText(projectDir, "assetlinks.json", errors);
  const gradle = readText(projectDir, "app/build.gradle", errors);
  const androidManifest = readText(
    projectDir,
    "app/src/main/AndroidManifest.xml",
    errors,
  );
  const embeddedWebManifestText = readText(
    projectDir,
    "app/src/main/res/raw/web_app_manifest.json",
    errors,
  );
  const gradleWrapper = readText(
    projectDir,
    "gradle/wrapper/gradle-wrapper.properties",
    errors,
  );

  let manifest;
  let manifestParsed = false;
  try {
    manifest = JSON.parse(manifestText);
    manifestParsed = true;
  } catch {
    errors.push("twa-manifest.json must contain valid JSON");
  }

  const expectedManifest = {
    packageId: PACKAGE_ID,
    host: HOST,
    startUrl: "/",
    appVersion: VERSION_NAME,
    appVersionCode: VERSION_CODE,
    display: "standalone",
    fallbackType: "customtabs",
    enableNotifications: false,
    webManifestUrl: `https://${HOST}/manifest.webmanifest`,
  };
  if (manifestParsed) {
    for (const [field, expected] of Object.entries(expectedManifest)) {
      if (manifest[field] !== expected) {
        errors.push(
          `twa-manifest.json ${field} must be ${JSON.stringify(expected)}`,
        );
      }
    }
    if (manifest.signingKey?.alias !== "trek") {
      errors.push('twa-manifest.json signingKey.alias must be "trek"');
    }
    if (
      !Array.isArray(manifest.fingerprints) ||
      manifest.fingerprints.length === 0 ||
      manifest.fingerprints.some(
        (fingerprint) =>
          typeof fingerprint?.value !== "string" ||
          !SHA256_FINGERPRINT.test(fingerprint.value),
      )
    ) {
      errors.push(
        "twa-manifest.json fingerprints must contain a valid SHA-256 certificate fingerprint",
      );
    }
  }

  try {
    const embeddedWebManifest = JSON.parse(embeddedWebManifestText);
    const embeddedIdentity = {
      id: "/",
      lang: "ko",
      scope: "/",
      start_url: "/",
    };
    for (const [field, expected] of Object.entries(embeddedIdentity)) {
      if (embeddedWebManifest?.[field] !== expected) {
        errors.push(
          `embedded PWA manifest ${field} must be ${JSON.stringify(expected)}`,
        );
      }
    }
  } catch {
    errors.push("embedded PWA manifest must contain valid JSON");
  }

  let assetLinks;
  let assetLinksParsed = false;
  try {
    assetLinks = JSON.parse(assetLinksText);
    assetLinksParsed = true;
  } catch {
    errors.push("assetlinks.json must contain valid JSON");
  }
  if (assetLinksParsed) {
    const releaseFingerprint = manifest?.fingerprints?.find(
      (fingerprint) => fingerprint?.name === "release",
    )?.value;
    const statement = Array.isArray(assetLinks) ? assetLinks[0] : undefined;
    const fingerprints = statement?.target?.sha256_cert_fingerprints;
    if (
      !Array.isArray(assetLinks) ||
      assetLinks.length !== 1 ||
      !Array.isArray(statement?.relation) ||
      statement.relation.length !== 1 ||
      statement.relation[0] !== "delegate_permission/common.handle_all_urls" ||
      statement?.target?.namespace !== "android_app" ||
      statement?.target?.package_name !== PACKAGE_ID ||
      !Array.isArray(fingerprints)
    ) {
      errors.push(
        "assetlinks.json must contain the TREK Android app delegation statement",
      );
    } else if (
      !releaseFingerprint ||
      fingerprints.length !== 1 ||
      fingerprints[0] !== releaseFingerprint
    ) {
      errors.push(
        "assetlinks.json certificate must match the release fingerprint",
      );
    }
  }

  const gradleContracts = [
    ["compileSdkVersion 36", /compileSdkVersion\s+36\b/],
    ["targetSdkVersion 35", /targetSdkVersion\s+35\b/],
    [
      `applicationId "${PACKAGE_ID}"`,
      new RegExp(
        `applicationId\\s+["']${PACKAGE_ID.replaceAll(".", "\\.")}["']`,
      ),
    ],
    [
      `versionCode ${VERSION_CODE}`,
      new RegExp(`versionCode\\s+${VERSION_CODE}\\b`),
    ],
    [
      `versionName "${VERSION_NAME}"`,
      new RegExp(
        `versionName\\s+["']${VERSION_NAME.replaceAll(".", "\\.")}["']`,
      ),
    ],
  ];
  for (const [description, pattern] of gradleContracts) {
    if (!pattern.test(gradle))
      errors.push(`app/build.gradle must contain ${description}`);
  }

  if (!androidManifest.includes(`package="${PACKAGE_ID}"`)) {
    errors.push(`AndroidManifest.xml must declare package ${PACKAGE_ID}`);
  }
  const permissions = [
    ...androidManifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g),
  ].map((match) => match[1]);
  if (permissions.length > 0) {
    errors.push(
      `AndroidManifest.xml must not request runtime permissions: ${permissions.join(", ")}`,
    );
  }

  const gradleChecksums = gradleWrapper
    .split("\n")
    .filter((line) => line.startsWith("distributionSha256Sum="));
  if (
    gradleChecksums.length !== 1 ||
    gradleChecksums[0] !== `distributionSha256Sum=${GRADLE_DISTRIBUTION_SHA256}`
  ) {
    errors.push("Gradle distribution checksum must match the pinned release");
  }

  const prohibitedTrackedPath =
    /(^|\/)(\.gradle|build)(\/|$)|(^|\/)(local\.properties|[^/]+\.(apk|aab|keystore|jks)|[^/]*(password|secret)[^/]*)$/i;
  const prohibited = trackedPaths.filter((entry) =>
    prohibitedTrackedPath.test(entry),
  );
  if (prohibited.length > 0) {
    errors.push(
      `tracked signing material or build output is prohibited: ${prohibited.join(", ")}`,
    );
  }

  return errors;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const projectDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const errors = verifyProject(projectDir);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log("TREK TWA project contract: ok");
  }
}
