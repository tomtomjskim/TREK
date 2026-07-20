import { HelpController } from '../../../src/nest/help/help.controller';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const wikiMocks = vi.hoisted(() => ({
  getWikiAsset: vi.fn(),
}));

vi.mock('../../../src/services/wikiService', () => ({
  getWikiIndex: vi.fn(),
  getWikiPage: vi.fn(),
  getWikiAsset: wikiMocks.getWikiAsset,
  isLocalWiki: vi.fn(() => false),
  WikiNotFound: class WikiNotFound extends Error {},
}));

describe('HelpController asset route', () => {
  afterEach(() => vi.clearAllMocks());

  it('uses the Nest 11 named wildcard syntax', () => {
    expect(Reflect.getMetadata(PATH_METADATA, HelpController.prototype.asset)).toBe('asset/*path');
  });

  it('serves a nested wiki asset through the wildcard route', async () => {
    wikiMocks.getWikiAsset.mockResolvedValue({
      buf: Buffer.from('image-bytes'),
      type: 'image/png',
    });
    const moduleRef = await Test.createTestingModule({ controllers: [HelpController] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      await request(app.getHttpServer())
        .get('/api/help/asset/screenshots/nested/image.png')
        .expect(200)
        .expect('Content-Type', /image\/png/)
        .expect('Cache-Control', 'public, max-age=3600')
        .expect(Buffer.from('image-bytes'));
      expect(wikiMocks.getWikiAsset).toHaveBeenCalledWith('screenshots/nested/image.png');
    } finally {
      await app.close();
    }
  });

  it('rejects malformed percent encoding before calling the asset service', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [HelpController] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    try {
      await request(app.getHttpServer()).get('/api/help/asset/%E0%A4%A').expect(400);
      expect(wikiMocks.getWikiAsset).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
