import { Injectable } from '@nestjs/common';
import { getAppUrl, readEnv } from '../../app-config';
import { GoogleApiUsageService, type GoogleApiSku } from './google-api-usage.service';

const PLACES_UPSTREAM = 'https://places.googleapis.com';

function placesEndpoint(endpoint: string): string {
  const base = readEnv().maps.placesApiBase;
  if (!base || !endpoint.startsWith(PLACES_UPSTREAM)) return endpoint;
  return base.replace(/([^/]|^)\/+$/, '$1') + endpoint.slice(PLACES_UPSTREAM.length);
}

export interface GoogleApiRequest {
  url: string;
  sku: GoogleApiSku;
  label: string;
  init?: RequestInit;
}

@Injectable()
export class GoogleApiTransportService {
  private callCount = 0;

  constructor(private readonly usage: GoogleApiUsageService) {}

  async fetch(request: GoogleApiRequest): Promise<Response> {
    // The reservation is deliberately synchronous and happens before resolving
    // the URL or invoking fetch. A denied call therefore cannot touch network.
    this.usage.reserve(request.sku);
    const endpoint = placesEndpoint(request.url);
    this.callCount += 1;
    console.debug(`[Google API] #${this.callCount} ${request.label} → ${endpoint}`);
    const referer = readEnv().app.appUrl ? getAppUrl() : undefined;
    return fetch(endpoint, {
      ...request.init,
      headers: { ...(referer ? { Referer: referer } : {}), ...((request.init?.headers as Record<string, string>) ?? {}) },
    });
  }
}
