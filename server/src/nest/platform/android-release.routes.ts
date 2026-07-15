import type express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const ANDROID_PACKAGE_ID = 'com.jsnetworkcorp.trek';
const ANDROID_RELEASE_FINGERPRINT =
  '78:23:DB:7D:61:7A:1C:E5:62:FD:A9:2B:79:DD:78:60:2A:0F:5F:20:62:DE:3D:30:56:89:B9:6C:B6:DE:56:74';
const SHA256_FINGERPRINT = /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/i;

export const DEFAULT_ANDROID_RELEASE_DIR = path.join(__dirname, '../../../data/android');

type AssetLinksStatement = {
  relation?: unknown;
  target?: {
    namespace?: unknown;
    package_name?: unknown;
    sha256_cert_fingerprints?: unknown;
  };
};

function resolveFixedReleaseFile(releaseDir: string, filename: string): string | null {
  try {
    const root = fs.realpathSync(releaseDir);
    const resolved = fs.realpathSync(path.join(root, filename));
    if (path.dirname(resolved) !== root || !fs.statSync(resolved).isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

function isValidAssetLinksDocument(value: unknown): value is AssetLinksStatement[] {
  if (!Array.isArray(value) || value.length !== 1) return false;

  return value.every((statement: AssetLinksStatement) => {
    const relation = statement?.relation;
    const target = statement?.target;
    const fingerprints = target?.sha256_cert_fingerprints;

    return (
      Array.isArray(relation) &&
      relation.length === 1 &&
      relation[0] === 'delegate_permission/common.handle_all_urls' &&
      target?.namespace === 'android_app' &&
      target.package_name === ANDROID_PACKAGE_ID &&
      Array.isArray(fingerprints) &&
      fingerprints.length === 1 &&
      fingerprints.every(
        (fingerprint) =>
          typeof fingerprint === 'string' &&
          SHA256_FINGERPRINT.test(fingerprint) &&
          fingerprint.toUpperCase() === ANDROID_RELEASE_FINGERPRINT,
      )
    );
  });
}

/**
 * Public, fixed-path Android release files.
 *
 * Register before applyPlatformTransport(): its generic /.well-known middleware
 * intentionally terminates unknown association paths.
 */
export function applyAndroidReleaseRoutes(
  app: express.Application,
  releaseDir = process.env.TREK_ANDROID_RELEASE_DIR || DEFAULT_ANDROID_RELEASE_DIR,
): void {
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const file = resolveFixedReleaseFile(releaseDir, 'assetlinks.json');
    if (!file) return res.status(404).json({ error: 'not_found' });

    try {
      const document: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isValidAssetLinksDocument(document)) {
        return res.status(404).json({ error: 'not_found' });
      }

      res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
      return res.json(document);
    } catch {
      return res.status(404).json({ error: 'not_found' });
    }
  });

  app.get('/downloads/trek-android.apk', (_req, res) => {
    const file = resolveFixedReleaseFile(releaseDir, 'trek-android.apk');
    if (!file) return res.status(404).json({ error: 'not_found' });

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="trek-android.apk"');
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.basename(file), { root: path.dirname(file) });
  });
}
