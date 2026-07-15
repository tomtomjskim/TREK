import { applyAndroidReleaseRoutes } from '../../../src/nest/platform/android-release.routes';

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fingerprint = '78:23:DB:7D:61:7A:1C:E5:62:FD:A9:2B:79:DD:78:60:2A:0F:5F:20:62:DE:3D:30:56:89:B9:6C:B6:DE:56:74';

function assetLinksDocument() {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.jsnetworkcorp.trek',
        sha256_cert_fingerprints: [fingerprint],
      },
    },
  ];
}

describe('Android release routes', () => {
  let releaseDir: string;

  beforeEach(() => {
    releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-android-release-'));
  });

  afterEach(() => {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  });

  function app() {
    const instance = express();
    applyAndroidReleaseRoutes(instance, releaseDir);
    return instance;
  }

  it('serves a valid Digital Asset Links document with a short revalidation policy', async () => {
    fs.writeFileSync(path.join(releaseDir, 'assetlinks.json'), JSON.stringify(assetLinksDocument()));

    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('public, max-age=300, must-revalidate');
    expect(res.body).toEqual(assetLinksDocument());
  });

  it('fails closed when the Digital Asset Links file is missing or invalid', async () => {
    const missing = await request(app()).get('/.well-known/assetlinks.json');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });

    fs.writeFileSync(path.join(releaseDir, 'assetlinks.json'), '{not-json');
    const invalid = await request(app()).get('/.well-known/assetlinks.json');
    expect(invalid.status).toBe(404);
    expect(invalid.body).toEqual({ error: 'not_found' });
  });

  it('rejects an association document for any other package', async () => {
    const document = assetLinksDocument();
    document[0].target.package_name = 'com.example.other';
    fs.writeFileSync(path.join(releaseDir, 'assetlinks.json'), JSON.stringify(document));

    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('rejects an association document signed by any other certificate', async () => {
    const document = assetLinksDocument();
    document[0].target.sha256_cert_fingerprints = [
      '00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
    ];
    fs.writeFileSync(path.join(releaseDir, 'assetlinks.json'), JSON.stringify(document));

    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('rejects an association document that grants any additional relation', async () => {
    const document = assetLinksDocument();
    document[0].relation.push('delegate_permission/common.get_login_creds');
    fs.writeFileSync(path.join(releaseDir, 'assetlinks.json'), JSON.stringify(document));

    const res = await request(app()).get('/.well-known/assetlinks.json');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('serves only the fixed signed APK path with download-safe headers', async () => {
    const apk = Buffer.from('signed-apk-fixture');
    fs.writeFileSync(path.join(releaseDir, 'trek-android.apk'), apk);

    const res = await request(app())
      .get('/downloads/trek-android.apk')
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toBe('attachment; filename="trek-android.apk"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Number(res.headers['content-length'])).toBe(apk.length);
    expect(res.body).toEqual(apk);

    const variablePath = await request(app()).get('/downloads/other.apk');
    expect(variablePath.status).toBe(404);
  });

  it('returns JSON 404 when the APK is absent', async () => {
    const res = await request(app()).get('/downloads/trek-android.apk');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
