import { http, HttpResponse } from 'msw';

export const addonHandlers = [
  http.get('/api/addons', () => {
    return HttpResponse.json({
      bagTracking: false,
      addons: [
        { id: 'vacay', name: 'Vacay', type: 'feature', icon: 'calendar', enabled: true },
        { id: 'atlas', name: 'Atlas', type: 'feature', icon: 'map', enabled: true },
      ],
    });
  }),

  http.get('/api/atlas-layers', () => {
    return HttpResponse.json({ layers: [] });
  }),

  http.get('/api/addons/atlas/country/:code', () => {
    return HttpResponse.json({ places: [], trips: [], manually_marked: false });
  }),
];
