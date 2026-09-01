import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleApiTransportService } from '../../../src/nest/google-api-usage/google-api-transport.service';

describe('GoogleApiTransportService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GOOG-01: reserves before the provider fetch', async () => {
    const order: string[] = [];
    const usage = { reserve: vi.fn(() => { order.push('reserve'); return {}; }) };
    vi.stubGlobal('fetch', vi.fn(async () => { order.push('fetch'); return new Response('{}', { status: 200 }); }));
    const transport = new GoogleApiTransportService(usage as never);
    await transport.fetch({ url: 'https://places.googleapis.com/v1/places:searchText', sku: 'text_search_enterprise', label: 'test' });
    expect(order).toEqual(['reserve', 'fetch']);
  });

  it('GOOG-01: does not touch network after quota denial', async () => {
    const usage = { reserve: vi.fn(() => { throw new Error('denied'); }) };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const transport = new GoogleApiTransportService(usage as never);
    await expect(transport.fetch({ url: 'https://places.googleapis.com/v1/places:searchText', sku: 'text_search_enterprise', label: 'test' })).rejects.toThrow('denied');
    expect(fetch).not.toHaveBeenCalled();
  });
});
