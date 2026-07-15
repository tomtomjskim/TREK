import { describe, expect, it } from 'vitest';

import { pwaManifest, pwaNavigateFallbackDenylist } from '../../pwa-manifest.js';

describe('PWA install identity', () => {
  it('uses a stable root identity with Korean install metadata', () => {
    expect(pwaManifest).toMatchObject({
      id: '/',
      lang: 'ko',
      scope: '/',
      start_url: '/',
    });
  });

  it('keeps Android release downloads out of the SPA navigation fallback', () => {
    expect(pwaNavigateFallbackDenylist.some((pattern) => pattern.test('/downloads/trek-android.apk'))).toBe(true);
    expect(pwaNavigateFallbackDenylist.some((pattern) => pattern.test('/.well-known/assetlinks.json'))).toBe(true);
  });
});
