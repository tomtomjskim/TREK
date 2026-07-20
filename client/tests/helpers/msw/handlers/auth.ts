import { http, HttpResponse } from 'msw';
import { buildUser, buildAppConfig } from '../../factories';

export const authHandlers = [
  http.post('/api/auth/login', () => {
    const user = buildUser();
    return HttpResponse.json({ user, token: 'mock-token' });
  }),

  http.get('/api/auth/me', () => {
    const user = buildUser();
    return HttpResponse.json({ user });
  }),

  http.post('/api/auth/register', () => {
    const user = buildUser();
    return HttpResponse.json({ user, token: 'mock-token' });
  }),

  http.get('/api/auth/app-config', () => {
    return HttpResponse.json(buildAppConfig());
  }),

  http.post('/api/auth/ws-token', () => {
    return HttpResponse.json({ token: 'mock-ws-token' });
  }),

  http.get('/api/auth/users', () => {
    return HttpResponse.json({ users: [] });
  }),

  http.get('/api/auth/travel-stats', () => {
    return HttpResponse.json({
      countries: [],
      cities: [],
      coords: [],
      totalTrips: 0,
      totalDays: 0,
      totalPlaces: 0,
      totalDistanceKm: 0,
    });
  }),

  http.get('/api/auth/passkey/credentials', () => {
    return HttpResponse.json({ credentials: [] });
  }),

  http.post('/api/auth/logout', () => {
    return HttpResponse.json({ success: true });
  }),
];
